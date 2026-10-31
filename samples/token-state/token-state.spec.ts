// From apps/api/src/tokens/token-state.spec.ts in the private repo. Unchanged.

import { TokenStatus } from '@prisma/client';
import {
  ACTIVE_STATUSES,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  TokenAction,
  allowedActions,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
  transitionEffects,
} from './token-state';

describe('token state machine', () => {
  const NOW = new Date('2026-09-14T09:30:00.000Z');

  describe('the complete transition table', () => {
    /**
     * Every legal (status, action) pair, written out by hand.
     *
     * Deliberately duplicated from the implementation rather than derived from
     * it. A test that reads TRANSITIONS to decide what to assert would pass even
     * if someone made CALLED -> DONE legal, because the expectation would move
     * with the change. Writing the truth independently is what makes this a test
     * rather than a tautology.
     */
    const LEGAL: Array<[TokenStatus, TokenAction, TokenStatus]> = [
      [TokenStatus.WAITING, TokenAction.CALL, TokenStatus.CALLED],
      [TokenStatus.WAITING, TokenAction.CANCEL, TokenStatus.CANCELLED],
      [TokenStatus.CALLED, TokenAction.RECALL, TokenStatus.CALLED],
      [TokenStatus.CALLED, TokenAction.START, TokenStatus.SERVING],
      [TokenStatus.CALLED, TokenAction.SKIP, TokenStatus.WAITING],
      [TokenStatus.CALLED, TokenAction.NO_SHOW, TokenStatus.NO_SHOW],
      [TokenStatus.CALLED, TokenAction.CANCEL, TokenStatus.CANCELLED],
      [TokenStatus.SERVING, TokenAction.DONE, TokenStatus.DONE],
      [TokenStatus.SERVING, TokenAction.NO_SHOW, TokenStatus.NO_SHOW],
    ];

    it.each(LEGAL)('%s --%s--> %s', (from, action, expected) => {
      expect(assertTransition(from, action)).toBe(expected);
      expect(canTransition(from, action)).toBe(true);
    });

    it('rejects every pair not in the legal table', () => {
      const legalKeys = new Set(LEGAL.map(([from, action]) => `${from}:${action}`));

      const rejected: string[] = [];

      for (const from of Object.values(TokenStatus)) {
        for (const action of Object.values(TokenAction)) {
          if (legalKeys.has(`${from}:${action}`)) continue;

          expect(canTransition(from, action)).toBe(false);
          expect(() => assertTransition(from, action)).toThrow(IllegalTransitionError);
          rejected.push(`${from}:${action}`);
        }
      }

      // 6 statuses x 7 actions = 42 pairs, of which 9 are legal.
      expect(rejected).toHaveLength(42 - LEGAL.length);
    });
  });

  describe('terminal statuses', () => {
    it.each(TERMINAL_STATUSES)('%s permits no further action', (status) => {
      expect(isTerminal(status)).toBe(true);
      expect(allowedActions(status)).toEqual([]);
    });

    /**
     * The specific bug this prevents: DONE -> DONE would re-stamp completedAt.
     * The service-time average is computed from completedAt - servedAt, and that
     * average is what every waiting patient's ETA is built on. A double-tap on a
     * tablet would silently inflate one sample and push a wrong number onto
     * strangers' phones.
     */
    it('refuses DONE on an already-DONE token', () => {
      expect(() => assertTransition(TokenStatus.DONE, TokenAction.DONE)).toThrow(
        IllegalTransitionError,
      );
    });

    it('refuses to resurrect a cancelled token', () => {
      expect(() => assertTransition(TokenStatus.CANCELLED, TokenAction.CALL)).toThrow();
    });

    it('refuses to cancel a token already being served', () => {
      // Once the doctor has started, the outcome is DONE or NO_SHOW. "Cancelled"
      // would remove a consultation that actually happened from the day's report.
      expect(() => assertTransition(TokenStatus.SERVING, TokenAction.CANCEL)).toThrow();
    });
  });

  describe('active statuses', () => {
    it.each(ACTIVE_STATUSES)('%s still holds a place in the line', (status) => {
      expect(isActive(status)).toBe(true);
      expect(isTerminal(status)).toBe(false);
      expect(allowedActions(status).length).toBeGreaterThan(0);
    });
  });

  describe('timestamp effects', () => {
    it('CALL stamps calledAt, which ends the wait measurement', () => {
      const effects = transitionEffects(TokenStatus.WAITING, TokenAction.CALL, NOW);

      expect(effects).toEqual({ status: TokenStatus.CALLED, calledAt: NOW });
    });

    it('RECALL bumps calledAt and the recall counter', () => {
      const effects = transitionEffects(TokenStatus.CALLED, TokenAction.RECALL, NOW);

      expect(effects.status).toBe(TokenStatus.CALLED);
      // calledAt is overwritten on purpose: "how long since we called them" is
      // what tells staff when to give up, and that clock restarts per announcement.
      expect(effects.calledAt).toBe(NOW);
      expect(effects.incrementRecall).toBe(true);
    });

    it('START stamps servedAt, which begins the service measurement', () => {
      const effects = transitionEffects(TokenStatus.CALLED, TokenAction.START, NOW);

      expect(effects).toEqual({ status: TokenStatus.SERVING, servedAt: NOW });
    });

    it('DONE stamps completedAt and nothing else', () => {
      const effects = transitionEffects(TokenStatus.SERVING, TokenAction.DONE, NOW);

      expect(effects).toEqual({ status: TokenStatus.DONE, completedAt: NOW });
      // servedAt must NOT be touched, or the service duration collapses to zero.
      expect(effects.servedAt).toBeUndefined();
    });

    it('SKIP returns to WAITING without clearing calledAt', () => {
      const effects = transitionEffects(TokenStatus.CALLED, TokenAction.SKIP, NOW);

      expect(effects.status).toBe(TokenStatus.WAITING);
      // The patient really was called; erasing it would understate their wait.
      expect(effects.calledAt).toBeUndefined();
      expect(effects.completedAt).toBeUndefined();
    });

    it('NO_SHOW and CANCEL stamp completedAt but never servedAt', () => {
      const noShow = transitionEffects(TokenStatus.CALLED, TokenAction.NO_SHOW, NOW);
      const cancel = transitionEffects(TokenStatus.WAITING, TokenAction.CANCEL, NOW);

      expect(noShow).toEqual({ status: TokenStatus.NO_SHOW, completedAt: NOW });
      expect(cancel).toEqual({ status: TokenStatus.CANCELLED, completedAt: NOW });

      // completedAt here marks "left the system", not "was served". Reports read
      // servedAt to tell the difference — so these must never set it.
      expect(noShow.servedAt).toBeUndefined();
      expect(cancel.servedAt).toBeUndefined();
    });

    it('throws before computing effects for an illegal transition', () => {
      expect(() => transitionEffects(TokenStatus.WAITING, TokenAction.DONE, NOW)).toThrow(
        IllegalTransitionError,
      );
    });
  });

  describe('allowedActions drives the console buttons', () => {
    it('offers CALL and CANCEL on a waiting token', () => {
      expect(allowedActions(TokenStatus.WAITING).sort()).toEqual(
        [TokenAction.CALL, TokenAction.CANCEL].sort(),
      );
    });

    it('offers the full counter toolkit on a called token', () => {
      expect(allowedActions(TokenStatus.CALLED).sort()).toEqual(
        [
          TokenAction.RECALL,
          TokenAction.START,
          TokenAction.SKIP,
          TokenAction.NO_SHOW,
          TokenAction.CANCEL,
        ].sort(),
      );
    });

    it('offers only DONE and NO_SHOW once the consultation started', () => {
      expect(allowedActions(TokenStatus.SERVING).sort()).toEqual(
        [TokenAction.DONE, TokenAction.NO_SHOW].sort(),
      );
    });
  });

  describe('error messages are readable by a receptionist', () => {
    it('names the current state and what was expected', () => {
      try {
        assertTransition(TokenStatus.DONE, TokenAction.CALL);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        expect((err as Error).message).toContain('waiting token');
        expect((err as Error).message).toContain('DONE');
      }
    });
  });
});

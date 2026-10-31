// From apps/api/src/tokens/token-state.ts in the private repo. Unchanged.

import { TokenStatus } from '@prisma/client';

/**
 * THE TOKEN STATE MACHINE.
 *
 * This file is the single authority on what may happen to a token. Nothing
 * anywhere else writes `status` without going through `assertTransition`.
 *
 * Why centralise it at all — the argument worth being able to make out loud:
 * the alternative is an `if` in each of six controller methods, and the moment a
 * seventh action is added (say "transfer to another queue") the rules are eight
 * places out of date. Worse, the *illegal* transitions are the interesting ones
 * and they are precisely what scattered `if`s forget. DONE -> DONE looks
 * harmless until you notice it re-stamps `completedAt`, which corrupts the
 * rolling service-time average, which is what the patient's ETA is computed
 * from. A patient sees a wrong number on their phone because a button was
 * double-tapped. One table makes that impossible.
 *
 *   WAITING  --CALL-->    CALLED
 *   CALLED   --START-->   SERVING
 *   CALLED   --RECALL-->  CALLED     (announce again; bumps recallCount/calledAt)
 *   CALLED   --SKIP-->    WAITING    (not at the counter; back in line)
 *   CALLED   --NO_SHOW--> NO_SHOW
 *   SERVING  --DONE-->    DONE
 *   SERVING  --NO_SHOW--> NO_SHOW    (walked away mid-consultation)
 *   WAITING  --CANCEL-->  CANCELLED  (patient cancels from their phone)
 *   CALLED   --CANCEL-->  CANCELLED
 *
 * DONE, NO_SHOW and CANCELLED are terminal.
 */

/** The verbs. Named for what staff press, not for the resulting status. */
export enum TokenAction {
  CALL = 'CALL',
  RECALL = 'RECALL',
  START = 'START',
  DONE = 'DONE',
  SKIP = 'SKIP',
  NO_SHOW = 'NO_SHOW',
  CANCEL = 'CANCEL',
}

interface TransitionRule {
  from: readonly TokenStatus[];
  to: TokenStatus;
  /** Shown to the user when the transition is refused. */
  describe: string;
}

/**
 * The whole rulebook, as data.
 *
 * Data rather than a switch so it can be iterated: the unit tests walk every
 * (status, action) pair and assert the legal set is exactly this, which is a
 * test that cannot drift from the implementation.
 */
export const TRANSITIONS: Readonly<Record<TokenAction, TransitionRule>> = {
  [TokenAction.CALL]: {
    from: [TokenStatus.WAITING],
    to: TokenStatus.CALLED,
    describe: 'Only a waiting token can be called',
  },
  [TokenAction.RECALL]: {
    // Self-transition. Legal on purpose: "announce A-014 again" is a real and
    // frequent action, and modelling it as a no-op would lose the recallCount
    // that tells staff when to give up and mark a no-show.
    from: [TokenStatus.CALLED],
    to: TokenStatus.CALLED,
    describe: 'Only a called token can be recalled',
  },
  [TokenAction.START]: {
    from: [TokenStatus.CALLED],
    to: TokenStatus.SERVING,
    describe: 'Only a called token can be started',
  },
  [TokenAction.DONE]: {
    // SERVING only. A clinic that never presses "Start" would find DONE always
    // rejected — so the service layer offers an implicit START (see
    // TokensService.act), which keeps the model honest while making the console
    // one tap instead of two.
    from: [TokenStatus.SERVING],
    to: TokenStatus.DONE,
    describe: 'Only a token being served can be completed',
  },
  [TokenAction.SKIP]: {
    from: [TokenStatus.CALLED],
    to: TokenStatus.WAITING,
    describe: 'Only a called token can be skipped back into the queue',
  },
  [TokenAction.NO_SHOW]: {
    from: [TokenStatus.CALLED, TokenStatus.SERVING],
    to: TokenStatus.NO_SHOW,
    describe: 'Only a called or in-service token can be marked as a no-show',
  },
  [TokenAction.CANCEL]: {
    // Not from SERVING: once a doctor has started, the outcome is DONE or
    // NO_SHOW. "Cancelled" would silently remove a consultation that happened
    // from the day's report.
    from: [TokenStatus.WAITING, TokenStatus.CALLED],
    to: TokenStatus.CANCELLED,
    describe: 'Only a waiting or called token can be cancelled',
  },
};

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly TokenStatus[] = [
  TokenStatus.DONE,
  TokenStatus.NO_SHOW,
  TokenStatus.CANCELLED,
];

/** Statuses that still occupy a place in the line. */
export const ACTIVE_STATUSES: readonly TokenStatus[] = [
  TokenStatus.WAITING,
  TokenStatus.CALLED,
  TokenStatus.SERVING,
];

export const isTerminal = (status: TokenStatus): boolean => TERMINAL_STATUSES.includes(status);

export const isActive = (status: TokenStatus): boolean => ACTIVE_STATUSES.includes(status);

/** Thrown on an illegal transition. Mapped to HTTP 409 by the service layer. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TokenStatus,
    readonly action: TokenAction,
    readonly to: TokenStatus,
  ) {
    super(`${TRANSITIONS[action].describe} (token is ${from})`);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransition = (from: TokenStatus, action: TokenAction): boolean =>
  TRANSITIONS[action].from.includes(from);

/**
 * Validates a transition and returns the resulting status.
 *
 * Throws rather than returning null: a caller that forgets to check a boolean
 * writes the status anyway, and this is the one place in the system where
 * failing loudly is strictly better than failing quietly.
 */
export const assertTransition = (from: TokenStatus, action: TokenAction): TokenStatus => {
  const rule = TRANSITIONS[action];

  if (!rule.from.includes(from)) {
    throw new IllegalTransitionError(from, action, rule.to);
  }

  return rule.to;
};

/** Every action legal from a status. Used to drive which console buttons enable. */
export const allowedActions = (from: TokenStatus): TokenAction[] =>
  (Object.keys(TRANSITIONS) as TokenAction[]).filter((action) => canTransition(from, action));

/**
 * The timestamp columns an action must stamp.
 *
 * Returned as data rather than applied here so this module stays pure and
 * trivially testable — it never touches Prisma, a clock it did not receive, or
 * the request. `now` is a parameter for the same reason: a test can assert exact
 * values instead of tolerating jitter.
 */
export interface TransitionEffects {
  status: TokenStatus;
  calledAt?: Date;
  servedAt?: Date;
  completedAt?: Date;
  incrementRecall?: boolean;
}

export const transitionEffects = (
  from: TokenStatus,
  action: TokenAction,
  now: Date,
): TransitionEffects => {
  const status = assertTransition(from, action);

  switch (action) {
    case TokenAction.CALL:
      // calledAt is the end of the WAIT measurement: waitSeconds = calledAt -
      // issuedAt. Set once on the first call.
      return { status, calledAt: now };

    case TokenAction.RECALL:
      // Overwrites calledAt on purpose. "How long ago were they called" drives
      // the staff nudge to mark a no-show, and that clock should restart on each
      // announcement. The consequence — a recalled token reports a longer wait —
      // is correct: the patient genuinely waited that long.
      return { status, calledAt: now, incrementRecall: true };

    case TokenAction.START:
      // servedAt starts the SERVICE measurement, which feeds the rolling average
      // the ETA is built on.
      return { status, servedAt: now };

    case TokenAction.DONE:
      return { status, completedAt: now };

    case TokenAction.SKIP:
      // Back to WAITING. calledAt is deliberately NOT cleared: the patient really
      // was called, and erasing it would understate their wait in the report.
      return { status };

    case TokenAction.NO_SHOW:
    case TokenAction.CANCEL:
      // completedAt marks when the token left the system, for retention sweeps
      // and for "how long was it open" — it is not a service completion, and the
      // reports read servedAt to tell the difference.
      return { status, completedAt: now };
  }
};

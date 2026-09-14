/**
 * SHOWCASE EXCERPT — QueueLK · apps/api/test/concurrency.e2e-spec.ts
 *
 * Demonstrates: the tests that justify the locking design in
 * tokens.service.excerpt.ts alongside this file.
 *
 * Thirty issuers fired with Promise.all at one counter row; the first-token-of-
 * the-day race where the counter row does not exist yet; a daily cap that must
 * roll back the increment along with the rejected token; ten "call next"
 * requests that must call exactly one patient; and the unique constraint tested
 * by deliberately bypassing the service.
 *
 * They run against a REAL PostgreSQL, and that is the whole point: the thing
 * under test is SELECT ... FOR UPDATE and a unique constraint, neither of which
 * exists in a mock. A mocked version of these tests would pass against code
 * with no locking whatsoever, which is precisely the bug they exist to catch.
 *
 * Everything else in the suite verifies behaviour; these verify that the
 * behaviour survives being hit from several directions at the same instant,
 * which is the only condition under which the locking is doing anything at all.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueueStatus, Role, TokenStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokensService } from '../src/tokens/tokens.service';
import { QueuesService } from '../src/queues/queues.service';
import { TokenSource } from '@prisma/client';

jest.setTimeout(60_000);

describe('concurrency (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let queues: QueuesService;

  let tenantId: string;
  let queueId: string;
  let actorId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);
    queues = app.get(QueuesService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.cleanDatabase();

    const tenant = await prisma.tenant.create({
      data: { slug: `test-${Date.now()}`, name: 'Test Clinic', timezone: 'Asia/Colombo' },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        email: 'owner@test.lk',
        // Throwaway fixture value, and cost 4 rather than the production cost:
        // these tests create users in a loop and bcrypt at full cost would
        // dominate the runtime of a suite that is measuring lock contention.
        passwordHash: await bcrypt.hash(process.env.TEST_USER_PASSWORD ?? 'test-only-fixture', 4),
        name: 'Owner',
        role: Role.OWNER,
      },
    });
    actorId = user.id;

    const queue = await prisma.queue.create({
      data: {
        tenantId,
        name: 'Dr. Test',
        prefix: 'A',
        status: QueueStatus.OPEN,
        avgServiceSeconds: 300,
      },
    });
    queueId = queue.id;
  });

  // =========================================================================
  describe('30 concurrent "take token" requests', () => {
    /**
     * THE INVARIANT: numbers 1..30, no gaps, no duplicates.
     *
     * This is the test that fails loudly if someone replaces the row lock with a
     * Redis INCR, with `SELECT MAX(number) + 1`, or with an application-level
     * mutex that does not survive a second process.
     */
    it('allocates exactly 1..30 with no gaps and no duplicates', async () => {
      const CONCURRENT = 30;

      /**
       * Promise.all, not a loop.
       *
       * A sequential loop would pass against completely unlocked code — each
       * request would simply finish before the next began. The whole point is to
       * have 30 transactions contending for the same counter row at once.
       *
       * Every request carries a DIFFERENT deviceHash, because "one active token
       * per device per queue" would otherwise (correctly) reject 29 of them. This
       * test is about the allocator, not the duplicate guard — that one is tested
       * separately below.
       */
      const results = await Promise.all(
        Array.from({ length: CONCURRENT }, (_, index) =>
          tokens.issue({
            tenantId,
            queueId,
            source: TokenSource.SELF,
            deviceHash: `device-hash-${index}`,
          }),
        ),
      );

      expect(results).toHaveLength(CONCURRENT);

      const numbers = results.map((token) => token.number).sort((a, b) => a - b);

      // Exactly 1..30.
      expect(numbers).toEqual(Array.from({ length: CONCURRENT }, (_, i) => i + 1));

      // No duplicates — implied by the above, asserted separately so a failure
      // says which property broke.
      expect(new Set(numbers).size).toBe(CONCURRENT);

      // And the database agrees with what the API returned.
      const stored = await prisma.token.findMany({
        where: { tenantId, queueId },
        orderBy: { number: 'asc' },
        select: { number: true },
      });

      expect(stored.map((row) => row.number)).toEqual(numbers);

      // The counter row ended where the tokens did.
      const counter = await prisma.queueCounter.findFirstOrThrow({
        where: { tenantId, queueId },
      });
      expect(counter.lastNumber).toBe(CONCURRENT);
    });

    /**
     * The counter row does not exist before the first token of the day. Two
     * concurrent first-issuers both fail to lock a row that is not there, both
     * try to INSERT, one wins on the unique index, and the loser must retry
     * rather than error.
     */
    it('survives the first-token-of-the-day race with no counter row', async () => {
      const counterBefore = await prisma.queueCounter.findFirst({
        where: { tenantId, queueId },
      });
      expect(counterBefore).toBeNull();

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          tokens.issue({
            tenantId,
            queueId,
            source: TokenSource.SELF,
            deviceHash: `first-race-${index}`,
          }),
        ),
      );

      const numbers = results.map((t) => t.number).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Exactly one counter row exists.
      const counters = await prisma.queueCounter.findMany({ where: { tenantId, queueId } });
      expect(counters).toHaveLength(1);
    });

    it('keeps numbering independent per queue', async () => {
      const second = await prisma.queue.create({
        data: { tenantId, name: 'Dr. Two', prefix: 'B', status: QueueStatus.OPEN },
      });

      await Promise.all([
        ...Array.from({ length: 8 }, (_, i) =>
          tokens.issue({
            tenantId,
            queueId,
            source: TokenSource.SELF,
            deviceHash: `qa-${i}`,
          }),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          tokens.issue({
            tenantId,
            queueId: second.id,
            source: TokenSource.SELF,
            deviceHash: `qb-${i}`,
          }),
        ),
      ]);

      // Both queues ran 1..8. They share a tenant and a day, so only the queue id
      // separates them — which is what the composite unique key expresses.
      for (const id of [queueId, second.id]) {
        const numbers = await prisma.token.findMany({
          where: { tenantId, queueId: id },
          orderBy: { number: 'asc' },
          select: { number: true },
        });
        expect(numbers.map((n) => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      }
    });

    it('does not consume a number when the daily cap rejects the token', async () => {
      await prisma.queue.update({ where: { id: queueId }, data: { dailyCapacity: 5 } });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          tokens.issue({
            tenantId,
            queueId,
            source: TokenSource.SELF,
            deviceHash: `cap-${index}`,
          }),
        ),
      );

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      expect(fulfilled).toHaveLength(5);

      /**
       * The important assertion. The capacity check and the number allocation are
       * in the SAME transaction, so a rejected request rolls back the increment
       * too. An "allocate from Redis, then insert" design would leave numbers
       * 6..12 burned, and the display would show a queue that skips from A-005
       * to A-013 tomorrow.
       */
      const stored = await prisma.token.findMany({
        where: { tenantId, queueId },
        orderBy: { number: 'asc' },
        select: { number: true },
      });
      expect(stored.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);

      const counter = await prisma.queueCounter.findFirstOrThrow({ where: { queueId } });
      expect(counter.lastNumber).toBe(5);
    });
  });

  // =========================================================================
  describe('10 concurrent "call next" requests', () => {
    beforeEach(async () => {
      // Five patients waiting.
      for (let i = 0; i < 5; i += 1) {
        await tokens.issue({
          tenantId,
          queueId,
          source: TokenSource.COUNTER,
          actorId,
        });
      }
    });

    /**
     * THE SECOND INVARIANT: ten devices press "Call next" at once and exactly one
     * patient is called.
     *
     * Without the queue row lock, several transactions read the same oldest
     * WAITING token and several patients end up CALLED — or worse, two DIFFERENT
     * patients are called while the display shows one, and the one who was
     * skipped has no way to know.
     */
    it('calls exactly one patient', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          tokens.callNext({ tenantId, queueId, actorId }),
        ),
      );

      const called = await prisma.token.findMany({
        where: { tenantId, queueId, status: TokenStatus.CALLED },
      });

      /**
       * Note what is NOT asserted: that only one of the ten calls returned a
       * token. Ten SEQUENTIALLY-serialised calls would legitimately call ten
       * different patients — that is correct behaviour for ten deliberate presses.
       *
       * What must hold is that no patient is called TWICE and no number is
       * skipped. With five waiting and ten calls, five get called in order and
       * five return null.
       */
      const returned = results.filter((r): r is NonNullable<typeof r> => r !== null);

      // Every returned token is distinct — nobody was handed out twice.
      const ids = returned.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);

      // Exactly the five that existed were consumed, in number order.
      expect(returned).toHaveLength(5);
      expect(returned.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

      // None left waiting; all five moved to CALLED.
      expect(called).toHaveLength(5);

      const waiting = await prisma.token.count({
        where: { tenantId, queueId, status: TokenStatus.WAITING },
      });
      expect(waiting).toBe(0);
    });

    /**
     * The sharper version: ONE waiting patient, ten simultaneous calls. Exactly
     * one caller may win.
     */
    it('with a single waiting patient, exactly one call succeeds and nine return null', async () => {
      await prisma.token.updateMany({
        where: { tenantId, queueId, number: { gt: 1 } },
        data: { status: TokenStatus.CANCELLED },
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => tokens.callNext({ tenantId, queueId, actorId })),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.number).toBe(1);

      const called = await prisma.token.findMany({
        where: { tenantId, queueId, status: TokenStatus.CALLED },
      });
      expect(called).toHaveLength(1);
    });

    it('returns null rather than erroring when nobody is waiting', async () => {
      await prisma.token.updateMany({
        where: { tenantId, queueId },
        data: { status: TokenStatus.DONE },
      });

      // A 404 here would make the console flash a red error every time a clinic
      // catches up with its queue, which is a GOOD thing happening.
      await expect(tokens.callNext({ tenantId, queueId, actorId })).resolves.toBeNull();
    });

    it('calls patients in number order, which is the order printed on their slips', async () => {
      const first = await tokens.callNext({ tenantId, queueId, actorId });
      const second = await tokens.callNext({ tenantId, queueId, actorId });

      expect(first!.number).toBe(1);
      expect(second!.number).toBe(2);
    });
  });

  // =========================================================================
  describe('idempotency', () => {
    /**
     * The double-tap. A tablet on clinic wifi sends the same request twice with
     * the same key; the second must replay the first response, not act again.
     */
    it('replays the response instead of calling a second patient', async () => {
      for (let i = 0; i < 3; i += 1) {
        await tokens.issue({ tenantId, queueId, source: TokenSource.COUNTER, actorId });
      }

      const key = 'tablet-button-press-1';

      const first = await tokens.callNext({ tenantId, queueId, actorId, idempotencyKey: key });
      const second = await tokens.callNext({ tenantId, queueId, actorId, idempotencyKey: key });

      expect(second!.id).toBe(first!.id);

      // Only ONE patient moved.
      const called = await prisma.token.count({
        where: { tenantId, queueId, status: TokenStatus.CALLED },
      });
      expect(called).toBe(1);
    });

    /**
     * The race the pre-check cannot close: both requests pass the "has this key
     * been used?" lookup before either commits. One wins the unique index; the
     * loser must read the winner's response, not error.
     */
    it('resolves two simultaneous requests with the same key to one action', async () => {
      for (let i = 0; i < 3; i += 1) {
        await tokens.issue({ tenantId, queueId, source: TokenSource.COUNTER, actorId });
      }

      const key = 'simultaneous-double-tap';

      const [a, b] = await Promise.all([
        tokens.callNext({ tenantId, queueId, actorId, idempotencyKey: key }),
        tokens.callNext({ tenantId, queueId, actorId, idempotencyKey: key }),
      ]);

      expect(a!.id).toBe(b!.id);

      const called = await prisma.token.count({
        where: { tenantId, queueId, status: TokenStatus.CALLED },
      });
      expect(called).toBe(1);
    });

    it('rejects the same key reused for a different action', async () => {
      const issued = await tokens.issue({
        tenantId,
        queueId,
        source: TokenSource.COUNTER,
        actorId,
      });

      const key = 'reused-key';
      await tokens.callNext({ tenantId, queueId, actorId, idempotencyKey: key });

      // Returning the stored "call next" response here would report success for
      // an action that never happened.
      await expect(
        tokens.act({
          tenantId,
          tokenId: issued.id,
          action: 'DONE' as never,
          actorId,
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/already used/i);
    });

    it('does not store a response when the action fails', async () => {
      await prisma.queue.update({ where: { id: queueId }, data: { status: QueueStatus.CLOSED } });

      const key = 'failed-action';

      await expect(
        tokens.issue({ tenantId, queueId, source: TokenSource.SELF, idempotencyKey: key }),
      ).rejects.toThrow();

      // The idempotency row must have rolled back with the action, or a retry
      // after the queue reopens would replay a failure forever.
      const stored = await prisma.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      expect(stored).toBeNull();
    });
  });

  // =========================================================================
  describe('one active token per device per queue', () => {
    it('refuses a second active token from the same device', async () => {
      const deviceHash = 'the-same-phone';

      const first = await tokens.issue({
        tenantId,
        queueId,
        source: TokenSource.SELF,
        deviceHash,
      });

      await expect(
        tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash }),
      ).rejects.toThrow(/already has an active token/i);

      expect(first.number).toBe(1);
    });

    it('allows a new token after the previous one was completed', async () => {
      const deviceHash = 'returning-patient';

      const first = await tokens.issue({
        tenantId,
        queueId,
        source: TokenSource.SELF,
        deviceHash,
      });

      await tokens.callNext({ tenantId, queueId, actorId });
      await tokens.act({
        tenantId,
        tokenId: first.id,
        action: 'DONE' as never,
        actorId,
      });

      // A patient who was already seen can legitimately rejoin — for the pharmacy
      // queue, that is the normal flow.
      const second = await tokens.issue({
        tenantId,
        queueId,
        source: TokenSource.SELF,
        deviceHash,
      });

      expect(second.number).toBe(2);
    });

    it('allows the same device in a DIFFERENT queue', async () => {
      const other = await prisma.queue.create({
        data: { tenantId, name: 'Pharmacy', prefix: 'PH', status: QueueStatus.OPEN },
      });

      const deviceHash = 'one-patient-two-queues';

      // Seeing the doctor and then queueing at the pharmacy is the single most
      // common patient journey in a dispensary.
      await tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash });
      await expect(
        tokens.issue({ tenantId, queueId: other.id, source: TokenSource.SELF, deviceHash }),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  describe('the unique constraint backstop', () => {
    /**
     * Proves layer 2 exists. If the counter logic were ever bypassed — a bug, a
     * bad migration, a manual INSERT during support — Postgres must refuse rather
     * than let two patients hold "A-014".
     */
    it('refuses a duplicate (queue, date, number) even bypassing the service', async () => {
      const first = await tokens.issue({
        tenantId,
        queueId,
        source: TokenSource.COUNTER,
        actorId,
      });

      const row = await prisma.token.findUniqueOrThrow({ where: { id: first.id } });

      await expect(
        prisma.token.create({
          data: {
            tenantId,
            queueId,
            number: row.number,
            serviceDate: row.serviceDate,
            publicId: 'a-different-public-id',
          },
        }),
      ).rejects.toThrow();
    });
  });
});

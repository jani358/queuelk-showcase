// Excerpt from apps/api/test/concurrency.e2e-spec.ts in the private repo.
// These run against a real Postgres 16 (no mocks: the thing under test is the
// lock). The setup that creates the tenant, queue and services is cut.
// Full suite: 25 concurrency tests, 113 integration tests in total.

  describe('issuing and calling use different locks', () => {
    /**
     * Holds a row lock in a separate transaction until `release` is called, so a
     * test can see whether an issue or a call waits for it.
     */
    async function holdLock(sql: (tx: Prisma.TransactionClient) => Promise<unknown>) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const done = prisma.$transaction(
        async (tx) => {
          await sql(tx);
          locked();
          await released;
        },
        { timeout: 20_000 },
      );

      await isLocked;
      return { release, done };
    }

    const within = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([
        promise.then(() => 'finished' as const),
        new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms)),
      ]);

    /**
     * The k6 morning rush (docs/LOAD-TEST-REPORT.md) showed patients queueing
     * behind counters because both took the queue row lock. Issuing now
     * serialises on the queue_counters row only (ADR 0007).
     */
    it('takes a number while a counter holds the queue row lock', async () => {
      // Exactly the lock "call next" holds. The token INSERT checks its foreign
      // key to queues with FOR KEY SHARE, so this only passes if that lock does
      // not conflict with it.
      const lock = await holdLock((tx) => lockQueueForCounterAction(tx, tenantId, queueId));

      const issued = tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: 'd-1' });
      const outcome = await within(issued, 2_000);

      lock.release();
      await lock.done;

      expect(outcome).toBe('finished');
      await expect(issued).resolves.toMatchObject({ number: 1 });
    });

    it('still makes issuers wait for each other on the counter row', async () => {
      await tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: 'd-0' });

      const lock = await holdLock(
        (tx) => tx.$queryRaw`SELECT id FROM queue_counters WHERE "queueId" = ${queueId} FOR UPDATE`,
      );

      const issued = tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: 'd-1' });
      const outcome = await within(issued, 500);

      lock.release();
      await lock.done;

      expect(outcome).toBe('still waiting');
      await expect(issued).resolves.toMatchObject({ number: 2 });
    });

    it('calls next while patients are taking numbers, with no gaps and nobody called twice', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: `pre-${i}` }),
        ),
      );

      const results = await Promise.all([
        ...Array.from({ length: 25 }, (_, i) =>
          tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: `mix-${i}` }),
        ),
        ...Array.from({ length: 15 }, () => tokens.callNext({ tenantId, queueId, actorId })),
      ]);

      const called = results.slice(25).filter((view) => view !== null).map((view) => view!.number);
      expect(new Set(called).size).toBe(called.length);
      expect(called.length).toBeGreaterThan(0);

      const all = await prisma.token.findMany({
        where: { tenantId, queueId },
        orderBy: { number: 'asc' },
        select: { number: true, status: true },
      });
      expect(all.map((t) => t.number)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(all.filter((t) => t.status === TokenStatus.CALLED)).toHaveLength(called.length);
    });

    it('refuses a queue from another tenant without touching its counter', async () => {
      await tokens.issue({ tenantId, queueId, source: TokenSource.SELF, deviceHash: 'mine' });

      const other = await prisma.tenant.create({
        data: { slug: `other-${Date.now()}`, name: 'Other', timezone: 'Asia/Colombo' },
      });

      await expect(
        tokens.issue({ tenantId: other.id, queueId, source: TokenSource.SELF, deviceHash: 'x' }),
      ).rejects.toThrow('Queue not found');

      const counters = await prisma.queueCounter.findMany({ where: { queueId } });
      expect(counters).toHaveLength(1);
      expect(counters[0]).toMatchObject({ tenantId, lastNumber: 1 });
    });
  });

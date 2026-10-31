// Excerpt from apps/api/src/tokens/tokens.service.ts in the private repo.
// Trimmed: the audit row, the view builder, the broadcast and analytics hooks
// and the other token actions are cut. The locking and the checks are as-is.

/**
 * Issue a token. For a given (queue, service day) the numbers are exactly 1..N,
 * no gaps and no duplicates, however many patients scan at once.
 *
 *   1. A row lock on queue_counters (queueId, serviceDate), taken by one
 *      INSERT ... ON CONFLICT DO UPDATE. Issuers queue on that row. It is the
 *      only lock issuing takes, so patients never wait for a counter (ADR 0007).
 *   2. UNIQUE (queueId, serviceDate, number) on tokens, as the backstop.
 *   3. The device and capacity checks run in the same transaction, so a
 *      rejected token rolls its number back with it.
 *
 * Not a Postgres sequence: nextval() is not rolled back, so a rejected issue
 * would leave a gap on the display.
 */
async issue(input: IssueTokenInput): Promise<TokenView> {
  const { tenantId, queueId } = input;

  return this.idempotency.run(
    {
      tenantId,
      key: input.idempotencyKey,
      endpoint: `POST /queues/${queueId}/tokens`,
      body: { queueId, source: input.source, patientName: input.patientName ?? null, deviceHash: input.deviceHash ?? null },
    },
    async (tx) => {
      // No lock on the queue row here. "Call next" uses that one.
      const queue = await tx.queue.findFirst({ where: { id: queueId, tenantId } });
      if (!queue) throw new NotFoundException('Queue not found');
      if (queue.status !== QueueStatus.OPEN) throw new ConflictException('This queue is not issuing tokens.');

      const on = await this.serviceDateFor(tx, tenantId);

      // Claim the number first. From here to commit we hold the counter row,
      // so the checks below run one issuer at a time.
      const number = await this.allocateNumber(tx, tenantId, queueId, on);

      // One active token per device per queue. Checked here and not only in the
      // Redis rate limiter, because that one fails open when Redis is down.
      if (input.deviceHash) {
        const existing = await tx.token.findFirst({
          where: { tenantId, queueId, serviceDate: on, deviceHash: input.deviceHash, status: { in: [...ACTIVE_STATUSES] } },
        });
        if (existing) {
          throw new ConflictException({ error: 'AlreadyHasToken', publicId: existing.publicId });
        }
      }

      if (queue.dailyCapacity !== null) {
        const issued = await tx.token.count({
          where: { tenantId, queueId, serviceDate: on, status: { not: TokenStatus.CANCELLED } },
        });
        if (issued >= queue.dailyCapacity) {
          throw new ConflictException('This queue is full for today.');
        }
      }

      const token = await tx.token.create({
        data: { tenantId, queueId, number, serviceDate: on, status: TokenStatus.WAITING, source: input.source, publicId: this.generatePublicId() },
      });

      return this.buildView(tx, token, queue);
    },
  );
}

/**
 * Read, increment and write the counter in one statement. Must run inside a
 * transaction, or the row lock is released straight away.
 *
 * The first token of the day inserts the row with 1. Two first issuers at once
 * are sorted out by the unique index: the second waits, then takes the UPDATE
 * path. (The old version did SELECT ... FOR UPDATE and had to catch P2002 and
 * retry, because you can't lock a row that doesn't exist yet.)
 */
private async allocateNumber(tx: Prisma.TransactionClient, tenantId: string, queueId: string, on: Date): Promise<number> {
  const day = on.toISOString().slice(0, 10);

  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO queue_counters (id, "tenantId", "queueId", service_date, last_number, "updatedAt")
    VALUES (gen_random_uuid()::text, ${tenantId}, ${queueId}, ${day}::date, 1, NOW())
    ON CONFLICT ("queueId", service_date)
    DO UPDATE SET last_number = queue_counters.last_number + 1, "updatedAt" = NOW()
     WHERE queue_counters."tenantId" = EXCLUDED."tenantId"
    RETURNING last_number
  `;

  // Empty only if the counter row belongs to another tenant.
  if (rows.length === 0) throw new NotFoundException('Queue not found');
  return rows[0].last_number;
}

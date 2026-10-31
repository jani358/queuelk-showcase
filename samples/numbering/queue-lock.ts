// From apps/api/src/tokens/queue-lock.ts in the private repo. Unchanged.

import { NotFoundException } from '@nestjs/common';
import { Prisma, Queue } from '@prisma/client';

/**
 * The lock every counter action ("call next", recall, done, skip, no-show,
 * cancel) takes on the queue row, held until the transaction commits.
 *
 * It serialises counter actions on one queue, so two tablets pressing "call
 * next" at once read state that already includes each other's change.
 *
 * Issuing a token does not take it; issuers serialise on the queue_counters row
 * instead (ADR 0007). Shared here so the integration tests hold exactly the lock
 * the counters hold.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE. Both conflict with themselves, so counter
 * actions are serialised the same way. But inserting a token (or a counter row)
 * checks its foreign key to `queues` with FOR KEY SHARE, and FOR UPDATE
 * conflicts with that while FOR NO KEY UPDATE does not. With FOR UPDATE every
 * patient taking a number still waited for the counter holding this lock, and
 * an issuer holding the counter row then blocked every issuer behind it. No
 * counter action changes the queue's key, so the weaker lock is enough.
 *
 * Must be called inside a transaction: outside one the lock is released at once.
 */
export async function lockQueueForCounterAction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  queueId: string,
): Promise<Queue> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM queues
     WHERE id = ${queueId} AND "tenantId" = ${tenantId}
     FOR NO KEY UPDATE
  `;

  if (rows.length === 0) {
    throw new NotFoundException('Queue not found');
  }

  // The lock is held by the SELECT above; this read is for the typed object.
  return tx.queue.findUniqueOrThrow({ where: { id: queueId } });
}

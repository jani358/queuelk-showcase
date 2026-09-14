/**
 * ============================================================================
 * SHOWCASE EXCERPT — QueueLK · apps/api/src/tokens/tokens.service.ts
 * ============================================================================
 *
 * WHAT THIS DEMONSTRATES
 *
 * Gap-free, duplicate-free token numbering under real concurrency, and a
 * "call next" that calls exactly one patient no matter how many staff tablets
 * press the button at the same instant.
 *
 * Thirty patients scan the QR code in the same second while a receptionist
 * issues a walk-in at the counter. The numbers that come out are exactly
 * 1..31 — no gaps, no duplicates. A gap is not cosmetic: the display shows a
 * skipped patient and the room starts asking staff what happened to A-013.
 *
 * The three layers, each covering the one above it:
 *
 *   1. SELECT ... FOR UPDATE on the `queue_counters` row for (queue, day).
 *      Concurrent issuers serialise on that single row, in arrival order.
 *   2. UNIQUE (queueId, serviceDate, number) on `tokens` as the backstop, so a
 *      bypass of layer 1 is a database error rather than two printed "A-014"s.
 *   3. The capacity check runs in the SAME transaction as the allocation, so a
 *      rejected token cannot have consumed a number and left a gap behind.
 *
 * The genuinely interesting case is the first token of the day: the counter row
 * does not exist yet, and FOR UPDATE cannot lock a row that is not there. That
 * race is handled explicitly below rather than hoped away.
 *
 * The companion test — `concurrency.e2e-spec.ts` in this directory — fires
 * these paths in parallel against a REAL PostgreSQL, because a mocked version
 * would pass against code with no locking whatsoever.
 *
 * This is an excerpt, not the whole file. Methods not relevant to concurrency
 * (reporting views, retention sweeps, the thermal-ticket payload) are omitted,
 * and a handful of private helpers are included at the end so the flow reads
 * end to end. The full source is private; read-only access can be granted on
 * request for interviews.
 * ============================================================================
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  Queue,
  QueueStatus,
  TokenSource,
  TokenStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ACTIVE_STATUSES,
  TokenAction,
  transitionEffects,
} from './token-state';
import type { EtaResult } from '../queues/eta';

/** Trimmed to the fields the excerpt below touches. */
export interface TokenView {
  id: string;
  publicId: string;
  label: string;
  number: number;
  status: TokenStatus;
  queueId: string;
  peopleAhead: number;
  eta: EtaResult | null;
  allowedActions: TokenAction[];
}

export interface IssueTokenInput {
  tenantId: string;
  queueId: string;
  source: TokenSource;
  patientName?: string;
  /** Hash + last 4 only. The plaintext number never reaches this service. */
  phoneHash?: string;
  phoneLast4?: string;
  deviceHash?: string;
  note?: string;
  actorId?: string;
  idempotencyKey?: string;
}

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeService,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {}

  // =========================================================================
  // ISSUING — gap-free, duplicate-free numbering under concurrency
  // =========================================================================

  /**
   * Issues a token.
   *
   * THE INVARIANT: for a given (queue, service day), the numbers issued are
   * exactly 1..N with no gaps and no duplicates, no matter how many patients scan
   * the QR code at the same instant as staff press "Issue" at the counter.
   *
   * HOW IT IS GUARANTEED — three layers, each covering the one above it:
   *
   *   1. A row lock on `queue_counters (queueId, serviceDate)`, taken with
   *      SELECT ... FOR UPDATE inside a transaction. Concurrent issuers block on
   *      that single row and Postgres serialises them in arrival order. Read,
   *      increment, insert and commit all happen while the lock is held, so no
   *      two transactions can read the same `lastNumber`.
   *
   *   2. UNIQUE (queueId, serviceDate, number) on `tokens`. If layer 1 is ever
   *      bypassed — a bug, a migration, a manual INSERT during support — the
   *      database refuses the duplicate rather than printing two "A-014"s. A
   *      constraint that has never fired is not wasted; it is the reason the
   *      failure mode is a 409 instead of two patients at one counter.
   *
   *   3. The transaction is the same one that enforces the daily capacity cap, so
   *      a rejected token cannot have consumed a number. This is precisely what
   *      an "allocate from Redis, then insert" design cannot do: the number would
   *      already be spent, leaving a gap the display shows as a skipped patient.
   *
   * WHY NOT `INSERT ... SELECT MAX(number) + 1`: two concurrent transactions at
   * Postgres's default READ COMMITTED isolation both read the same MAX and both
   * insert. The unique index then rejects one of them — so a patient who did
   * nothing wrong gets an error and has to scan again. The lock turns a failure
   * into a wait, and a two-millisecond wait is invisible.
   *
   * WHY NOT SERIALIZABLE ISOLATION: it would also be correct, but it converts
   * contention into serialisation failures the application must retry, and it
   * applies that cost to every statement in the transaction. An explicit row lock
   * is narrower, cheaper, and states the intent in one line someone can read.
   */
  async issue(input: IssueTokenInput): Promise<TokenView> {
    const { tenantId, queueId } = input;

    return this.idempotency.run(
      {
        tenantId,
        key: input.idempotencyKey,
        endpoint: `POST /queues/${queueId}/tokens`,
        body: {
          queueId,
          source: input.source,
          patientName: input.patientName ?? null,
          deviceHash: input.deviceHash ?? null,
        },
      },
      async (tx) => {
        const queue = await this.loadQueueForWrite(tx, tenantId, queueId);

        if (queue.status !== QueueStatus.OPEN) {
          throw new ConflictException(
            queue.status === QueueStatus.PAUSED
              ? 'This queue is paused and is not issuing new tokens right now.'
              : 'This queue is closed.',
          );
        }

        const on = await this.serviceDateFor(tx, tenantId);

        /**
         * One active token per device per queue per day.
         *
         * Enforced HERE, inside the transaction, and not only in the Redis rate
         * limiter — because the rate limiter fails open when Redis is down, and
         * "Redis is down" must not become "anyone can mint unlimited tokens".
         *
         * Scoped to ACTIVE statuses so a patient who was already served, or who
         * cancelled, can legitimately take another token later the same day.
         */
        if (input.deviceHash) {
          const existing = await tx.token.findFirst({
            where: {
              tenantId,
              queueId,
              serviceDate: on,
              deviceHash: input.deviceHash,
              status: { in: [...ACTIVE_STATUSES] },
            },
          });

          if (existing) {
            throw new ConflictException({
              error: 'AlreadyHasToken',
              message: 'This device already has an active token in this queue.',
              // Returned so the phone can redirect to the token they already hold
              // instead of showing a dead end.
              publicId: existing.publicId,
            });
          }
        }

        // Capacity check inside the transaction, before a number is allocated.
        if (queue.dailyCapacity !== null) {
          const issued = await tx.token.count({
            where: {
              tenantId,
              queueId,
              serviceDate: on,
              // Cancelled tokens release their slot.
              status: { not: TokenStatus.CANCELLED },
            },
          });

          if (issued >= queue.dailyCapacity) {
            throw new ConflictException(
              `This queue is full for today (${queue.dailyCapacity} tokens). Please come back tomorrow.`,
            );
          }
        }

        const number = await this.allocateNumber(tx, tenantId, queueId, on);

        const token = await tx.token.create({
          data: {
            tenantId,
            queueId,
            number,
            serviceDate: on,
            status: TokenStatus.WAITING,
            source: input.source,
            publicId: this.generatePublicId(),
            patientName: input.patientName?.trim() || null,
            phoneHash: input.phoneHash ?? null,
            phoneLast4: input.phoneLast4 ?? null,
            deviceHash: input.deviceHash ?? null,
            note: input.note?.trim() || null,
            lastActorId: input.actorId ?? null,
          },
        });

        await tx.auditEvent.create({
          data: {
            tenantId,
            userId: input.actorId ?? null,
            action: 'token.issued',
            subjectId: token.id,
            meta: {
              queueId,
              number,
              source: input.source,
            } as Prisma.InputJsonValue,
          },
        });

        return this.buildView(tx, token, queue);
      },
    ).then(async (view) => {
      // Broadcast AFTER the transaction commits. Publishing inside it would
      // announce a token that could still roll back.
      await this.queues.broadcast(tenantId, queueId);
      return view;
    });
  }

  /**
   * The locked read-increment-write. Returns the next number for this queue+day.
   *
   * Must be called inside a transaction — the lock it takes is released at commit,
   * and outside a transaction it would be released immediately, which would make
   * this function look correct while providing no protection at all.
   */
  private async allocateNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    queueId: string,
    on: Date,
  ): Promise<number> {
    /**
     * SELECT ... FOR UPDATE. Raw SQL because Prisma has no first-class row-lock
     * API — `findUnique` cannot express FOR UPDATE, and expressing it any other
     * way would be a silent no-op.
     *
     * Parameterised via Prisma's tagged template, so the values are bound rather
     * than interpolated. tenantId is in the predicate even though (queueId,
     * serviceDate) is already unique: it costs nothing and it means this query,
     * read in isolation during a code review, is visibly tenant-scoped like every
     * other query in the system.
     */
    const locked = await tx.$queryRaw<{ id: string; last_number: number }[]>`
      SELECT id, last_number
        FROM queue_counters
       WHERE "queueId" = ${queueId}
         AND "tenantId" = ${tenantId}
         AND service_date = ${on}
         FOR UPDATE
    `;

    if (locked.length > 0) {
      const next = locked[0].last_number + 1;

      await tx.$executeRaw`
        UPDATE queue_counters
           SET last_number = ${next}, "updatedAt" = NOW()
         WHERE id = ${locked[0].id}
      `;

      return next;
    }

    /**
     * First token of the day for this queue: the counter row does not exist yet.
     *
     * Two concurrent first-issuers will BOTH find nothing above — FOR UPDATE
     * locks rows that exist, and cannot lock a row that does not. So both try to
     * INSERT, the unique index on (queueId, serviceDate) lets exactly one win,
     * and the loser catches P2002 and retries the locked read, which now finds
     * the winner's row and blocks on it properly.
     *
     * This is the one genuine race in the allocation path and it is handled
     * explicitly rather than hoped away. Note the loser's retry is guaranteed to
     * succeed: the row provably exists by then, so there is no retry loop.
     */
    try {
      await tx.queueCounter.create({
        data: { tenantId, queueId, serviceDate: on, lastNumber: 1 },
      });

      return 1;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const retry = await tx.$queryRaw<{ id: string; last_number: number }[]>`
          SELECT id, last_number
            FROM queue_counters
           WHERE "queueId" = ${queueId}
             AND "tenantId" = ${tenantId}
             AND service_date = ${on}
             FOR UPDATE
        `;

        if (retry.length === 0) {
          // Unreachable in practice: P2002 means the row exists and the lock
          // waits for the inserting transaction to commit.
          throw new ConflictException('Could not allocate a token number, please retry');
        }

        const next = retry[0].last_number + 1;

        await tx.$executeRaw`
          UPDATE queue_counters
             SET last_number = ${next}, "updatedAt" = NOW()
           WHERE id = ${retry[0].id}
        `;

        return next;
      }

      throw err;
    }
  }

  // =========================================================================
  // CALL NEXT — exactly one patient, even from two tablets at once
  // =========================================================================

  /**
   * Calls the next waiting patient.
   *
   * THE PROBLEM: two staff devices press "Call next" at the same moment. Without
   * protection, both read the same oldest WAITING token, both mark it CALLED, and
   * (worse) with a slightly different interleaving they call two DIFFERENT
   * patients while the display shows one — a patient loses their turn and nobody
   * can see why.
   *
   * THE FIX, in two parts:
   *
   *   1. A lock on the QUEUE row (not the token). Serialising on the queue means
   *      the whole read-decide-write cycle is exclusive, so the second caller
   *      reads state that already includes the first caller's change. Locking the
   *      token instead would not help: the race is in CHOOSING which token, and
   *      two transactions choose before either has a token to lock.
   *
   *   2. A conditional UPDATE (`WHERE id = ? AND status = 'WAITING'`) as the
   *      actual write. Even holding the lock, the write asserts the precondition,
   *      so if anything else ever changed the row the update affects zero rows and
   *      we know rather than guess. Belt and braces, and the braces cost nothing.
   *
   * Plus idempotency: a double-tap on ONE tablet sends the same Idempotency-Key
   * twice and replays the first response. Together these cover both "two devices"
   * and "one device twice", which are genuinely different problems — the lock
   * cannot help with a retry, because a retry is a legitimately separate request.
   */
  async callNext(params: {
    tenantId: string;
    queueId: string;
    actorId: string;
    idempotencyKey?: string;
  }): Promise<TokenView | null> {
    const { tenantId, queueId, actorId } = params;

    const result = await this.idempotency.run(
      {
        tenantId,
        key: params.idempotencyKey,
        endpoint: `POST /queues/${queueId}/call-next`,
        body: { queueId },
      },
      async (tx) => {
        const queue = await this.loadQueueForWrite(tx, tenantId, queueId);

        if (queue.status === QueueStatus.CLOSED) {
          throw new ConflictException('This queue is closed.');
        }

        const on = await this.serviceDateFor(tx, tenantId);

        /**
         * The oldest waiting token, by NUMBER.
         *
         * By number rather than by issuedAt because the number is the promise
         * printed on the patient's slip. If the two ever disagreed — a backdated
         * token, a clock adjustment — the patient's expectation is what must win.
         */
        const next = await tx.token.findFirst({
          where: { tenantId, queueId, serviceDate: on, status: TokenStatus.WAITING },
          orderBy: { number: 'asc' },
        });

        if (!next) {
          // Not an error: "nobody is waiting" is a normal answer to "call next",
          // and a 404 here would make the console show a red toast every time a
          // clinic catches up with its queue.
          return null;
        }

        const now = new Date();
        const effects = transitionEffects(next.status, TokenAction.CALL, now);

        /**
         * Conditional update. `updateMany` (not `update`) because it can express
         * the `status` precondition in the WHERE clause and reports how many rows
         * it touched. `update` matches on the primary key only and would happily
         * overwrite a token some other path had already moved.
         */
        const { count } = await tx.token.updateMany({
          where: {
            id: next.id,
            tenantId,
            status: TokenStatus.WAITING,
          },
          data: {
            status: effects.status,
            calledAt: effects.calledAt,
            lastActorId: actorId,
          },
        });

        if (count === 0) {
          // With the queue lock held this should be unreachable. It is checked
          // anyway: a silently-zero update would return a "called" response for a
          // patient who was never called.
          throw new ConflictException('That token was just taken by another device. Try again.');
        }

        const updated = await tx.token.findUniqueOrThrow({ where: { id: next.id } });

        await tx.auditEvent.create({
          data: {
            tenantId,
            userId: actorId,
            action: 'token.called',
            subjectId: updated.id,
            meta: { queueId, number: updated.number } as Prisma.InputJsonValue,
          },
        });

        return this.buildView(tx, updated, queue);
      },
    );

    if (result) {
      await this.afterChange(tenantId, queueId, result);
    }

    return result;
  }

  // =========================================================================
  // internals — included so the excerpt reads end to end
  // =========================================================================

  /**
   * Loads a queue with a row lock, for the duration of the transaction.
   *
   * This single line is what makes "call next" safe under concurrency. It is a
   * raw query because Prisma cannot express FOR UPDATE — and a version of this
   * function without the lock would pass every test that does not run requests in
   * parallel, which is why the integration suite fires ten at once.
   */
  private async loadQueueForWrite(
    tx: Prisma.TransactionClient,
    tenantId: string,
    queueId: string,
  ): Promise<Queue> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM queues
       WHERE id = ${queueId} AND "tenantId" = ${tenantId}
       FOR UPDATE
    `;

    if (rows.length === 0) {
      throw new NotFoundException('Queue not found');
    }

    // The lock is held by the SELECT above; this read is for the typed object.
    return tx.queue.findUniqueOrThrow({ where: { id: queueId } });
  }

  private async serviceDateFor(tx: Prisma.TransactionClient, tenantId: string): Promise<Date> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true },
    });

    // The clinic's local day, not UTC. A token issued at 00:30 Colombo time
    // belongs to that day's queue, and a tenant in another timezone rolls over
    // at its own midnight. Derived per request rather than stored, so there is
    // no cron job to fail overnight.
    const { serviceDate } = await import('../queues/service-date');
    return serviceDate(tenant.timezone);
  }

  /**
   * Unguessable public handle.
   *
   * 16 bytes (128 bits) of CSPRNG, base64url. The URL /t/<publicId> is the
   * patient's ONLY credential — it is what their phone bookmarks and what
   * authorises cancelling their own token — so it must not be enumerable. A
   * sequential id, or anything derived from the token number, would let anyone
   * walk the whole clinic's traffic and cancel strangers' places in line.
   */
  private generatePublicId(): string {
    return randomBytes(16).toString('base64url');
  }

  // buildView() and afterChange() are omitted from this excerpt: they assemble
  // the response shape and publish the SSE broadcast, and neither participates
  // in the concurrency guarantees this sample is here to show.
}

// From apps/api/src/common/idempotency/idempotency.service.ts in the private repo. Unchanged.

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/** Replay of a previously stored response. */
export interface IdempotentHit<T> {
  replayed: true;
  response: T;
}

/**
 * Idempotency for state-changing staff actions.
 *
 * THE SCENARIO, concretely: a ten-year-old Android tablet on clinic wifi. Staff
 * taps "Call next". The response takes three seconds. They tap again. Without
 * protection two patients are called, the second one is standing at a counter
 * nobody is expecting them at, and the first has lost their place.
 *
 * THE CONTRACT:
 *   - First request with a given (tenant, key): the action runs, the response is
 *     stored, and it is returned.
 *   - Retry with the SAME key and the SAME body: the stored response is returned
 *     verbatim, and the action does NOT run again. Not an error — from the
 *     client's point of view the first request simply succeeded.
 *   - Same key with a DIFFERENT body or a different endpoint: 409. That is a
 *     client bug (a key generator that repeats), and returning the first
 *     response would be actively wrong — it would report success for an action
 *     that never happened.
 *
 * WHY POSTGRES AND NOT REDIS: this record must be exactly as durable as the
 * action it guards. If Redis loses the key after a restart, a retry re-executes
 * "Call next" and the thing we built this to prevent happens anyway. The
 * idempotency row is written in the SAME transaction as the state change, so
 * they commit or roll back together — that atomicity is the whole design and
 * Redis cannot participate in a Postgres transaction.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * 24 hours. Far longer than any plausible client retry (a tablet that has been
   * offline for a day should be issuing a *new* command, not replaying a stale
   * one) and short enough that the table stays small.
   */
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `action` at most once per (tenantId, key).
   *
   * `action` receives the transaction client so its writes and the idempotency
   * row commit atomically.
   */
  async run<T>(
    params: {
      tenantId: string;
      key: string | undefined;
      endpoint: string;
      body: unknown;
    },
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const { tenantId, key, endpoint, body } = params;

    // No key supplied: run unprotected. Deliberately permitted so the API stays
    // usable from curl and Swagger, and because a missing key is the caller's
    // risk to take. The web console always sends one.
    if (!key) {
      return this.prisma.$transaction((tx) => action(tx));
    }

    const requestHash = this.hashBody(body);

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });

    if (existing) {
      if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
        throw new ConflictException(
          'This idempotency key was already used for a different request. Generate a new key per action.',
        );
      }

      // An expired-but-not-yet-swept row is still a valid replay: the sweep is a
      // storage optimisation, not a correctness boundary, and honouring it is
      // strictly safer than re-running the action.
      this.logger.debug(`Idempotent replay: ${endpoint} key=${key}`);
      return existing.responseBody as T;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await action(tx);

        // Written INSIDE the transaction. If the action succeeds but this insert
        // fails, both roll back — which is correct: we must never be in a state
        // where the action happened and the replay record says it did not.
        await tx.idempotencyKey.create({
          data: {
            tenantId,
            key,
            endpoint,
            requestHash,
            // JSON round-trip normalises undefined and Date values into
            // something Prisma's Json column accepts.
            responseBody: JSON.parse(JSON.stringify(result ?? null)) as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + IdempotencyService.TTL_MS),
          },
        });

        return result;
      });
    } catch (err) {
      /**
       * Two requests with the same key arrived close enough that both passed the
       * findUnique above. One transaction wins the unique index; the loser lands
       * here. The right answer is not an error — the action DID happen, once —
       * so read the winner's stored response and return that.
       *
       * This is the race the pre-check cannot close on its own, and handling it
       * is the difference between idempotency that works under load and
       * idempotency that works in a demo.
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.idempotencyKey.findUnique({
          where: { tenantId_key: { tenantId, key } },
        });

        if (winner && winner.endpoint === endpoint && winner.requestHash === requestHash) {
          this.logger.debug(`Idempotent race resolved: ${endpoint} key=${key}`);
          return winner.responseBody as T;
        }
      }

      throw err;
    }
  }

  /** Deletes expired rows. Called by the scheduled maintenance job. */
  async sweep(): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (count > 0) {
      this.logger.log(`Swept ${count} expired idempotency keys`);
    }

    return count;
  }

  /**
   * Stable hash of the request body.
   *
   * Keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` hash identically — otherwise a
   * client whose JSON serialiser reorders keys between attempts would get a
   * spurious 409 on a retry that is genuinely the same request.
   */
  private hashBody(body: unknown): string {
    return createHash('sha256').update(this.stableStringify(body)).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      // undefined fields disappear in JSON.stringify, so they must not
      // contribute to the hash either.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${this.stableStringify(v)}`);

    return `{${entries.join(',')}}`;
  }
}

// From apps/api/src/notifications/channel-chain.ts in the private repo. Unchanged.

import { Plan } from '@prisma/client';
import type {
  ChannelName,
  NotificationChannel,
  NotificationMessage,
  NotificationTarget,
} from './notification-channel';

/**
 * The fallback order per plan. The implicit last step of every chain is "none".
 *
 *   FREE    expo → push → none         Both cost nothing to send.
 *   STARTER expo → push → sms → none   SMS is a per-message cost the plan pays for.
 *   PRO     expo → push → sms → none
 *
 * The free channels are always tried first, even on paid plans: they are
 * instant and carry a deep link. Expo (the native patient app, Phase 2) goes
 * before Web Push because installing the app is the stronger signal of how the
 * patient wants to be reached, and a native notification survives Android
 * battery savers that can silence a browser. SMS is the fallback for the
 * patient who has neither the app nor a push subscription (an iPhone without the page installed, a denied
 * permission), not a duplicate of it — sending both would bill the clinic for a
 * message the patient already received.
 */
const CHANNEL_ORDER: readonly ChannelName[] = ['expo', 'push', 'sms'];

const PLAN_CHAINS: Record<Plan, readonly ChannelName[]> = {
  [Plan.FREE]: ['expo', 'push'],
  [Plan.STARTER]: ['expo', 'push', 'sms'],
  [Plan.PRO]: ['expo', 'push', 'sms'],
};

/**
 * The chain for one tenant: its plan's default, adjusted by `tenant.features`.
 *
 * Per-tenant overrides win over the plan, the same rule PublicService.hasFeature
 * applies, so "this clinic also gets SMS" or "this clinic asked us not to push"
 * is a data change rather than a new plan.
 */
export const channelChainFor = (
  plan: Plan,
  features: Record<string, unknown> | null | undefined,
): ChannelName[] => {
  const flags = features ?? {};
  const enabled = new Set<ChannelName>(PLAN_CHAINS[plan]);

  for (const name of CHANNEL_ORDER) {
    if (flags[name] === true) enabled.add(name);
    if (flags[name] === false) enabled.delete(name);
  }

  // A fixed order, whatever the overrides added: the free channels before sms (paid).
  return CHANNEL_ORDER.filter((name) => enabled.has(name));
};

export type DispatchOutcome =
  /** A channel delivered it. */
  | { status: 'sent'; channel: ChannelName }
  /** At least one channel was tried and every one failed. */
  | { status: 'failed'; channel: ChannelName; reasons: string[] }
  /** No channel in the chain had anything to deliver to. Nothing was claimed. */
  | { status: 'none' }
  /** Another process already claimed this notification. Nothing was sent. */
  | { status: 'duplicate' };

/**
 * Walks a channel chain: the first channel that can deliver AND does deliver
 * wins; a failure falls through to the next; nothing left means "none".
 *
 * `claim` runs exactly once, after it is known that SOME channel can deliver
 * and immediately before the first send. That ordering is the point:
 *   - claiming before the pre-check would burn the one-shot "approaching"
 *     notification for a patient who subscribes a minute later;
 *   - claiming after the send would let two API instances both send.
 */
export const dispatchThroughChain = async (params: {
  chain: readonly ChannelName[];
  channels: ReadonlyMap<ChannelName, NotificationChannel>;
  target: NotificationTarget;
  message: NotificationMessage;
  claim: () => Promise<boolean>;
}): Promise<DispatchOutcome> => {
  const { chain, channels, target, message, claim } = params;

  const candidates: NotificationChannel[] = [];
  for (const name of chain) {
    const channel = channels.get(name);
    if (channel && (await channel.canDeliver(target))) {
      candidates.push(channel);
    }
  }

  if (candidates.length === 0) {
    return { status: 'none' };
  }

  if (!(await claim())) {
    return { status: 'duplicate' };
  }

  const reasons: string[] = [];
  for (const channel of candidates) {
    try {
      const result = await channel.send(target, message);
      if (result.delivered) {
        return { status: 'sent', channel: channel.name };
      }
      reasons.push(`${channel.name}: ${result.reason ?? 'not delivered'}`);
    } catch (err) {
      // A throwing channel is a failed channel, not a failed chain.
      reasons.push(`${channel.name}: ${String(err)}`);
    }
  }

  return {
    status: 'failed',
    channel: candidates[candidates.length - 1].name,
    reasons,
  };
};

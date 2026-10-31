// From apps/api/src/notifications/notification-channel.ts in the private repo. Unchanged.

/**
 * The notification channel abstraction (Phase 1.4).
 *
 * A patient who closed the tab can still be told "you are two away" and "go to
 * the counter now". HOW depends on what the clinic pays for and what the patient
 * agreed to: a Web Push subscription is free, an SMS costs the clinic money per
 * message, and some patients have neither.
 *
 * So every channel implements one small interface and the dispatcher walks an
 * ordered chain — expo → push → sms → none — stopping at the first channel that
 * delivers. Adding WhatsApp later is a new class and a new entry in the chain,
 * not a change to the code that decides WHEN to notify.
 */

export type NotificationKind = 'approaching' | 'called';

export type ChannelName = 'expo' | 'push' | 'sms';

export type NotificationLanguage = 'si' | 'ta' | 'en';

/** WHAT to say. Language-neutral: each channel renders it for its recipient. */
export interface NotificationMessage {
  kind: NotificationKind;
  /** e.g. "A-014". */
  label: string;
  queueName: string;
  /** Used to build the deep link back to /t/<publicId>. */
  publicId: string;
}

/** WHO to say it to. */
export interface NotificationTarget {
  tenantId: string;
  tokenId: string;
  publicId: string;
  /** Preferred language when the channel has no per-recipient preference. */
  language: NotificationLanguage;
  /**
   * E.164 phone number, if one is available.
   *
   * Always undefined in v1, deliberately: QueueLK stores only a hash and the
   * last four digits of a patient's phone (see PhoneService), so there is
   * nothing to text. A real SMS rollout needs an encrypted phone vault with its
   * own retention rules — a decision recorded in docs/01-ARCHITECTURE, not made
   * quietly here.
   */
  phoneE164?: string;
}

export interface DeliveryResult {
  delivered: boolean;
  /** Free-form reason for a failure, for logs. Never shown to a patient. */
  reason?: string;
}

export interface NotificationChannel {
  readonly name: ChannelName;
  /**
   * Cheap pre-check: is there anything to send TO? (A push subscription, a phone
   * number, a configured provider.) A channel that cannot deliver is skipped
   * without being tried, so the chain falls through without a failed send.
   */
  canDeliver(target: NotificationTarget): Promise<boolean>;
  send(target: NotificationTarget, message: NotificationMessage): Promise<DeliveryResult>;
}

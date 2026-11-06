/**
 * Bot-wide @owner budget for CLI rate/usage-limit notices.
 *
 * One account limit usually hits every busy topic of the same bot within a few
 * minutes. Each topic still gets its own "paused" notice (so the topic shows
 * why it stopped), but only the first one in a limit episode @-mentions the
 * owner. The window lasts until the reported reset time, at least
 * RATE_LIMIT_MENTION_MIN_WINDOW_MS and at most RATE_LIMIT_MENTION_MAX_WINDOW_MS,
 * so a fresh limit after the reset pings again.
 *
 * In-memory only: a daemon restart re-arms the budget, which at worst costs
 * one extra @ after a restart.
 */

export type RateLimitMentionKind = 'usage' | 'rate';

export const RATE_LIMIT_MENTION_MIN_WINDOW_MS = 5 * 60 * 1_000;
export const RATE_LIMIT_MENTION_MAX_WINDOW_MS = 6 * 60 * 60 * 1_000;

const claims = new Map<string, number>(); // key -> expiresAt

/**
 * Returns true when this notice should carry the @owner mention, and records
 * the claim. Returns false while another session of the same bot already
 * mentioned the same owner for the same limit kind in the current window.
 */
export function claimRateLimitMention(input: {
  larkAppId: string;
  ownerOpenId: string;
  kind: RateLimitMentionKind;
  retryAtMs: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  for (const [key, expiresAt] of claims) {
    if (expiresAt <= now) claims.delete(key);
  }
  const key = `${input.larkAppId}:${input.ownerOpenId}:${input.kind}`;
  const existing = claims.get(key);
  if (existing !== undefined && existing > now) return false;
  const untilReset = Number.isFinite(input.retryAtMs) ? input.retryAtMs : now;
  const expiresAt = Math.min(
    now + RATE_LIMIT_MENTION_MAX_WINDOW_MS,
    Math.max(now + RATE_LIMIT_MENTION_MIN_WINDOW_MS, untilReset),
  );
  claims.set(key, expiresAt);
  return true;
}

/** Give the claim back when the @ notice could not be delivered, so the next
 *  limited session of the same bot can still reach the owner. */
export function releaseRateLimitMention(input: {
  larkAppId: string;
  ownerOpenId: string;
  kind: RateLimitMentionKind;
}): void {
  claims.delete(`${input.larkAppId}:${input.ownerOpenId}:${input.kind}`);
}

export function __testOnly_resetRateLimitMentions(): void {
  claims.clear();
}

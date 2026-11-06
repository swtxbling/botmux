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
// Capped at one hour: a mis-parsed or bogus far-away reset time must not
// silence a genuinely new limit for long.
export const RATE_LIMIT_MENTION_MAX_WINDOW_MS = 60 * 60 * 1_000;

const claims = new Map<string, { expiresAt: number; token: number }>();
let nextToken = 0;

/**
 * Returns a claim token when this notice should carry the @owner mention, and
 * records the claim. Returns undefined while another session of the same bot
 * already mentioned the same owner for the same limit kind in the window.
 */
export function claimRateLimitMention(input: {
  larkAppId: string;
  ownerOpenId: string;
  kind: RateLimitMentionKind;
  retryAtMs: number;
  now?: number;
}): number | undefined {
  const now = input.now ?? Date.now();
  for (const [key, claim] of claims) {
    if (claim.expiresAt <= now) claims.delete(key);
  }
  const key = `${input.larkAppId}:${input.ownerOpenId}:${input.kind}`;
  const existing = claims.get(key);
  if (existing !== undefined && existing.expiresAt > now) return undefined;
  const untilReset = Number.isFinite(input.retryAtMs) ? input.retryAtMs : now;
  const expiresAt = Math.min(
    now + RATE_LIMIT_MENTION_MAX_WINDOW_MS,
    Math.max(now + RATE_LIMIT_MENTION_MIN_WINDOW_MS, untilReset),
  );
  const token = ++nextToken;
  claims.set(key, { expiresAt, token });
  return token;
}

/** Give the claim back when the @ notice could not be delivered, so the next
 *  limited session of the same bot can still reach the owner. Only the claim
 *  identified by `token` is released; a newer claim is left alone. */
export function releaseRateLimitMention(input: {
  larkAppId: string;
  ownerOpenId: string;
  kind: RateLimitMentionKind;
  token: number;
}): void {
  const key = `${input.larkAppId}:${input.ownerOpenId}:${input.kind}`;
  if (claims.get(key)?.token === input.token) claims.delete(key);
}

export function __testOnly_resetRateLimitMentions(): void {
  claims.clear();
}

import { beforeEach, describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_MENTION_MAX_WINDOW_MS,
  RATE_LIMIT_MENTION_MIN_WINDOW_MS,
  __testOnly_resetRateLimitMentions,
  claimRateLimitMention,
  releaseRateLimitMention,
} from '../src/services/rate-limit-mention.js';

const base = { larkAppId: 'cli_a', ownerOpenId: 'ou_owner', kind: 'usage' as const };

describe('claimRateLimitMention', () => {
  beforeEach(() => __testOnly_resetRateLimitMentions());

  it('同一 bot、同一 owner、同一类限额，在重置时间前只给一次 @', () => {
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;
    expect(claimRateLimitMention({ ...base, retryAtMs, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, retryAtMs, now: now + 1_000 })).toBe(false);
    expect(claimRateLimitMention({ ...base, retryAtMs, now: retryAtMs - 1 })).toBe(false);
    expect(claimRateLimitMention({ ...base, retryAtMs, now: retryAtMs })).toBe(true);
  });

  it('重置时间很近或已过时，至少静默最短窗口', () => {
    const now = 5_000_000;
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS - 1 })).toBe(false);
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS })).toBe(true);
  });

  it('重置时间很远时，最长窗口过后会再 @ 一次', () => {
    const now = 9_000_000;
    const far = now + 10 * RATE_LIMIT_MENTION_MAX_WINDOW_MS;
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now: now + RATE_LIMIT_MENTION_MAX_WINDOW_MS - 1 })).toBe(false);
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now: now + RATE_LIMIT_MENTION_MAX_WINDOW_MS })).toBe(true);
  });

  it('不同 bot、不同 owner、不同限额类型互不影响', () => {
    const now = 1_000;
    const retryAtMs = now + 60_000_000;
    expect(claimRateLimitMention({ ...base, retryAtMs, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, larkAppId: 'cli_b', retryAtMs, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, ownerOpenId: 'ou_other', retryAtMs, now })).toBe(true);
    expect(claimRateLimitMention({ ...base, kind: 'rate', retryAtMs, now })).toBe(true);
  });

  it('发送失败后让出名额，下一次可以再 @', () => {
    const now = 1_000;
    const retryAtMs = now + 60_000_000;
    expect(claimRateLimitMention({ ...base, retryAtMs, now })).toBe(true);
    releaseRateLimitMention(base);
    expect(claimRateLimitMention({ ...base, retryAtMs, now: now + 1 })).toBe(true);
  });
});

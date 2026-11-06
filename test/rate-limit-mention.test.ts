import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fault injection for the claim-file layer only; everything else passes through.
const fsHooks = vi.hoisted(() => ({
  onAfterRename: null as null | ((dest: string) => void),
  failTmpWrite: false,
  failClaimRead: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isClaimFile = (p: unknown) => typeof p === 'string' && p.includes('rate-limit-mention') && p.endsWith('.json');
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      actual.renameSync(from, to);
      fsHooks.onAfterRename?.(to);
    },
    writeFileSync: ((file: any, data: any, options?: any) => {
      if (fsHooks.failTmpWrite && typeof file === 'string' && file.endsWith('.tmp')) {
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      return (actual.writeFileSync as any)(file, data, options);
    }) as typeof actual.writeFileSync,
    readFileSync: ((file: any, options?: any) => {
      if (fsHooks.failClaimRead && isClaimFile(file)) {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      }
      return (actual.readFileSync as any)(file, options);
    }) as typeof actual.readFileSync,
  };
});
import {
  RATE_LIMIT_MENTION_MAX_WINDOW_MS,
  RATE_LIMIT_MENTION_MIN_WINDOW_MS,
  __testOnly_resetRateLimitMentions,
  claimRateLimitMention,
  rateLimitMentionAccountKey,
  releaseRateLimitMention,
} from '../src/services/rate-limit-mention.js';

const base = { larkAppId: 'cli_a', ownerOpenId: 'ou_owner', kind: 'usage' as const };

describe('claimRateLimitMention', () => {
  beforeEach(() => __testOnly_resetRateLimitMentions());

  it('同一 bot、同一 owner、同一类限额，在重置时间前只给一次 @', () => {
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;
    expect(claimRateLimitMention({ ...base, retryAtMs, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, retryAtMs, now: now + 1_000 })).toBeUndefined();
    expect(claimRateLimitMention({ ...base, retryAtMs, now: retryAtMs - 1 })).toBeUndefined();
    expect(claimRateLimitMention({ ...base, retryAtMs, now: retryAtMs })).toBeDefined();
  });

  it('重置时间很近或已过时，至少静默最短窗口', () => {
    const now = 5_000_000;
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS - 1 })).toBeUndefined();
    expect(claimRateLimitMention({ ...base, retryAtMs: now - 1, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS })).toBeDefined();
  });

  it('重置时间很远时，最长窗口过后会再 @ 一次', () => {
    const now = 9_000_000;
    const far = now + 10 * RATE_LIMIT_MENTION_MAX_WINDOW_MS;
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now: now + RATE_LIMIT_MENTION_MAX_WINDOW_MS - 1 })).toBeUndefined();
    expect(claimRateLimitMention({ ...base, retryAtMs: far, now: now + RATE_LIMIT_MENTION_MAX_WINDOW_MS })).toBeDefined();
  });

  it('不同 bot、不同 owner、不同限额类型互不影响', () => {
    const now = 1_000;
    const retryAtMs = now + 60_000_000;
    expect(claimRateLimitMention({ ...base, retryAtMs, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, larkAppId: 'cli_b', retryAtMs, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, ownerOpenId: 'ou_other', retryAtMs, now })).toBeDefined();
    expect(claimRateLimitMention({ ...base, kind: 'rate', retryAtMs, now })).toBeDefined();
  });

  it('发送失败后让出名额，下一次可以再 @', () => {
    const now = 1_000;
    const retryAtMs = now + 60_000_000;
    const token = claimRateLimitMention({ ...base, retryAtMs, now });
    expect(token).toBeDefined();
    releaseRateLimitMention({ ...base, token: token! });
    expect(claimRateLimitMention({ ...base, retryAtMs, now: now + 1 })).toBeDefined();
  });

  it('迟到的发送失败不会删掉别人后来拿到的名额', () => {
    const now = 1_000;
    const stale = claimRateLimitMention({ ...base, retryAtMs: now, now });
    expect(stale).toBeDefined();
    const later = now + RATE_LIMIT_MENTION_MIN_WINDOW_MS;
    expect(claimRateLimitMention({ ...base, retryAtMs: later, now: later })).toBeDefined();
    releaseRateLimitMention({ ...base, token: stale! });
    expect(claimRateLimitMention({ ...base, retryAtMs: later, now: later + 1 })).toBeUndefined();
  });

  it('重置时间解析不出来（NaN / Infinity）时按最短窗口静默', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      __testOnly_resetRateLimitMentions();
      const now = 2_000;
      expect(claimRateLimitMention({ ...base, retryAtMs: bad, now })).toBeDefined();
      expect(claimRateLimitMention({ ...base, retryAtMs: bad, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS - 1 })).toBeUndefined();
      expect(claimRateLimitMention({ ...base, retryAtMs: bad, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS })).toBeDefined();
    }
  });
});

describe('跨进程（同账号的多个 bot daemon）', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rlm-'));
    previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  // A "process" is a fresh module instance: its in-memory Map is empty and
  // only the shared claim file can make it stay quiet.
  async function loadProcess(): Promise<typeof import('../src/services/rate-limit-mention.js')> {
    vi.resetModules();
    return import('../src/services/rate-limit-mention.js');
  }

  const account = 'claude-code:/accounts/shared';
  const ownerUnionId = 'on_same_person';

  function claimFileDir(): string {
    return join(dataDir, 'rate-limit-mention');
  }

  it('同账号、同一人（不同 bot 的 open_id 不同）只 @ 一次', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeUndefined();
  });

  it('账号不同就各发各的', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now,
      accountKey: 'claude-code:/accounts/other',
    })).toBeDefined();
  });

  it('文件名不同：同账号不同人 / 不同限额类型互不影响', async () => {
    const botA = await loadProcess();
    const otherPerson = await loadProcess();
    const otherKind = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(otherPerson.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId: 'on_other_person', kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(otherKind.claimRateLimitMention({
      larkAppId: 'cli_c', ownerOpenId: 'ou_c', ownerUnionId, kind: 'rate', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(readdirSync(claimFileDir())).toHaveLength(3);
  });

  it('claim 过期后别的进程可以重新 @', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs: now, now, accountKey: account,
    })).toBeDefined();
    const expiredAt = now + RATE_LIMIT_MENTION_MIN_WINDOW_MS;
    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs: expiredAt + 60_000, now: expiredAt, accountKey: account,
    })).toBeDefined();
  });

  it('A 发送失败让出名额后，B 可以 @；文件也一并撤掉', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    const token = botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    });
    expect(token).toBeDefined();
    expect(readdirSync(claimFileDir())).toHaveLength(1);

    botA.releaseRateLimitMention({ larkAppId: 'cli_a', ownerOpenId: 'ou_a', kind: 'usage', token: token! });
    expect(readdirSync(claimFileDir())).toHaveLength(0);

    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now: now + 1, accountKey: account,
    })).toBeDefined();
  });

  it('迟到的发送失败不会删掉 B 后来拿到的那份', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const botC = await loadProcess();
    const now = 1_000_000;

    const stale = botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs: now, now, accountKey: account,
    });
    expect(stale).toBeDefined();

    const later = now + RATE_LIMIT_MENTION_MIN_WINDOW_MS;
    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs: later + 60 * 60 * 1_000, now: later, accountKey: account,
    })).toBeDefined();

    botA.releaseRateLimitMention({ larkAppId: 'cli_a', ownerOpenId: 'ou_a', kind: 'usage', token: stale! });

    expect(botC.claimRateLimitMention({
      larkAppId: 'cli_c', ownerOpenId: 'ou_c', ownerUnionId, kind: 'usage', retryAtMs: later + 60 * 60 * 1_000, now: later + 1, accountKey: account,
    })).toBeUndefined();
  });

  it('有账号但没有 union_id 时也不跨进程去重（open_id 跨 bot 认不出人）', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    expect(existsSync(claimFileDir())).toBe(false);
  });

  it('接管写盘失败（ENOSPC）时照样 @，只是不带跨进程名额', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs: now, accountKey: account,
    })).toBeDefined();

    const expiredAt = now + RATE_LIMIT_MENTION_MIN_WINDOW_MS;
    fsHooks.failTmpWrite = true;
    try {
      expect(botB.claimRateLimitMention({
        larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs: retryAtMs + expiredAt, now: expiredAt, accountKey: account,
      })).toBeDefined();
    } finally {
      fsHooks.failTmpWrite = false;
    }
  });

  it('claim 文件读不了（EACCES）时不覆盖它，只在进程内去重', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    const path = join(claimFileDir(), readdirSync(claimFileDir())[0]);
    const before = readFileSync(path, 'utf8');

    fsHooks.failClaimRead = true;
    try {
      expect(botB.claimRateLimitMention({
        larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now: now + 1_000, accountKey: account,
      })).toBeDefined();
    } finally {
      fsHooks.failClaimRead = false;
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('存了远超上限的 expiresAt（时钟跳变 / 手改）当作坏数据接管', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    const path = join(claimFileDir(), readdirSync(claimFileDir())[0]);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...stored, expiresAt: now + 10 * RATE_LIMIT_MENTION_MAX_WINDOW_MS }));

    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now: now + 1_000, accountKey: account,
    })).toBeDefined();
  });

  it('接管后回读发现名额已经不是自己的，就不 @', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs: now, now, accountKey: account,
    })).toBeDefined();

    // A competing takeover lands right after our rename.
    fsHooks.onAfterRename = (dest) => {
      writeFileSync(dest, JSON.stringify({ expiresAt: now + 60 * 60 * 1_000, token: 'someone-else', larkAppId: 'cli_x' }));
    };
    let claimed: number | undefined;
    try {
      claimed = botB.claimRateLimitMention({
        larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage',
        retryAtMs, now: now + RATE_LIMIT_MENTION_MIN_WINDOW_MS, accountKey: account,
      });
    } finally {
      fsHooks.onAfterRename = null;
    }
    expect(claimed).toBeUndefined();
  });

  it('进程在写 claim 文件途中崩掉（留下空文件）时，别的进程仍能接管', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;

    expect(botA.claimRateLimitMention({
      larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage', retryAtMs, now, accountKey: account,
    })).toBeDefined();
    const [file] = readdirSync(claimFileDir());
    writeFileSync(join(claimFileDir(), file), '');

    expect(botB.claimRateLimitMention({
      larkAppId: 'cli_b', ownerOpenId: 'ou_b', ownerUnionId, kind: 'usage', retryAtMs, now: now + 1_000, accountKey: account,
    })).toBeDefined();
  });

  it('算不出账号时退回进程内去重（不会跨进程乱静默）', async () => {
    const botA = await loadProcess();
    const botB = await loadProcess();
    const now = 1_000_000;
    const retryAtMs = now + 60 * 60 * 1_000;
    const input = { larkAppId: 'cli_a', ownerOpenId: 'ou_a', ownerUnionId, kind: 'usage' as const, retryAtMs, now };

    expect(botA.claimRateLimitMention(input)).toBeDefined();
    expect(botA.claimRateLimitMention({ ...input, now: now + 1 })).toBeUndefined();
    expect(botB.claimRateLimitMention({ ...input, now: now + 1 })).toBeDefined();
    expect(existsSync(claimFileDir())).toBe(false);
  });
});

describe('rateLimitMentionAccountKey', () => {
  it('没有配置目录 / 相对路径时算不出账号', () => {
    expect(rateLimitMentionAccountKey('claude-code', undefined)).toBeUndefined();
    expect(rateLimitMentionAccountKey('claude-code', '   ')).toBeUndefined();
    expect(rateLimitMentionAccountKey('claude-code', 'relative/dir')).toBeUndefined();
  });

  it('同一目录经符号链接也归到同一个账号', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlm-key-'));
    try {
      const real = join(root, 'real-home');
      mkdirSync(real);
      const link = join(root, 'link-home');
      symlinkSync(real, link, 'dir');
      expect(rateLimitMentionAccountKey('claude-code', link))
        .toBe(rateLimitMentionAccountKey('claude-code', real));
      expect(rateLimitMentionAccountKey('claude-code', real))
        .not.toBe(rateLimitMentionAccountKey('codex', real));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

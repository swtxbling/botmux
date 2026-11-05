// test/restore-cwd-flag.test.ts
//
// Behaviour of the boot-time working-directory verdict
// (`Session.restoreCwdUnverifiedAt`) on the recovery paths that run AFTER
// startup: the inbound-turn guard, flag clearing, and the close-time snapshot.
//
// Regression context: the boot probe (restore-cwd-probe.ts) can only tell us a
// directory was unreadable/hung at boot. The fork paths (`forkWorker`,
// `forkAdoptWorker`) check existence SYNCHRONOUSLY, and `/close` samples token
// usage through a synchronous `realpathSync` transcript lookup. A flagged row
// must therefore be re-checked out of process before a turn, refused with a
// human-readable explanation when still unreachable, and must skip the
// close-time scan (which would freeze the daemon `/close` is meant to rescue).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
    daemon: { workingDir: '~' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Counts transcript-based token snapshots without touching the filesystem.
const tokenSnapshots = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/core/cost-calculator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/cost-calculator.js')>();
  return {
    ...actual,
    getSessionTokenUsage: vi.fn(() => {
      tokenSnapshots.count += 1;
      return null;
    }),
  };
});

import * as sessionStore from '../src/services/session-store.js';
import {
  clearRestoreCwdUnverified,
  guardFlaggedSessionTurn,
  markRestoreCwdUnverified,
  verifyRestoreCwdBeforeUse,
} from '../src/core/restore-cwd-flag.js';
import { logger } from '../src/utils/logger.js';

const hangingProbe = (): Promise<void> => new Promise<void>(() => {});

function makeSession(): sessionStore.Session {
  return sessionStore.createSession('oc_chat1', `om_${Math.random()}`, 'Topic', 'group');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-restore-cwd-flag-'));
  sessionStore.init('app_test');
  tokenSnapshots.count = 0;
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  try { sessionStore.closeDatabase(); } catch { /* not open */ }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('guardFlaggedSessionTurn', () => {
  it('lets an unflagged session through without probing', async () => {
    const session = makeSession();
    const probe = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    await expect(guardFlaggedSessionTurn(session, { cwd: '/tmp', probe, reply }))
      .resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('refuses a still-unreachable directory, tells the human which directory and what to do, and keeps the flag', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    sessionStore.updateSession(session);
    const reply = vi.fn(async () => {});

    await expect(guardFlaggedSessionTurn(session, {
      cwd: '/hung/mount/project',
      probe: hangingProbe,
      timeoutMs: 25,
      reply,
    })).resolves.toBe(false);

    expect(reply).toHaveBeenCalledTimes(1);
    const text = String(reply.mock.calls[0]![0]);
    expect(text).toContain('/hung/mount/project');
    expect(text).toContain('暂时读不到');
    expect(text).toContain('/repo');
    expect(text).toContain('/cd');
    expect(session.restoreCwdUnverifiedAt).toBeDefined();
    expect(sessionStore.getSession(session.sessionId)?.restoreCwdUnverifiedAt).toBeDefined();
  });

  it('proceeds and clears the persisted flag once the directory answers', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    sessionStore.updateSession(session);
    const reply = vi.fn(async () => {});

    await expect(guardFlaggedSessionTurn(session, {
      cwd: '/now/readable',
      probe: async () => {},
      reply,
    })).resolves.toBe(true);

    expect(reply).not.toHaveBeenCalled();
    expect(session.restoreCwdUnverifiedAt).toBeUndefined();
    expect(sessionStore.getSession(session.sessionId)?.restoreCwdUnverifiedAt).toBeUndefined();
  });

  it('still refuses (instead of throwing) when the notice cannot be sent', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    await expect(guardFlaggedSessionTurn(session, {
      cwd: '/hung',
      probe: hangingProbe,
      timeoutMs: 20,
      reply: async () => { throw new Error('lark down'); },
    })).resolves.toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.some(call => String(call[0]).includes('notice'))).toBe(true);
  });
});

describe('verifyRestoreCwdBeforeUse / clearRestoreCwdUnverified', () => {
  it('reports a missing directory without clearing the flag', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    const result = await verifyRestoreCwdBeforeUse(session, '/gone', {
      probe: async () => {
        const error = new Error('no such directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    expect(result.ok).toBe(false);
    expect(session.restoreCwdUnverifiedAt).toBeDefined();
  });

  it('clears the flag exactly once when the directory is verified', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    expect(clearRestoreCwdUnverified(session)).toBe(true);
    expect(clearRestoreCwdUnverified(session)).toBe(false);
    expect(sessionStore.getSession(session.sessionId)?.restoreCwdUnverifiedAt).toBeUndefined();
  });
});

describe('closeSession on a flagged row', () => {
  it('skips the synchronous transcript snapshot for a flagged session', async () => {
    const session = makeSession();
    markRestoreCwdUnverified(session);
    sessionStore.updateSession(session);

    sessionStore.closeSession(session.sessionId);

    expect(tokenSnapshots.count).toBe(0);
    expect(sessionStore.getSession(session.sessionId)?.status).toBe('closed');
  });

  it('still takes the snapshot for an ordinary session', () => {
    const session = makeSession();
    sessionStore.closeSession(session.sessionId);
    expect(tokenSnapshots.count).toBe(1);
  });
});

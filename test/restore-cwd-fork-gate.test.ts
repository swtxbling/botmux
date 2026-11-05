// test/restore-cwd-fork-gate.test.ts
//
// The single choke point for a session whose boot-time cwd probe timed out.
// Dozens of callers (queued activation, dashboard restart, cards, commands,
// schedulers, internal reforks) reach forkWorker / forkAdoptWorker; every one of
// them used to run `existsSync(cwd)` synchronously, which freezes the whole
// daemon on a hung mount. The fork paths must refuse before touching the cwd,
// kick the out-of-process check in the background, and let the next attempt
// fork normally once the directory answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const fsCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: any) => {
      fsCalls.push(String(path));
      return (actual.existsSync as (p: any) => boolean)(path);
    }),
  };
});

const spawnCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/core/self-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/self-spawn.js')>();
  return {
    ...actual,
    // Reaching a real spawn in a unit test would fork a worker process.
    spawnWorker: vi.fn((options: any) => {
      spawnCalls.push(String(options?.cwd));
      throw new Error('SPAWN_REACHED');
    }),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = vi.fn(async () => ({ code: 0, data: {} }));
    im = { v1: { message: {}, file: {}, chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) } } };
  },
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { forkAdoptWorker, forkWorker, initWorkerPool } from '../src/core/worker-pool.js';
import { MissingWorkingDirError } from '../src/core/working-dir-recovery.js';
import { __resetFlaggedCwdProbeCacheForTests } from '../src/core/restore-cwd-recovery.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'restore_cwd_fork_gate_app';
let home: string;
let dataDir: string;
let cwd: string;
let missingCwd: string;
let sessionReply: ReturnType<typeof vi.fn>;
let onMissingWorkingDir: ReturnType<typeof vi.fn>;

function makeSession(): DaemonSession {
  const stored = sessionStore.createSession('oc_gate', `om_gate_${Date.now()}`, 'Topic', 'group');
  const ds = {
    larkAppId: APP,
    chatId: 'oc_gate',
    chatType: 'group',
    scope: 'thread',
    worker: null,
    workerReady: false,
    session: {
      ...stored,
      larkAppId: APP,
      chatId: 'oc_gate',
      cliId: 'claude-code',
      status: 'active',
      workingDir: cwd,
    },
  } as unknown as DaemonSession;
  sessionStore.updateSession(ds.session);
  return ds;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

beforeEach(() => {
  fsCalls.length = 0;
  spawnCalls.length = 0;
  __resetFlaggedCwdProbeCacheForTests();
  home = mkdtempSync(join(tmpdir(), 'botmux-fork-gate-'));
  dataDir = join(home, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  missingCwd = join(home, 'gone');
  const oldDataDir = config.session.dataDir;
  (config.session as { dataDir: string }).dataDir = dataDir;
  void oldDataDir;
  registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [],
    workingDir: cwd,
  });
  sessionStore.init(APP);
  sessionReply = vi.fn(async () => 'om_reply');
  onMissingWorkingDir = vi.fn();
  initWorkerPool({
    sessionReply,
    onMissingWorkingDir,
    getSessionWorkingDir: () => cwd,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(() => {
  try { sessionStore.closeDatabase(); } catch { /* not open */ }
  rmSync(home, { recursive: true, force: true });
});

describe('forkWorker cwd choke point', () => {
  it('refuses a flagged session without a sync existsSync, then proceeds after the background probe clears the flag', async () => {
    const ds = makeSession();
    ds.session.restoreCwdUnverifiedAt = new Date().toISOString();
    sessionStore.updateSession(ds.session);
    fsCalls.length = 0;

    expect(() => forkWorker(ds, 'hello')).toThrow(MissingWorkingDirError);
    expect(fsCalls).not.toContain(cwd);
    expect(spawnCalls).toHaveLength(0);
    // The freeze-prone missing-dir recovery path (deleted-worktree origin +
    // project-dir scans, all synchronous) must not be entered at all.
    expect(onMissingWorkingDir).not.toHaveBeenCalled();
    const siblings = dirname(cwd);
    // No sync scan over the directory's siblings either (the missing-dir
    // recovery path looks for deleted worktree origins and project dirs there).
    // The only sibling the fork path may legitimately touch is the data dir.
    const outsideDataDir = fsCalls.filter(path =>
      path.startsWith(`${siblings}/`) && path !== dataDir && !path.startsWith(`${dataDir}/`));
    expect(outsideDataDir).toEqual([]);

    // The human gets the plain notice, once per cooldown even if a retry arrives.
    expect(sessionReply).toHaveBeenCalledTimes(1);
    const notice = String(sessionReply.mock.calls[0]![1]);
    expect(notice).toContain(cwd);
    expect(notice).toContain('暂时读不到');
    expect(notice).toContain('/repo');
    expect(notice).toContain('/cd');
    expect(() => forkWorker(ds, 'hello again')).toThrow(MissingWorkingDirError);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // The background child-process probe answers "ok" and clears the persisted flag.
    await waitFor(() => !ds.session.restoreCwdUnverifiedAt);
    expect(sessionStore.getSession(ds.session.sessionId)?.restoreCwdUnverifiedAt).toBeUndefined();

    // Next attempt gets past the gate. Point it at a missing directory so the
    // ordinary refusal (which DOES check synchronously) fires instead of a
    // real worker spawn.
    cwd = missingCwd;
    fsCalls.length = 0;
    expect(() => forkWorker(ds, 'hello')).toThrow(MissingWorkingDirError);
    expect(fsCalls).toContain(missingCwd);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('forkAdoptWorker cwd choke point', () => {
  it('refuses a flagged adopt session without a sync existsSync and without spawning', () => {
    const ds = makeSession();
    ds.adoptedFrom = {
      source: 'tmux',
      tmuxTarget: 'ext:0.0',
      originalCliPid: 111,
      cliId: 'claude-code',
      cwd,
    } as any;
    ds.session.adoptedFrom = ds.adoptedFrom;
    ds.session.restoreCwdUnverifiedAt = new Date().toISOString();
    sessionStore.updateSession(ds.session);
    fsCalls.length = 0;

    expect(forkAdoptWorker(ds)).toBe('rejected');
    expect(fsCalls).not.toContain(cwd);
    expect(spawnCalls).toHaveLength(0);
    expect(onMissingWorkingDir).not.toHaveBeenCalled();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(String(sessionReply.mock.calls[0]![1])).toContain(cwd);
  });
});

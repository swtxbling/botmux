// test/announce-session-row-no-transcript.test.ts
//
// Startup restore announces one dashboard row per restored session BEFORE the
// Feishu dispatchers start. Composing that row must not resolve the session
// transcript: every transcript lookup canonicalizes `workingDir` with a
// SYNCHRONOUS realpath, so an unresponsive directory used to freeze the whole
// daemon (all bots offline). This test proves the announce opt-out is real and
// would catch the flags being dropped again.
import { describe, it, expect, vi } from 'vitest';

const resolverCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/services/transcript-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/transcript-resolver.js')>(
    '../src/services/transcript-resolver.js',
  );
  return {
    ...actual,
    resolveSessionTranscriptPath: (...args: Parameters<typeof actual.resolveSessionTranscriptPath>) => {
      resolverCalls.count += 1;
      return actual.resolveSessionTranscriptPath(...args);
    },
  };
});

import { announceSessionRow } from '../src/core/session-activity.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(): DaemonSession {
  return {
    session: {
      sessionId: 'sess-restore-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'restore row',
      status: 'active',
      createdAt: new Date(1000).toISOString(),
      cliId: 'claude-code',
      workingDir: '/nonexistent-restore-cwd-announce-test',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1000,
    cliVersion: 'test',
    lastMessageAt: 1000,
    hasHistory: true,
    workingDir: '/nonexistent-restore-cwd-announce-test',
  } as DaemonSession;
}

function collectEvents(): DashboardEvent[] {
  const seen: DashboardEvent[] = [];
  const off = dashboardEventBus.subscribe(event => seen.push(event));
  collectEvents.cleanups.push(off);
  return seen;
}
collectEvents.cleanups = [] as Array<() => void>;

describe('announceSessionRow during startup restore', () => {
  it('does not resolve the transcript (working directory) when both scans are opted out', () => {
    resolverCalls.count = 0;
    const seen = collectEvents();
    try {
      announceSessionRow(makeDs(), { includeTokenUsage: false, includeOpenTodos: false });

      expect(resolverCalls.count).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.type).toBe('session.spawned');
      const row = (seen[0] as any).body.session;
      expect(row.sessionId).toBe('sess-restore-1');
      expect(row.tokenUsage).toBeNull();
      expect(row.openTodos).toBeUndefined();
    } finally {
      collectEvents.cleanups.pop()?.();
    }
  });

  it('skips transcript scans for a row whose boot cwd probe timed out', () => {
    resolverCalls.count = 0;
    const ds = makeDs();
    ds.session.restoreCwdUnverifiedAt = new Date().toISOString();
    const seen = collectEvents();
    try {
      // No opts here: the persisted verdict alone must suppress both scans, or a
      // dashboard list/detail/SSE read would run the blocking realpath.
      announceSessionRow(ds);
      expect(resolverCalls.count).toBe(0);
      const row = (seen[0] as any).body.session;
      expect(row.tokenUsage).toBeNull();
      expect(row.openTodos).toBeUndefined();
    } finally {
      collectEvents.cleanups.pop()?.();
    }
  });

  it('control: the same row DOES resolve the transcript without the opt-out', () => {
    resolverCalls.count = 0;
    const seen = collectEvents();
    try {
      announceSessionRow(makeDs());
      // Guards the assertion above: if composeRowFromActive stopped consulting
      // the transcript entirely, the opt-out test would pass vacuously.
      expect(resolverCalls.count).toBeGreaterThan(0);
      expect(seen).toHaveLength(1);
    } finally {
      collectEvents.cleanups.pop()?.();
    }
  });
});

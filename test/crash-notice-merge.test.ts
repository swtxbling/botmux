/**
 * Crash / auto-restart-stopped notice: one plain-language sentence, raw
 * terminal tail folded into a collapsible panel, and notices bound for the
 * same recipient merged inside one short window.
 *
 * Run: npx vitest run --project unit test/crash-notice-merge.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks (mirror crash-loop-diagnostic.test.ts harness) ───────────────────

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

const updateSessionMock = vi.fn();
const sessionReplyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports under test ──────────────────────────────────────────────────────

import {
  initWorkerPool,
  __testOnly_configureCrashNotices,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
  flushPendingCrashNotices,
  restartCounts,
} from '../src/core/worker-pool.js';
import { buildCrashNoticeCard, trimCrashTail, type CrashNoticeEntry } from '../src/core/crash-notice.js';
import { logger } from '../src/utils/logger.js';
import type { DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(
  sessionId: string,
  worker: any,
  opts: { title?: string; chatId?: string; scope?: 'chat' | 'topic'; appId?: string } = {},
): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: `om_root_${sessionId}`,
      chatId: opts.chatId ?? 'oc_chat',
      title: opts.title ?? `Session ${sessionId}`,
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: opts.appId ?? 'app_test',
    chatId: opts.chatId ?? 'oc_chat',
    chatType: 'group',
    ...(opts.scope ? { scope: opts.scope } : {}),
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as DaemonSession;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** Crash until the auto-restart budget is exhausted (4th crash stops it). */
async function crashToStop(worker: any, logTail?: string) {
  for (let i = 0; i < 4; i++) {
    worker.emit('message', { type: 'claude_exit', code: 1, signal: null, canParkDiagnostic: true, logTail });
    await flush();
  }
}

type SentCard = { anchor: string; card: any; msgType: string; raw: string };

function sentCards(): SentCard[] {
  return sessionReplyMock.mock.calls.map((call: any[]) => ({
    anchor: call[0],
    raw: call[1],
    msgType: call[2],
    card: JSON.parse(call[1]),
  }));
}

function panelMarkdown(card: any): string {
  const panel = card.body.elements.find((el: any) => el.tag === 'collapsible_panel');
  return panel ? panel.elements.map((el: any) => el.content).join('\n') : '';
}

/** Wait until at least `n` notices are sent, then let the window settle. */
async function waitForSends(n: number, settleMs = 120): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (sessionReplyMock.mock.calls.length < n && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

describe('crash notice merge and folded terminal tail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations: the failed-send case below installs
    // a rejecting mock, which must not leak into later tests.
    sessionReplyMock.mockReset();
    sessionReplyMock.mockResolvedValue('om_reply');
    restartCounts.clear();
    __testOnly_resetRestartCoordinator();
    __testOnly_configureCrashNotices({ windowMs: 25, retryDelayMs: 5 });
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  it('merges three sessions that share one recipient into a single message naming all of them', async () => {
    const sessions = ['sid-a', 'sid-b', 'sid-c'];
    for (const sid of sessions) {
      const worker = makeFakeWorker();
      const ds = makeDs(sid, worker, { title: `bot-${sid}`, scope: 'chat' });
      __testOnly_setupWorkerHandlers(ds, worker);
      await crashToStop(worker, `TAIL_${sid}_line1\nTAIL_${sid}_line2`);
    }

    await waitForSends(1);

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    const [sent] = sentCards();
    expect(sent.msgType).toBe('interactive');
    // The affected sessions are named in the visible body…
    const bodyText = sent.card.body.elements
      .filter((el: any) => el.tag === 'markdown')
      .map((el: any) => el.content)
      .join('\n');
    for (const sid of sessions) expect(bodyText).toContain(`bot-${sid}`);
    // …and each raw tail only lives inside the folded panel.
    const folded = panelMarkdown(sent.card);
    for (const sid of sessions) {
      expect(folded).toContain(`TAIL_${sid}_line1`);
      expect(bodyText).not.toContain(`TAIL_${sid}_line1`);
    }
  });

  it('single crash still notifies, body first line is the plain sentence and the tail is folded away', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-solo', worker, { title: 'solo-bot', scope: 'chat' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashToStop(worker, 'RAW_TERMINAL_MARKER first\nRAW_TERMINAL_MARKER second');
    await waitForSends(1);

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    const [sent] = sentCards();
    const first = sent.card.body.elements[0];
    expect(first.tag).toBe('markdown');
    expect(first.content).not.toContain('RAW_TERMINAL_MARKER');
    expect(panelMarkdown(sent.card)).toContain('RAW_TERMINAL_MARKER');
  });

  it('does not merge notices that belong to different anchors', async () => {
    const workerA = makeFakeWorker();
    const dsA = makeDs('sid-topic-a', workerA, { title: 'topic-a', scope: 'topic' });
    __testOnly_setupWorkerHandlers(dsA, workerA);

    const workerB = makeFakeWorker();
    const dsB = makeDs('sid-topic-b', workerB, { title: 'topic-b', scope: 'topic' });
    __testOnly_setupWorkerHandlers(dsB, workerB);

    await crashToStop(workerA, 'TAIL_A');
    await crashToStop(workerB, 'TAIL_B');
    await waitForSends(2);

    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    const cards = sentCards();
    expect(cards[0].card.body.elements[0].content).toContain('Claude');
    expect(panelMarkdown(cards[0].card)).toContain('TAIL_A');
    expect(panelMarkdown(cards[0].card)).not.toContain('TAIL_B');
    expect(panelMarkdown(cards[1].card)).toContain('TAIL_B');
  });

  it('reports a failed send instead of dropping the notice silently', async () => {
    sessionReplyMock.mockRejectedValue(new Error('feishu down'));
    const worker = makeFakeWorker();
    const ds = makeDs('sid-fail', worker, { title: 'fail-bot', scope: 'chat' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashToStop(worker, 'TAIL_FAIL');
    await waitForSends(0, 60);

    // One immediate attempt + one retry…
    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
    // …and the loss is on the record, naming the session.
    const logged = vi.mocked(logger.error).mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('sid-fail');
  });

  it('flushes queued notices on shutdown instead of losing the merge window', async () => {
    __testOnly_configureCrashNotices({ windowMs: 5_000, retryDelayMs: 5 });
    const worker = makeFakeWorker();
    const ds = makeDs('sid-shutdown', worker, { title: 'shutdown-bot', scope: 'chat' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashToStop(worker, 'TAIL_SHUTDOWN');
    expect(sessionReplyMock).not.toHaveBeenCalled(); // still inside the window

    await flushPendingCrashNotices();

    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(panelMarkdown(sentCards()[0].card)).toContain('TAIL_SHUTDOWN');
  });

  it('drops a queued notice when its session left the state it crashed in', async () => {
    __testOnly_configureCrashNotices({ windowMs: 5_000, retryDelayMs: 5 });
    const worker = makeFakeWorker();
    const ds = makeDs('sid-closed-in-window', worker, { title: 'closed-bot', scope: 'chat' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashToStop(worker, 'TAIL_CLOSED');
    // The user closes the session while the notice sits in its merge window.
    ds.session.status = 'idle' as any;
    await flushPendingCrashNotices();

    expect(sessionReplyMock).not.toHaveBeenCalled();
    const warned = vi.mocked(logger.warn).mock.calls.map(call => String(call[0])).join('\n');
    expect(warned).toContain('sid-closed-in-window');
  });
});

describe('crash notice card rendering', () => {
  const entry = (patch: Partial<CrashNoticeEntry> = {}): CrashNoticeEntry => ({
    sessionId: 'sid',
    sessionLabel: 'my-session',
    cliName: 'Claude',
    reason: 'crash_loop',
    count: 4,
    ...patch,
  });

  it('keeps a long terminal tail bounded', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n');
    const trimmed = trimCrashTail(long)!;
    expect(trimmed.split('\n').length).toBeLessThanOrEqual(20);
    expect(trimmed.endsWith('line-199')).toBe(true);
  });

  it('always leads with the plain sentence, never with terminal output', () => {
    const card = buildCrashNoticeCard([entry({ logTail: 'PANIC raw output' })]);
    expect(card.body.elements[0].content).not.toContain('PANIC');
    expect(card.body.elements[0].content).toContain('Claude');
    const panel: any = card.body.elements.find(el => el.tag === 'collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.elements[0].content).toContain('PANIC');
  });
  it('budgets the folded tails in bytes, so CJK output cannot overflow the card', () => {
    const cjk = '终端报错信息'.repeat(400); // 2400 chars ≈ 7.2KB of UTF-8
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ sessionId: `s${i}`, sessionLabel: `会话-${i}`, logTail: cjk }));
    const card = buildCrashNoticeCard(entries);
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    expect(bytes).toBeLessThanOrEqual(20_000);
    const panel: any = card.body.elements.find((el: any) => el.tag === 'collapsible_panel');
    const omitted = panel.elements.some((el: any) =>
      typeof el.content === 'string' && /另有 \d+ 个会话的终端输出未展开/.test(el.content));
    expect(omitted).toBe(true);
  });

  it('lists at most 20 sessions and counts the rest', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry({ sessionId: `cap-${i}`, sessionLabel: `cap-${i}` }));
    const card = buildCrashNoticeCard(entries);
    const listText = String(card.body.elements[1]?.content ?? '');
    expect(listText).toContain('cap-19');
    expect(listText).not.toContain('cap-20');
    expect(card.body.elements.some((el: any) =>
      typeof el.content === 'string' && el.content.includes('10 个会话'))).toBe(true);
  });

  it('cannot be broken by a fence or markdown inside a label or terminal tail', () => {
    const card = buildCrashNoticeCard([entry({
      sessionLabel: 'bad`label **x**',
      logTail: 'before\n```\ninjected',
    })]);
    const panel: any = card.body.elements.find((el: any) => el.tag === 'collapsible_panel');
    const content = String(panel.elements[0].content);
    expect(content).toContain('bad\\`label');
    expect(content).toMatch(/^`{4,}$/m); // fence longer than the ``` inside the tail
  });
});

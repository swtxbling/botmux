/**
 * Ordinary IM delivery × worker exit: one automatic replay, never a second.
 *
 * THE BUG: when a worker died after the daemon queued a turn into its IPC
 * channel but before the worker acknowledged receipt, the user got a
 * "cannot confirm ... do not resend" notice and nothing else. When `child.send`
 * never even completed, the turn provably never left the daemon — that case can
 * be replayed safely.
 *
 * This suite drives the REAL exit settlement path (`__testOnly_setupWorkerHandlers`
 * + `worker.emit('exit')`) and records the replay action through the module
 * seam, so the guards are exercised as they run in production:
 *   - transport never confirmed → replay exactly once, persisted mark set;
 *   - transport confirmed (worker may have read it) → no replay, ambiguous notice;
 *   - worker receipt seen (worker definitely read it) → no replay, ambiguous notice;
 *   - mark already persisted for this turn → no replay, "not delivered" notice.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', locale: 'en' },
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
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
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

import {
  __testOnly_redeliverOrdinaryImOnFreshWorker,
  __testOnly_resetOrdinaryImDeliveries,
  __testOnly_setOrdinaryImAutoRedeliver,
  __testOnly_setReplayForkWorker,
  __testOnly_setupWorkerHandlers,
  initWorkerPool,
  ORDINARY_IM_AUTO_REDELIVERY_MARK_LIMIT,
  restartCounts,
  sendWorkerInput,
} from '../src/core/worker-pool.js';
import {
  MissingWorkingDirError,
  UnverifiedWorkingDirError,
} from '../src/core/working-dir-recovery.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  decideOrdinaryImRedelivery,
  isProvablyUndeliveredOrdinaryIm,
  ORDINARY_IM_REPLAYABLE_REASON,
} from '../src/services/ordinary-im-redelivery.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import { messages as enMessages } from '../src/i18n/en.js';

const sessionReplyMock = vi.fn(async () => 'om_reply');

function makeFakeWorker(
  options: { confirmTransport?: boolean; confirmFirstOnly?: boolean; manualTransport?: boolean } = {},
) {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.connected = true;
  worker.sentCallbacks = [] as ((err: Error | null) => void)[];
  let sends = 0;
  worker.send = options.manualTransport
    ? vi.fn((_msg: unknown, cb?: (err: Error | null) => void) => { if (cb) worker.sentCallbacks.push(cb); })
    : options.confirmTransport
      ? vi.fn((_msg: unknown, cb?: (err: Error | null) => void) => { cb?.(null); })
      : options.confirmFirstOnly
        ? vi.fn((_msg: unknown, cb?: (err: Error | null) => void) => { if (++sends === 1) cb?.(null); })
        : vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(worker: any, sessionId: string): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Replay',
      status: 'active',
      createdAt: new Date('2026-11-06T00:00:00.000Z').toISOString(),
      chatType: 'group',
      cliId: 'claude-code',
      workingDir: '/repo',
      workerGeneration: 1,
    },
    worker,
    workerGeneration: 1,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1,
    cliVersion: '1.0',
    lastMessageAt: 2,
    hasHistory: true,
    workingDir: '/repo',
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Replay',
  } as DaemonSession;
}

// The deferred replay waits ~300ms so late IPC callbacks/ACKs can drain; give
// every assertion room for that plus the timer callback itself.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 400));

/** The pre-ready startup guard also posts its own notice on this harness; keep
 *  this suite's assertions on the DELIVERY notice only. */
function deliveryNotices(): string[] {
  return sessionReplyMock.mock.calls
    .map(call => String(call[1]))
    .filter(text => /Worker execution queue|Worker 的执行队列|never reached the CLI|没有送到 CLI/.test(text));
}

/** The exact text `sessionReply` receives for a delivery notice in this suite's
 * locale (the bot mock resolves to `zh`). Read from the message catalogue so the
 * assertions follow wording changes instead of pinning sentences. */
function renderedNotice(
  key: 'worker.input_not_delivered' | 'worker.input_delivery_failed',
  turnId: string,
): string {
  return zhMessages[key].replace('{turnId}', turnId.substring(0, 16));
}

describe('ordinary IM auto-redelivery (worker exit settlement)', () => {
  let replay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    restartCounts.clear();
    __testOnly_resetOrdinaryImDeliveries();
    replay = vi.fn(() => 'started' as const);
    __testOnly_setOrdinaryImAutoRedeliver(replay as any);
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  afterEach(() => {
    __testOnly_resetOrdinaryImDeliveries();
    __testOnly_setOrdinaryImAutoRedeliver(undefined);
  });

  it('replays the exact turn once when IPC transport was never confirmed', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-redeliver');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'hello' }, 'om_lost_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0][0].turnId).toBe('om_lost_1');
    expect(replay.mock.calls[0][0].message).toMatchObject({ type: 'message', content: 'hello' });
    // The mark must already be on the session when the replay runs: this is
    // what stops a daemon restart or a second exit from replaying again.
    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_lost_1']);
    expect(updateSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      ordinaryImAutoRedelivery: {
        turnIds: ['om_lost_1'],
        attemptedAt: expect.any(String),
      },
    }));
    expect(deliveryNotices()).toEqual([]);
  });

  it('does not replay when IPC transport was confirmed (the worker may have read it)', async () => {
    const worker = makeFakeWorker({ confirmTransport: true });
    const ds = makeDs(worker, 'sid-ambiguous');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'maybe ran' }, 'om_ambiguous_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    expect(ds.session.ordinaryImAutoRedelivery).toBeUndefined();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/could not confirm|无法确认/);
  });

  it('stays safe when an earlier attempt confirmed transport but a later retry reset the flags', async () => {
    // Attempt 1 entered the worker's IPC channel, then the worker rejected the
    // turn pre-admission and the tracker started attempt 2 fresh. The reset must
    // not erase the fact that attempt 1's bytes were already in the channel.
    const worker = makeFakeWorker({ confirmFirstOnly: true });
    const ds = makeDs(worker, 'sid-sticky');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'may have been read' }, 'om_sticky_1')).toBe(true);
    worker.emit('message', {
      type: 'turn_input_rejected',
      turnId: 'om_sticky_1',
      reason: 'session_busy',
      rejectedBeforeAdmission: true,
    });
    await flush();

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    expect(ds.session.ordinaryImAutoRedelivery).toBeUndefined();
    expect(deliveryNotices()).toHaveLength(1);
  });

  it('does not replay when the worker had already acknowledged receipt', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-received');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'worker read it' }, 'om_received_1')).toBe(true);
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_received_1' });

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    expect(ds.session.ordinaryImAutoRedelivery).toBeUndefined();
    expect(deliveryNotices()).toHaveLength(1);
  });

  it('does not replay twice for the same turn: a persisted mark sends the human the safe next step', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-already-retried');
    ds.session.ordinaryImAutoRedelivery = {
      turnIds: ['om_retried_1'],
      attemptedAt: '2026-11-06T00:00:00.000Z',
    };
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'retry me' }, 'om_retried_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });

  it('does not replay when the dead worker receipt ACK lands after exit', async () => {
    // `exit` is emitted before the child's last IPC frames are necessarily
    // dispatched: the worker's own receipt ACK can still land after the exit
    // settlement removed the record. Ignoring it would let the deferred timer
    // replay a turn the CLI already holds — a double execution.
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-late-ack');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'acked late' }, 'om_late_ack_1')).toBe(true);

    worker.emit('exit', 1, null);
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_late_ack_1' });
    await flush();

    expect(replay).not.toHaveBeenCalled();
    // The mark is written before the replay is armed, so the spent retry stays
    // recorded even though the replay itself was cancelled.
    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_late_ack_1']);
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(renderedNotice('worker.input_delivery_failed', 'om_late_ack_1'));
  });

  it('does not tell the user to resend when a late receipt ACK lands after the retry was spent', async () => {
    // With a persisted mark the settlement used to speak synchronously at exit
    // ("did not run, just resend") before the dying worker's last frames could
    // drain. Both the notice choice and the wording now wait for that window.
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-late-ack-marked');
    ds.session.ordinaryImAutoRedelivery = {
      turnIds: ['om_late_ack_marked_1'],
      attemptedAt: '2026-11-06T00:00:00.000Z',
    };
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'already retried' }, 'om_late_ack_marked_1')).toBe(true);

    worker.emit('exit', 1, null);
    worker.emit('message', { type: 'turn_input_received', turnId: 'om_late_ack_marked_1' });
    await flush();

    expect(replay).not.toHaveBeenCalled();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(renderedNotice('worker.input_delivery_failed', 'om_late_ack_marked_1'));
    expect(notices[0]).not.toBe(renderedNotice('worker.input_not_delivered', 'om_late_ack_marked_1'));
  });

  it('still says the earlier copy did not run when no late ACK arrives', async () => {
    // The grace window must not turn every already-retried settlement into the
    // vague wording: without a receipt ACK the proof still holds, and the user
    // may simply resend. Once the window closed, a late ACK changes nothing.
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-no-late-ack');
    ds.session.ordinaryImAutoRedelivery = {
      turnIds: ['om_no_late_ack_1'],
      attemptedAt: '2026-11-06T00:00:00.000Z',
    };
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'no ack' }, 'om_no_late_ack_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(renderedNotice('worker.input_not_delivered', 'om_no_late_ack_1'));

    worker.emit('message', { type: 'turn_input_received', turnId: 'om_no_late_ack_1' });
    await flush();
    expect(deliveryNotices()).toHaveLength(1);
  });

  it('treats a late success callback from an earlier attempt as possibly delivered', async () => {
    // Attempt 1's child.send enters the worker's IPC channel but its callback
    // arrives after the 2s timeout already started attempt 2 (which reset the
    // per-attempt flags). If the sticky flag were only written for the CURRENT
    // attempt, the reset would erase the fact that attempt 1's bytes were in
    // the channel, and the exit would replay a turn the worker may have run.
    vi.useFakeTimers();
    try {
      const worker = makeFakeWorker({ manualTransport: true });
      const ds = makeDs(worker, 'sid-late-cb');
      __testOnly_setupWorkerHandlers(ds, worker);
      expect(sendWorkerInput(ds, { content: 'late callback' }, 'om_late_cb_1')).toBe(true);

      await vi.advanceTimersByTimeAsync(2_100); // attempt 1 times out → attempt 2
      expect(worker.send).toHaveBeenCalledTimes(2);
      worker.sentCallbacks[0](null); // attempt 1's success, too late for its own slot

      worker.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(400);

      expect(replay).not.toHaveBeenCalled();
      expect(ds.session.ordinaryImAutoRedelivery).toBeUndefined();
      const notices = deliveryNotices();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/could not confirm|无法确认/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay when the one-retry mark cannot be persisted', async () => {
    // Writing the mark BEFORE the replay is the loop guard. If the write fails
    // and the replay still ran, a daemon restart would have no record that the
    // retry was spent and could replay the same turn again.
    updateSessionMock.mockImplementation((session: any) => {
      if (session?.ordinaryImAutoRedelivery?.turnIds?.includes('om_mark_fail_1')) {
        throw new Error('disk full');
      }
    });
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-mark-fail');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'mark fails' }, 'om_mark_fail_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });

  it('does not replay when transport confirmation arrives after exit but before the timer', async () => {
    // `exit` is emitted before the child's last IPC frames are dispatched: a
    // child.send success callback can land after the exit handler returned. The
    // worker may then already hold the turn, so the deferred replay must
    // re-check the record's current facts instead of trusting the settlement.
    const worker = makeFakeWorker({ manualTransport: true });
    const ds = makeDs(worker, 'sid-late-after-exit');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'late after exit' }, 'om_late_after_exit_1')).toBe(true);

    worker.emit('exit', 1, null);
    worker.sentCallbacks[0](null);
    await flush();

    expect(replay).not.toHaveBeenCalled();
    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_late_after_exit_1']);
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/could not confirm|无法确认/);
  });

  it('replays only once even when the exit is settled twice for the same worker', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-double-exit');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'settle twice' }, 'om_double_1')).toBe(true);

    worker.emit('exit', 1, null);
    worker.emit('exit', 1, null);
    await flush();

    expect(replay).toHaveBeenCalledTimes(1);
    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_double_1']);
  });

  it('keeps a mark for every turn a single exit settles, so none un-spends its retry', async () => {
    // One dying worker can leave several ordinary turns unsettled; the exit
    // settlement loop visits them all. A single-slot mark would be overwritten
    // by the second turn and let the first be replayed twice after a crash.
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-two-turns');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'first' }, 'om_two_a')).toBe(true);
    expect(sendWorkerInput(ds, { content: 'second' }, 'om_two_b')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_two_a', 'om_two_b']);
    // Each turn is replayed at most once. (The seam does not spawn a real
    // worker, so the second timer sees no live worker here; in production the
    // first fork would occupy that slot — see the live-worker test below.)
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls.map(call => call[0].turnId)).toEqual(['om_two_a', 'om_two_b']);
  });

  it('does not replay into a session that stopped being active before the timer ran', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-closed-meanwhile');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'closed meanwhile' }, 'om_closed_1')).toBe(true);

    worker.emit('exit', 1, null);
    // A human (or the idle sweeper) closed the session between settlement and
    // the deferred replay: forking now would resurrect a session they closed.
    ds.session.status = 'closed';
    await flush();

    expect(replay).not.toHaveBeenCalled();
    expect(ds.session.ordinaryImAutoRedelivery?.turnIds).toEqual(['om_closed_1']);
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });

  it('does not replay behind a worker that appeared first: the user ordering wins', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-new-worker-first');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'older turn' }, 'om_older_1')).toBe(true);

    worker.emit('exit', 1, null);
    // A later user message, a restore, or a routing transfer spawned a live
    // worker before the deferred replay ran. Replaying the older turn now would
    // invert the user's own order.
    const live = makeFakeWorker();
    live.killed = false;
    ds.worker = live;
    await flush();

    expect(replay).not.toHaveBeenCalled();
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });

  it('still tells the human the safe next step when the replay throws', async () => {
    replay.mockImplementation(() => { throw new Error('fork exploded'); });
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-replay-threw');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'fork exploded' }, 'om_fork_threw_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });

  it('warns ambiguously when the replay is parked behind an admission gate', async () => {
    // forkWorker can accept the turn with admission 'deferred' (queued
    // activation ACK, memory reclaim, device isolation) and still drop it. That
    // is not proof the turn ran or did not run, so the notice must not invite a
    // resend.
    replay.mockReturnValue('deferred' as const);
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-replay-deferred');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'parked behind a gate' }, 'om_deferred_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/could not confirm|无法确认/);
  });

  it('sends the notice when the replay itself could not start a worker', async () => {
    replay.mockReturnValue('failed' as const);
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'sid-replay-failed');
    __testOnly_setupWorkerHandlers(ds, worker);
    expect(sendWorkerInput(ds, { content: 'fork failed' }, 'om_fork_failed_1')).toBe(true);

    worker.emit('exit', 1, null);
    await flush();

    expect(replay).toHaveBeenCalledTimes(1);
    const notices = deliveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not run|没有执行/);
  });
});

describe('ordinary IM redelivery decision', () => {
  const base = {
    turnId: 'om_turn',
    reason: ORDINARY_IM_REPLAYABLE_REASON,
    received: false,
    transportConfirmed: false,
    sessionStatus: 'active',
    priorAutoRedeliveryTurnIds: undefined as readonly string[] | undefined,
  };

  it('replays only the provably undelivered plain owner turn', () => {
    expect(decideOrdinaryImRedelivery(base)).toBe('auto-redeliver');
  });

  it('treats a confirmed transport as possibly received', () => {
    expect(decideOrdinaryImRedelivery({ ...base, transportConfirmed: true })).toBe('notify-human');
    expect(isProvablyUndeliveredOrdinaryIm({ received: false, transportConfirmed: true })).toBe(false);
  });

  it('treats a worker receipt as possibly received', () => {
    expect(decideOrdinaryImRedelivery({ ...base, received: true })).toBe('notify-human');
  });

  it('never replays a turn whose one retry was already spent', () => {
    expect(decideOrdinaryImRedelivery({ ...base, priorAutoRedeliveryTurnIds: ['om_other', 'om_turn'] })).toBe('notify-human');
  });

  it('never replays a turn whose ingress never even attempted transport', () => {
    // attempt === 0 is the standalone-binary bootstrap path: ingress already
    // told the user to resend, so a replay would duplicate that advice.
    expect(decideOrdinaryImRedelivery({ ...base, attempt: 0 })).toBe('notify-human');
    expect(decideOrdinaryImRedelivery({ ...base, attempt: 1 })).toBe('auto-redeliver');
  });

  it('never replays a deliberate retirement or a live-worker retry timeout', () => {
    expect(decideOrdinaryImRedelivery({ ...base, reason: 'worker_retired_before_commit' })).toBe('notify-human');
    expect(decideOrdinaryImRedelivery({ ...base, reason: 'ipc_callback_timeout' })).toBe('notify-human');
    expect(decideOrdinaryImRedelivery({ ...base, reason: 'worker_generation_changed' })).toBe('notify-human');
  });

  it('leaves recovery-chain and dashboard-batch turns to their own durable recovery', () => {
    expect(decideOrdinaryImRedelivery({ ...base, turnId: 'bmx-recovery-x' })).toBe('notify-human');
    expect(decideOrdinaryImRedelivery({ ...base, turnId: 'board:app:7' })).toBe('notify-human');
  });

  it('does not replay into a closing session', () => {
    expect(decideOrdinaryImRedelivery({ ...base, sessionStatus: 'closed' })).toBe('notify-human');
  });

  it('does not fork for a blank payload', () => {
    expect(decideOrdinaryImRedelivery({ ...base, contentEmpty: true })).toBe('notify-human');
  });
});

describe('delivery-failure notices are actionable in both locales', () => {
  it('the proven-undelivered notice says the earlier copy did not run', () => {
    for (const messages of [zhMessages, enMessages]) {
      expect(messages['worker.input_not_delivered']).toBeTruthy();
    }
    expect(zhMessages['worker.input_not_delivered']).toContain('没有执行');
    expect(enMessages['worker.input_not_delivered']).toContain('did not run');
  });

  it('the ambiguous notice names a next step instead of only warning against a resend', () => {
    for (const messages of [zhMessages, enMessages]) {
      const text = messages['worker.input_delivery_failed'];
      expect(text).toMatch(/下一步|Next step/);
    }
  });
});

describe('the real replay action (redeliverOrdinaryImOnFreshWorker)', () => {
  let forkSpy: ReturnType<typeof vi.fn>;
  let admission: 'accepted' | 'deferred' | 'rejected' | undefined;
  let forkResult: boolean;

  const makeRecord = (
    message: any,
    overrides: Record<string, unknown> = {},
  ) => ({
    key: 'k',
    ds: makeDs(makeFakeWorker(), 'sid-real-replay'),
    worker: makeFakeWorker(),
    workerGeneration: 1,
    message,
    turnId: 'om_real_1',
    attempt: 1,
    received: false,
    transportConfirmed: false,
    transportEverConfirmed: false,
    ...overrides,
  }) as any;

  beforeEach(() => {
    admission = 'accepted';
    forkResult = true;
    forkSpy = vi.fn(((ds: any, _payload: any, _resume: any, opts: any) => {
      opts?.onAdmission?.(admission);
      return forkResult;
    }) as any);
    __testOnly_setReplayForkWorker(forkSpy as any);
  });

  afterEach(() => {
    __testOnly_setReplayForkWorker(undefined);
  });

  it('replays a follow-up turn with its exact payload and resumes the conversation', () => {
    const codexAppInput = { text: 'typed' };
    const rerouteEnvelope = { kind: 'reroute' };
    const record = makeRecord({
      type: 'message',
      content: 'follow up',
      codexAppInput,
      rerouteEnvelope,
      trustedCaller: 'ou_caller',
      trustedController: 'ou_controller',
    });

    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(record)).toBe('started');
    expect(forkSpy).toHaveBeenCalledTimes(1);
    const [forkedDs, payload, resume, opts] = forkSpy.mock.calls[0];
    expect(forkedDs).toBe(record.ds);
    expect(payload).toEqual({
      content: 'follow up',
      codexAppInput,
      rerouteEnvelope,
      trustedCaller: 'ou_caller',
      trustedController: 'ou_controller',
    });
    expect(resume).toEqual({ turnId: 'om_real_1', resume: true, trustedCaller: 'ou_caller' });
    expect(typeof opts.onAdmission).toBe('function');
  });

  it('replays an opening turn as a fresh spawn with the init prompt', () => {
    const record = makeRecord({
      type: 'init',
      prompt: 'opening',
      promptCodexAppInput: { text: 'opening typed' },
    });

    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(record)).toBe('started');
    const [, payload, resume] = forkSpy.mock.calls[0];
    expect(payload).toEqual({ content: 'opening', codexAppInput: { text: 'opening typed' } });
    // An opening turn has no conversation to resume, even with history.
    expect(resume).toEqual({ turnId: 'om_real_1', resume: false });
  });

  it('maps an admission rejection or an immediate false return to a failed replay', () => {
    admission = 'rejected';
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('failed');

    admission = 'accepted';
    forkResult = false;
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('failed');
  });

  it('reports a deferred admission as deferred rather than started', () => {
    admission = 'deferred';
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('deferred');
  });

  it('stays silent when the fork entry already answered a working-dir error', () => {
    // forkWorker's repo picker says "no need to resend" (and the unverified-dir
    // notice says the same): a "resend it" notice on top would contradict it.
    forkSpy.mockImplementation(() => { throw new MissingWorkingDirError('/gone'); });
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('already-reported');

    forkSpy.mockImplementation(() => { throw new UnverifiedWorkingDirError('/gone', 'probe failed'); });
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('already-reported');
  });

  it('still reports any other fork failure as failed', () => {
    forkSpy.mockImplementation(() => { throw new Error('spawn exploded'); });
    expect(__testOnly_redeliverOrdinaryImOnFreshWorker(makeRecord({
      type: 'message', content: 'x',
    }))).toBe('failed');
  });
});

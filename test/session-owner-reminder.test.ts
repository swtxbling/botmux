import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_OWNER_REMINDER_MAX_MENTIONS,
  SessionOwnerReminderController,
  deriveSessionOwnerReminderStates,
  normalizeSessionOwnerReminderConfig,
  sessionOwnerReminderDeliveryUuid,
  type SessionOwnerReminderRecord,
} from '../src/core/session-owner-reminder.js';
import { buildSessionOwnerMention } from '../src/services/session-owner-notification.js';
import {
  loadSessionOwnerReminderRecords,
  saveSessionOwnerReminderRecords,
  sessionOwnerReminderStorePath,
} from '../src/services/session-owner-reminder-store.js';

function session(overrides: Record<string, unknown> = {}): any {
  const base: any = {
    session: {
      sessionId: 's1',
      status: 'active',
      scope: 'thread',
      ownerOpenId: 'ou_owner',
      rootMessageId: 'om_root',
    },
    larkAppId: 'cli_bot',
    chatId: 'oc_chat',
    scope: 'thread',
    worker: { killed: false },
    lastScreenStatus: 'idle',
    lastMessageAt: 1_000,
  };
  return Object.assign(base, overrides);
}

const enabled = {
  enabled: true,
  intervalMinutes: 30,
  text: '请继续跟进。',
  states: ['idle'] as const,
};

describe('session owner reminder configuration', () => {
  it('normalizes a valid per-Bot configuration and rejects unsafe mention markup', () => {
    expect(normalizeSessionOwnerReminderConfig(enabled)).toEqual(enabled);
    expect(normalizeSessionOwnerReminderConfig({
      ...enabled,
      text: '<at user_id="ou_other"></at> ping',
    })).toBeUndefined();
  });

  it('builds the same owner mention used by Locate and a stable cycle delivery id', () => {
    expect(buildSessionOwnerMention('ou_owner')).toBe('<at user_id="ou_owner"></at>');
    expect(buildSessionOwnerMention('ou_owner', '请继续跟进。'))
      .toBe('<at user_id="ou_owner"></at> 请继续跟进。');
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000));
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .not.toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 2_000));
  });
});

describe('session owner reminder state projection', () => {
  it('projects every independently selectable runtime signal', () => {
    const ds = session({
      lastScreenStatus: 'limited',
      tuiPromptCardId: 'om_prompt',
      agentAttention: { kind: 'blocked', reason: 'need input', at: 2_000 },
    });
    expect(deriveSessionOwnerReminderStates(ds)).toEqual([
      'tui_prompt',
      'agent_attention',
      'limited',
    ]);
    // The live TUI-choice producer: a Codex hook-review stuck-warning card.
    expect(deriveSessionOwnerReminderStates(session({ stuckWarningCardId: 'om_stuck' }))).toContain('tui_prompt');
    expect(deriveSessionOwnerReminderStates(session({}))).not.toContain('tui_prompt');
    expect(deriveSessionOwnerReminderStates(session({ worker: null, pendingRepo: true }))).toEqual(['pending_repo']);
    expect(deriveSessionOwnerReminderStates(session({ worker: null, lastScreenStatus: 'limited' }))).toEqual(['dormant']);
  });
});

describe('SessionOwnerReminderController', () => {
  it('waits one interval, repeats, and resets after inbound activity', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();

    await controller.scan([ds], enabled, 10_000);
    await controller.scan([ds], enabled, 10_000 + 30 * 60_000 - 1);
    expect(send).not.toHaveBeenCalled();

    await controller.scan([ds], enabled, 10_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(ds, '请继续跟进。', expect.stringMatching(/^owner-reminder-/));

    await controller.scan([ds], enabled, 10_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);

    ds.lastMessageAt = 10_000 + 61 * 60_000;
    await controller.scan([ds], enabled, 10_000 + 61 * 60_000);
    await controller.scan([ds], enabled, 10_000 + 90 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    await controller.scan([ds], enabled, 10_000 + 91 * 60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('resets the quiet period when any projected runtime state changes', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();
    await controller.scan([ds], enabled, 1_000);
    ds.tuiPromptCardId = 'om_prompt'; // unselected, but still a state transition
    await controller.scan([ds], enabled, 1_000 + 30 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await controller.scan([ds], enabled, 1_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resets the quiet period when a NEW agent_attention instance replaces a resolved one', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['agent_attention'] as const };
    const ds = session({
      lastScreenStatus: 'working',
      lastMessageAt: 0,
      agentAttention: { kind: 'blocked', reason: 'first', at: 0 },
    });
    await controller.scan([ds], cfg, 0);
    // t+29m: the first attention was resolved and a genuinely new one raised
    // (new `.at`). The label is still 'agent_attention', but this is a fresh
    // actionable item — the timer must restart, not inherit the old 29m.
    ds.agentAttention = { kind: 'blocked', reason: 'second', at: 29 * 60_000 };
    await controller.scan([ds], cfg, 30 * 60_000);
    expect(send).not.toHaveBeenCalled(); // reset observed at this scan → fresh timer
    // A full interval after the reset scan (t=30m) → now it fires.
    await controller.scan([ds], cfg, 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resets the quiet period when a NEW tui_prompt card replaces a resolved one', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['tui_prompt'] as const };
    const ds = session({ lastScreenStatus: 'working', lastMessageAt: 0, tuiPromptCardId: 'om_prompt_1' });
    await controller.scan([ds], cfg, 0);
    ds.tuiPromptCardId = 'om_prompt_2'; // old prompt answered, a new one appeared
    await controller.scan([ds], cfg, 30 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await controller.scan([ds], cfg, 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reminds for a pending Codex stuck-warning card and stops once it is resolved', async () => {
    // Regression: the state used to read only tuiPromptCardId, whose sole
    // producer (ScreenAnalyzer) was removed, so selecting it never fired.
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['tui_prompt'] as const };
    const ds = session({ lastScreenStatus: 'working', lastMessageAt: 0, stuckWarningCardId: 'om_stuck_1' });
    await controller.scan([ds], cfg, 0);
    await controller.scan([ds], cfg, 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);

    ds.stuckWarningCardId = 'om_stuck_2'; // first card resolved, a new one posted
    await controller.scan([ds], cfg, 31 * 60_000);
    await controller.scan([ds], cfg, 45 * 60_000);
    expect(send).toHaveBeenCalledTimes(1); // fresh quiet period for the new card

    ds.stuckWarningCardId = undefined; // resolved: nothing left to remind about
    await controller.scan([ds], cfg, 120 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps firing for a STABLE instance and reuses the cycle UUID across a failed retry', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockRejectedValueOnce(new Error('lark down')).mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const cfg = { enabled: true, intervalMinutes: 30, text: 'ping', states: ['agent_attention'] as const };
    // A single, unchanged attention instance (same `.at`) across the whole run.
    const ds = session({
      lastScreenStatus: 'working',
      lastMessageAt: 0,
      agentAttention: { kind: 'blocked', reason: 'stable', at: 0 },
    });
    await controller.scan([ds], cfg, 0);
    await controller.scan([ds], cfg, 30 * 60_000);       // first attempt fails → backs off
    // Backoff = max(60s, min(interval, 5m)) = 5m, so the retry must land after
    // t=35m (the 60s bump alone would still be inside the backoff window).
    await controller.scan([ds], cfg, 35 * 60_000 + 1);   // retry succeeds
    expect(send).toHaveBeenCalledTimes(2);
    // Same cycle (dueBase unchanged by a failed send) + same instance fingerprint
    // ⇒ the failed attempt and its retry MUST carry the identical delivery UUID
    // so Lark's dedupe window suppresses a double @.
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('filters non-thread and unselected states and backs off failed sends', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockRejectedValueOnce(new Error('lark unavailable')).mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const due = session();
    const chatScope = session({ session: { ...session().session, sessionId: 'chat', scope: 'chat' }, scope: 'chat' });
    const working = session({ session: { ...session().session, sessionId: 'working' }, lastScreenStatus: 'working' });

    await controller.scan([due, chatScope, working], enabled, 1_000);
    await controller.scan([due, chatScope, working], enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(records)).toEqual(['s1']);

    await controller.scan([due], enabled, 1_000 + 30 * 60_000 + 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    await controller.scan([due], enabled, 1_000 + 35 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('filters every ineligible session shape and clears records when disabled', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: ds => ds.chatId !== 'http_async_1' && ds.larkAppId !== 'api_only',
    });
    const eligiblePty = session({ backend: { type: 'pty' } });
    const eligibleTmux = session({
      session: { ...session().session, sessionId: 'tmux' },
      backend: { type: 'tmux' },
    });
    const queued = session({ session: { ...session().session, sessionId: 'queued', queued: true } });
    const ownerless = session({ session: { ...session().session, sessionId: 'ownerless', ownerOpenId: undefined } });
    const closed = session({ session: { ...session().session, sessionId: 'closed', status: 'closed' } });
    const noTransport = session({
      session: { ...session().session, sessionId: 'http' },
      chatId: 'http_async_1',
    });
    const apiOnly = session({
      session: { ...session().session, sessionId: 'api' },
      larkAppId: 'api_only',
    });

    const all = [eligiblePty, eligibleTmux, queued, ownerless, closed, noTransport, apiOnly];
    await controller.scan(all, enabled, 1_000);
    await controller.scan(all, enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0].session.sessionId)).toEqual(['s1', 'tmux']);
    expect(Object.keys(records).sort()).toEqual(['s1', 'tmux']);

    await controller.scan(all, { ...enabled, enabled: false }, 1_000 + 31 * 60_000);
    expect(records).toEqual({});
  });

  it('stops @-mentioning after the per-item mention budget is spent', async () => {
    // The old behavior pinged an unchanged idle session forever: every 30m, on
    // every bot, until the owner answered. One item now gets a bounded number of
    // @-mentions, then the reminder goes quiet on its own.
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();
    const start = 1_000;
    const interval = 30 * 60_000;

    await controller.scan([ds], enabled, start);
    for (let tick = 1; tick <= SESSION_OWNER_REMINDER_MAX_MENTIONS; tick++) {
      await controller.scan([ds], enabled, start + tick * interval);
    }
    expect(send).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS);

    // Ten more hours of the SAME unanswered item: no further @, no queue growth.
    for (let tick = SESSION_OWNER_REMINDER_MAX_MENTIONS + 1; tick <= 20; tick++) {
      await controller.scan([ds], enabled, start + tick * interval);
    }
    expect(send).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS);
  });

  it('keeps the spent mention budget across a daemon restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-owner-reminder-cap-'));
    try {
      const load = () => loadSessionOwnerReminderRecords(dir, 'cli_app');
      const save = (next: Record<string, SessionOwnerReminderRecord>) =>
        saveSessionOwnerReminderRecords(dir, 'cli_app', next);
      const first = vi.fn().mockResolvedValue(undefined);
      const before = new SessionOwnerReminderController({ load, save, send: first, canSend: () => true });
      const ds = session();
      const interval = 30 * 60_000;
      await before.scan([ds], enabled, 1_000);
      for (let tick = 1; tick <= SESSION_OWNER_REMINDER_MAX_MENTIONS; tick++) {
        await before.scan([ds], enabled, 1_000 + tick * interval);
      }
      expect(first).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS);

      // Restart: a fresh controller reads the persisted records back from disk.
      const after = vi.fn().mockResolvedValue(undefined);
      const restarted = new SessionOwnerReminderController({ load, save, send: after, canSend: () => true });
      for (let tick = SESSION_OWNER_REMINDER_MAX_MENTIONS + 1; tick <= 10; tick++) {
        await restarted.scan([ds], enabled, 1_000 + tick * interval);
      }
      expect(after).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-arms the mention budget when the item is updated or changes state', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();
    const interval = 30 * 60_000;
    const start = 1_000;
    const spendBudget = async (base: number) => {
      for (let tick = 1; tick <= SESSION_OWNER_REMINDER_MAX_MENTIONS; tick++) {
        await controller.scan([ds], enabled, base + tick * interval);
      }
    };

    await controller.scan([ds], enabled, start);
    await spendBudget(start);
    await controller.scan([ds], enabled, start + 20 * interval);
    expect(send).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS);

    // The owner answers (inbound activity) → fresh cycle, budget re-armed.
    const answeredAt = start + 21 * interval;
    ds.lastMessageAt = answeredAt;
    await controller.scan([ds], enabled, answeredAt);
    await spendBudget(answeredAt);
    expect(send).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS * 2);

    // A runtime state change (a new TUI choice card) also re-arms the budget.
    const changedAt = answeredAt + 20 * interval;
    ds.tuiPromptCardId = 'om_prompt_after_update';
    await controller.scan([ds], enabled, changedAt);
    await spendBudget(changedAt);
    expect(send).toHaveBeenCalledTimes(SESSION_OWNER_REMINDER_MAX_MENTIONS * 3);
  });

  it('sends one reminder per due item per tick, never one per matching state', async () => {
    // Two sessions become due on the same tick: each thread gets exactly one
    // reminder for the cycle, not one per configured state it happens to match.
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const bothStates = { ...enabled, states: ['idle', 'agent_attention'] as const };
    const a = session();
    const b = session({
      session: { ...session().session, sessionId: 's2', rootMessageId: 'om_root_2' },
      agentAttention: { kind: 'blocked', reason: 'need input', at: 500 },
    });
    // `a` matches both configured states; it must still produce ONE message.
    a.agentAttention = { kind: 'blocked', reason: 'also waiting', at: 600 };

    const interval = 30 * 60_000;
    await controller.scan([a, b], bothStates, 1_000);
    await controller.scan([a, b], bothStates, 1_000 + interval);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0].session.rootMessageId).sort()).toEqual(['om_root', 'om_root_2']);
  });
});

describe('session owner reminder durable store', () => {
  it('round-trips valid records with private permissions and ignores corrupt input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-owner-reminder-'));
    try {
      const records = {
        s1: {
          sessionId: 's1',
          stateFingerprint: 'idle',
          actionableSince: 1_000,
          lastObservedActivityAt: 900,
          lastRemindedAt: 2_000,
          mentionCount: 2,
        },
      };
      saveSessionOwnerReminderRecords(dir, 'cli_app', records);
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual(records);
      expect(readFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), 'utf8')).toContain('"stateFingerprint": "idle"');

      writeFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), '{broken');
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

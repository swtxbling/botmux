/**
 * The failure card from `turn_terminal` and the worker's `user_notify` used to
 * be fire-once: with Feishu unreachable they were logged and dropped, and the
 * failed turn stayed silent after recovery (10-31 DNS outage). These cases pin
 * the durable behaviour the two now share with the recovery notice outbox:
 *
 *  - ENOTFOUND at the first sends → exactly one notice lands once Feishu is
 *    back, all attempts carrying the same Feishu uuid;
 *  - a restart resumes a pending notice and never re-sends a delivered one;
 *  - an unknown-outcome retry stays inside Feishu's uuid window and, past it,
 *    is abandoned instead of risking a duplicate;
 *  - a closed session is not posted into and resumes on re-attach;
 *  - duplicate events dedup by (turn, kind[, content]); the list stays bounded.
 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_NOTICE_UUID_WINDOW_MS,
  RecoveryNoticeOutbox,
  type RecoveryNoticeHost,
} from '../src/services/ordinary-recovery-notice.js';
import {
  MAX_TURN_NOTICES,
  createTurnFailureCardNotice,
  createUserNotifyNotice,
  recordAndDeliverTurnNotice,
  upsertTurnNotice,
  type TurnNoticeRecord,
} from '../src/services/turn-notice.js';

/** Deterministic timers: `advance` runs every due callback in time order. */
function fakeClock(start = Date.parse('2026-10-31T04:11:30.000Z')) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    schedule: (delayMs: number, run: () => void) => {
      const id = ++seq;
      timers.set(id, { at: now + delayMs, run });
      return id;
    },
    cancel: (id: number) => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = until;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

function unreachable(): Error {
  return Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });
}

/** One daemon process: the real outbox over a session object whose every write
 *  is mirrored into a durable row (the restart tests re-read that row). */
function daemon(
  clock: Clock,
  opts: {
    send: (record: TurnNoticeRecord) => Promise<string | undefined>;
    row?: any;
    canDeliver?: () => boolean;
  },
) {
  const session: any = opts.row ? structuredClone(opts.row) : { sessionId: 'sess-1', turnNotices: [] };
  const store: { row?: any } = {};
  const persist = () => { store.row = structuredClone(session); };
  persist();
  const outbox = new RecoveryNoticeOutbox<number, TurnNoticeRecord>({
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
    keyOf: record => record.noticeKey,
  });
  const host: RecoveryNoticeHost<TurnNoticeRecord> = {
    key: session.sessionId,
    list: () => session.turnNotices ?? [],
    update: (noticeKey, mutate) => {
      const record = session.turnNotices?.find((r: TurnNoticeRecord) => r.noticeKey === noticeKey);
      if (!record) return undefined;
      mutate(record);
      persist();
      return record;
    },
    send: record => opts.send(record),
    canDeliver: opts.canDeliver ?? (() => true),
  };
  const deliver = (record: TurnNoticeRecord) => recordAndDeliverTurnNotice({
    record,
    host,
    outbox,
    saveList: list => { session.turnNotices = list; persist(); },
  });
  return { session, store, outbox, host, deliver };
}

describe('durable turn notices', () => {
  it('Feishu unreachable for the first sends: exactly one card lands once it recovers', async () => {
    const clock = fakeClock();
    let failuresLeft = 3;
    const attempts: string[] = [];
    const delivered: TurnNoticeRecord[] = [];
    const { session, deliver } = daemon(clock, {
      send: async record => {
        attempts.push(record.delivery.uuid);
        if (failuresLeft-- > 0) throw unreachable();
        delivered.push(structuredClone(record));
        return 'om_card_1';
      },
    });
    const notice = createTurnFailureCardNotice({
      turnId: 'om_turn_1', card: '{"type":"card"}', now: clock.now(), uuid: () => 'uuid-fixed',
    });
    await deliver(notice).delivery;

    expect(session.turnNotices).toHaveLength(1);
    expect(session.turnNotices[0].delivery.state).toBe('pending');

    // 30s + 60s + 120s: the third retry lands.
    await clock.advance(30_000);
    await clock.advance(60_000);
    await clock.advance(120_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.content).toBe('{"type":"card"}');
    expect(session.turnNotices[0].delivery.state).toBe('delivered');
    expect(session.turnNotices[0].delivery.attempts).toBe(4);
    // Every retry of an unconfirmed send must reuse the one Feishu uuid.
    expect(new Set(attempts).size).toBe(1);
    expect(attempts[0]).toBe('uuid-fixed');
  });

  it('a restart resumes a pending notice and never re-sends a delivered one', async () => {
    const clock = fakeClock();
    let feishuUp = false;
    const delivered: string[] = [];
    const send = async (record: TurnNoticeRecord) => {
      if (!feishuUp) throw unreachable();
      delivered.push(record.noticeKey);
      return 'om_user_notify_1';
    };
    const first = daemon(clock, { send });
    await first.deliver(createUserNotifyNotice({
      turnId: 'om_turn_2', message: '输入没有提交，请重试', now: clock.now(),
    })).delivery;
    expect(first.session.turnNotices[0].delivery.state).toBe('pending');

    // Restart before the retry fired: the old process (and its timers) dies,
    // the new one reads the durable row.
    first.outbox.disposeHost(first.host.key);
    feishuUp = true;
    const second = daemon(clock, { send, row: first.store.row });
    second.outbox.resume(second.host);
    await clock.advance(30_000);
    expect(delivered).toHaveLength(1);
    expect(second.session.turnNotices[0].delivery.state).toBe('delivered');

    // A second restart must find nothing pending and stay silent.
    second.outbox.disposeHost(second.host.key);
    const third = daemon(clock, { send, row: second.store.row });
    third.outbox.resume(third.host);
    await clock.advance(24 * 60 * 60 * 1000);
    expect(delivered).toHaveLength(1);
  });

  it('an unknown-outcome retry keeps one uuid and is abandoned past the uuid window', async () => {
    const clock = fakeClock();
    const uuids: string[] = [];
    const { session, deliver } = daemon(clock, {
      // Not a provably-never-landed failure: the request may have reached Feishu.
      send: async record => { uuids.push(record.delivery.uuid); throw new Error('socket hang up'); },
    });
    await deliver(createTurnFailureCardNotice({
      turnId: 'om_turn_3', card: '{"type":"card"}', now: clock.now(), uuid: () => 'uuid-ambiguous',
    })).delivery;
    await clock.advance(RECOVERY_NOTICE_UUID_WINDOW_MS + 60 * 60 * 1000);

    const record = session.turnNotices[0];
    expect(record.delivery.state).toBe('abandoned');
    // Retries stopped at the window edge instead of risking a second card.
    expect(uuids.length).toBeGreaterThan(1);
    expect(new Set(uuids)).toEqual(new Set(['uuid-ambiguous']));
    expect(session.turnNotices[0].delivery.attempts).toBeLessThan(15);
  });

  it('a duplicate terminal/notice does not create a second record or send', async () => {
    const clock = fakeClock();
    const sent: string[] = [];
    const { session, deliver } = daemon(clock, {
      send: async record => { sent.push(record.content); return 'om_1'; },
    });
    const card = () => createTurnFailureCardNotice({
      turnId: 'om_turn_4', card: '{"type":"card"}', now: clock.now(),
    });
    await deliver(card()).delivery;
    const again = await deliver(card()).delivery;
    await again;
    expect(sent).toHaveLength(1);
    expect(session.turnNotices).toHaveLength(1);

    // A distinct user_notify in the same turn is a different notice; an
    // identical re-emit is the same one.
    const notify = (message: string) => createUserNotifyNotice({ turnId: 'om_turn_4', message, now: clock.now() });
    await deliver(notify('A')).delivery;
    await deliver(notify('A')).delivery;
    await deliver(notify('B')).delivery;
    expect(sent).toHaveLength(3);
    expect(session.turnNotices).toHaveLength(3);
  });

  it('does not post into a session that closed meanwhile; resumes when it is deliverable again', async () => {
    const clock = fakeClock();
    let open = false;
    const sent: string[] = [];
    const { session, outbox, host, deliver } = daemon(clock, {
      send: async record => { sent.push(record.content); return 'om_1'; },
      canDeliver: () => open,
    });
    await deliver(createUserNotifyNotice({ turnId: 'om_turn_5', message: '提示', now: clock.now() })).delivery;
    expect(sent).toHaveLength(0);
    expect(session.turnNotices[0].delivery.state).toBe('pending');

    // The timer that would have fired sees the same closed session and stops.
    await clock.advance(60_000);
    expect(sent).toHaveLength(0);

    // Re-attached (same durable row) and deliverable: the pending notice lands.
    open = true;
    outbox.resume(host);
    await clock.advance(60_000);
    expect(sent).toHaveLength(1);
    expect(session.turnNotices[0].delivery.state).toBe('delivered');
  });

  it('persists the record before the first send', async () => {
    const clock = fakeClock();
    const order: string[] = [];
    const { session, host, outbox } = daemon(clock, {
      send: async record => { order.push(`send:${record.noticeKey}`); return 'om_1'; },
    });
    const record = createTurnFailureCardNotice({ turnId: 'om_turn_6', card: '{}', now: clock.now() });
    recordAndDeliverTurnNotice({
      record,
      host,
      outbox,
      saveList: list => { order.push('persist'); session.turnNotices = list; },
    });
    await clock.advance(0);
    // A crash between the two must not lose a notice the daemon promised to
    // send: the durable row has it before Feishu sees it.
    expect(order).toEqual([`persist`, `send:${record.noticeKey}`]);
  });

  it('a re-emitted notice after a restart dedups against the durable record', async () => {
    const clock = fakeClock();
    const sent: string[] = [];
    const send = async (record: TurnNoticeRecord) => { sent.push(record.noticeKey); return 'om_1'; };
    const first = daemon(clock, { send });
    await first.deliver(createUserNotifyNotice({
      turnId: 'om_turn_7', message: '提示', now: clock.now(),
    })).delivery;
    expect(sent).toHaveLength(1);

    // Restart, then the worker replays the same event: the key is found in the
    // durable row, so nothing is posted twice.
    first.outbox.disposeHost(first.host.key);
    const second = daemon(clock, { send, row: first.store.row });
    const again = await second.deliver(createUserNotifyNotice({
      turnId: 'om_turn_7', message: '提示', now: clock.now(),
    })).delivery;
    await again;
    await clock.advance(24 * 60 * 60 * 1000);
    expect(sent).toHaveLength(1);
    expect(second.session.turnNotices).toHaveLength(1);
  });

  it('the persisted list stays bounded: settled records go before pending ones', () => {
    const now = Date.now();
    let list: TurnNoticeRecord[] = [];
    for (let i = 0; i < MAX_TURN_NOTICES; i++) {
      const record = createUserNotifyNotice({ turnId: `om_${i}`, message: `m${i}`, now });
      list = upsertTurnNotice(list, record).list;
    }
    expect(list).toHaveLength(MAX_TURN_NOTICES);
    // A new notice evicts a settled one, not a pending one.
    list = list.map((record, i) => i === 0
      ? { ...record, delivery: { ...record.delivery, state: 'delivered' as const } }
      : record);
    const fresh = createUserNotifyNotice({ turnId: 'om_new', message: 'new', now });
    list = upsertTurnNotice(list, fresh).list;
    expect(list).toHaveLength(MAX_TURN_NOTICES);
    expect(list.some(record => record.turnId === 'om_0')).toBe(false);
    expect(list.some(record => record.noticeKey === fresh.noticeKey)).toBe(true);
    // Hard cap even when every record is still pending.
    list = upsertTurnNotice(list, createUserNotifyNotice({ turnId: 'om_x', message: 'x', now })).list;
    expect(list).toHaveLength(MAX_TURN_NOTICES);
  });
});

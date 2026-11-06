/**
 * Durable delivery for the two ordinary-turn notices that used to be
 * fire-once: the failure card posted from `turn_terminal`
 * (`Failed to deliver turn failure card: …`) and the worker's `user_notify`
 * text (`Failed to deliver user_notify to Lark: …`).
 *
 * Why (10-31 DNS outage): when the Feishu API itself was unreachable, both
 * notices were tried once (inside lark-gate's ~3.5s / 3 attempts), logged and
 * dropped. Nothing re-sent them once Feishu recovered, so the failed turn
 * stayed completely silent — the same failure #2680 had already fixed for the
 * auto-recovery final-failure card by making it durable. These two just never
 * went through that outbox.
 *
 * The records live on the session (`Session.turnNotices`) and are delivered by
 * the same `RecoveryNoticeOutbox` as the recovery card, so they inherit its
 * guarantees unchanged: persisted before the first send, 30s→10min backoff
 * capped at 24h, one fixed Feishu uuid per record (an unconfirmed retry is
 * de-duplicated by Feishu instead of posting a second notice), retries of a
 * send whose outcome is unknown only inside Feishu's 1h uuid window, and
 * delivery resumed after a daemon restart. Normal reply (`final_output`)
 * delivery is deliberately untouched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fallbackTurnId } from '../core/reply-target.js';
import {
  type DurableNoticeRecord,
  type RecoveryNoticeDelivery,
  type RecoveryNoticeHost,
  type RecoveryNoticeOutbox,
} from './ordinary-recovery-notice.js';

/** A replay is "the same event" only while it is still pending or right after
 *  delivery; an identical notice hours later is new information, not a
 *  duplicate, so it gets its own record and is delivered again. */
export const TURN_NOTICE_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Notice records kept per session. Pending ones are evicted only when every
 *  record is pending (a long outage), oldest first — the list must stay bounded. */
export const MAX_TURN_NOTICES = 8;

/** One durable turn notice: the exact payload the first attempt meant to send
 *  plus its delivery bookkeeping. */
export interface TurnNoticeRecord extends DurableNoticeRecord {
  /** Dedup key inside one session's list: (turn, notice kind[, content]). */
  noticeKey: string;
  /** Feishu reply route, resolved at enqueue via `fallbackTurnId` — exactly
   *  what the old `scopedReply` passed. Stored, never recomputed: a turnless
   *  worker notice in a session with a current reply target must keep that
   *  thread / private-reply route on a later resend. */
  turnId?: string;
  /** Daemon session that produced the notice (`scopedReply`'s
   *  `sourceSessionId`): outbound-hook suppression and principal-lane
   *  provenance resolve against it, so a resend must not drop it. */
  sourceSessionId: string;
  /** `interactive` = failure-card JSON, `text` = user_notify text. */
  contentType: 'interactive' | 'text';
  /** Exact payload to (re)send, persisted verbatim so a retry after a daemon
   *  restart posts the same card/text the first attempt meant to. */
  content: string;
  createdAt: number;
  delivery: RecoveryNoticeDelivery;
}

/** Resolve the notice's reply route once, at enqueue: the same turn id the old
 *  `scopedReply` computed (`fallbackTurnId`, i.e. the session's current reply
 *  target when the worker event carries no turn) plus its source session. */
export function turnNoticeRoute(
  ds: Parameters<typeof fallbackTurnId>[0],
  turnId?: string,
): { turnId?: string; sourceSessionId: string } {
  const resolved = fallbackTurnId(ds, turnId);
  return {
    ...(resolved ? { turnId: resolved } : {}),
    sourceSessionId: ds.session.sessionId,
  };
}

/** The exact `sessionReply` route of a notice: persisted values, never
 *  recomputed at send time (so a resend keeps the original thread and the
 *  original source-session identity). */
export function turnNoticeReplyArgs(
  record: TurnNoticeRecord,
  route: { anchor: string; larkAppId: string },
): {
  anchor: string; content: string; msgType: 'interactive' | 'text'; larkAppId: string;
  turnId: string | undefined; uuid: string; sourceSessionId: string;
} {
  return {
    anchor: route.anchor,
    content: record.content,
    msgType: record.contentType,
    larkAppId: route.larkAppId,
    turnId: record.turnId,
    uuid: record.delivery.uuid,
    sourceSessionId: record.sourceSessionId,
  };
}

/** Outbox key: one entry per *occurrence*. `noticeKey` is the dedupe key, which
 *  a later legitimate identical notice may share with an already-delivered
 *  record; the persisted uuid keeps the two deliveries apart. */
export function turnNoticeDeliveryKey(
  record: Pick<TurnNoticeRecord, 'noticeKey' | 'delivery'>,
): string {
  return `${record.noticeKey}\u0000${record.delivery.uuid}`;
}

/** One failure card per turn — a duplicate terminal (same turn, possibly a
 *  different error code) must not post a second card. */
export function turnFailureCardNoticeKey(turnId: string): string {
  return `${turnId}\u0000turn_failure_card`;
}

/** A worker notice re-emitted after a reconnect has identical content and
 *  dedups; two different messages in the same turn both go out. */
export function userNotifyNoticeKey(input: { turnId?: string; kind?: string; content: string }): string {
  const digest = createHash('sha256').update(input.content).digest('hex').slice(0, 12);
  return `${input.turnId ?? 'session'}\u0000user_notify:${input.kind ?? 'plain'}\u0000${digest}`;
}

export function createTurnFailureCardNotice(input: {
  turnId: string;
  sourceSessionId: string;
  /** Rendered card JSON (built by the caller while the session state is live). */
  card: string;
  now: number;
  uuid?: () => string;
}): TurnNoticeRecord {
  return {
    noticeKey: turnFailureCardNoticeKey(input.turnId),
    turnId: input.turnId,
    sourceSessionId: input.sourceSessionId,
    contentType: 'interactive',
    content: input.card,
    createdAt: input.now,
    delivery: { state: 'pending', attempts: 0, uuid: (input.uuid ?? randomUUID)() },
  };
}

export function createUserNotifyNotice(input: {
  turnId?: string;
  sourceSessionId: string;
  kind?: string;
  message: string;
  now: number;
  uuid?: () => string;
}): TurnNoticeRecord {
  return {
    noticeKey: userNotifyNoticeKey({
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      content: input.message,
    }),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    sourceSessionId: input.sourceSessionId,
    contentType: 'text',
    content: input.message,
    createdAt: input.now,
    delivery: { state: 'pending', attempts: 0, uuid: (input.uuid ?? randomUUID)() },
  };
}

/**
 * Insert a notice unless its (turn, kind[, content]) key already has a record —
 * the persisted record, not an in-memory flag, decides "one notice per event",
 * so a duplicate terminal or a daemon restart cannot create a second one.
 * Returns the list to persist and whether the record is new.
 */
export function upsertTurnNotice(
  list: readonly TurnNoticeRecord[] | undefined,
  record: TurnNoticeRecord,
): { list: TurnNoticeRecord[]; created: boolean; evicted: TurnNoticeRecord[] } {
  const current = [...(list ?? [])];
  if (current.some(entry => isDuplicateTurnNotice(entry, record))) {
    return { list: current, created: false, evicted: [] };
  }
  current.push(record);
  const evicted: TurnNoticeRecord[] = [];
  while (current.length > MAX_TURN_NOTICES) {
    const settled = current.findIndex(entry => entry.delivery.state !== 'pending');
    const [removed] = current.splice(settled >= 0 ? settled : 0, 1);
    if (!removed) break;
    evicted.push(removed);
  }
  return { list: current, created: true, evicted };
}

/** Same (turn, kind[, content]) *and* still the same occurrence: a pending
 *  record is the notice we still owe; a delivered one only suppresses a replay
 *  inside the short window. Abandoned/skipped records never block a later
 *  identical notice — otherwise one outage would mute that notice forever. */
function isDuplicateTurnNotice(entry: TurnNoticeRecord, record: TurnNoticeRecord): boolean {
  if (entry.noticeKey !== record.noticeKey) return false;
  if (entry.delivery.state === 'pending') return true;
  if (entry.delivery.state !== 'delivered') return false;
  const deliveredAt = entry.delivery.deliveredAt ?? entry.createdAt;
  return record.createdAt - deliveredAt <= TURN_NOTICE_DEDUPE_WINDOW_MS;
}

export interface TurnNoticeEnqueueResult {
  /** False when this exact notice already had a record (nothing re-armed). */
  created: boolean;
  /** The first delivery attempt. A send failure is turned into a scheduled
   *  retry by the outbox, so this resolves rather than rejecting. */
  delivery: Promise<void>;
}

/**
 * Persist the notice, then deliver it. The persist is deliberately first: a
 * crash between the two must not lose a notice the daemon already promised to
 * send. A persist failure keeps the record in memory so this process still
 * delivers it (only a restart would lose it, which the caller logs).
 */
export function recordAndDeliverTurnNotice<TTimer>(input: {
  record: TurnNoticeRecord;
  host: RecoveryNoticeHost<TurnNoticeRecord>;
  outbox: RecoveryNoticeOutbox<TTimer, TurnNoticeRecord>;
  /** Store the new list on the session and persist it. */
  saveList: (list: TurnNoticeRecord[]) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}): TurnNoticeEnqueueResult {
  const { list, created, evicted } = upsertTurnNotice(input.host.list(), input.record);
  if (!created) return { created: false, delivery: Promise.resolve() };
  for (const dropped of evicted) {
    if (dropped.delivery.state === 'pending') {
      input.log?.('warn', `turn notice ${dropped.noticeKey.slice(0, 24)} evicted while still `
        + `undelivered: notice list full (${MAX_TURN_NOTICES})`);
    }
  }
  try {
    input.saveList(list);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    input.log?.('error', `turn notice ${input.record.noticeKey.slice(0, 24)}: persist failed: ${text.slice(0, 200)}`);
  }
  return { created: true, delivery: input.outbox.deliver(input.host, turnNoticeDeliveryKey(input.record)) };
}

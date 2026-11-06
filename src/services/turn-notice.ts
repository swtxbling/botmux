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
import {
  type DurableNoticeRecord,
  type RecoveryNoticeDelivery,
  type RecoveryNoticeHost,
  type RecoveryNoticeOutbox,
} from './ordinary-recovery-notice.js';

/** Notice records kept per session. Pending ones are evicted only when every
 *  record is pending (a long outage), oldest first — the list must stay bounded. */
export const MAX_TURN_NOTICES = 8;

/** One durable turn notice: the exact payload the first attempt meant to send
 *  plus its delivery bookkeeping. */
export interface TurnNoticeRecord extends DurableNoticeRecord {
  /** Dedup key inside one session's list: (turn, notice kind[, content]). */
  noticeKey: string;
  /** Feishu reply route of the failing/notified turn; absent for the
   *  session-level worker notices that have no turn. */
  turnId?: string;
  /** `interactive` = failure-card JSON, `text` = user_notify text. */
  contentType: 'interactive' | 'text';
  /** Exact payload to (re)send, persisted verbatim so a retry after a daemon
   *  restart posts the same card/text the first attempt meant to. */
  content: string;
  createdAt: number;
  delivery: RecoveryNoticeDelivery;
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
  /** Rendered card JSON (built by the caller while the session state is live). */
  card: string;
  now: number;
  uuid?: () => string;
}): TurnNoticeRecord {
  return {
    noticeKey: turnFailureCardNoticeKey(input.turnId),
    turnId: input.turnId,
    contentType: 'interactive',
    content: input.card,
    createdAt: input.now,
    delivery: { state: 'pending', attempts: 0, uuid: (input.uuid ?? randomUUID)() },
  };
}

export function createUserNotifyNotice(input: {
  turnId?: string;
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
): { list: TurnNoticeRecord[]; created: boolean } {
  const current = [...(list ?? [])];
  if (current.some(entry => entry.noticeKey === record.noticeKey)) {
    return { list: current, created: false };
  }
  current.push(record);
  while (current.length > MAX_TURN_NOTICES) {
    const settled = current.findIndex(entry => entry.delivery.state !== 'pending');
    current.splice(settled >= 0 ? settled : 0, 1);
  }
  return { list: current, created: true };
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
  const { list, created } = upsertTurnNotice(input.host.list(), input.record);
  if (!created) return { created: false, delivery: Promise.resolve() };
  try {
    input.saveList(list);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    input.log?.('error', `turn notice ${input.record.noticeKey.slice(0, 24)}: persist failed: ${text.slice(0, 200)}`);
  }
  return { created: true, delivery: input.outbox.deliver(input.host, input.record.noticeKey) };
}

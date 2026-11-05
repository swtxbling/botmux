/**
 * One-shot automatic recovery decision for an ordinary IM turn whose worker
 * died before the daemon could confirm IPC transport.
 *
 * The daemon tracks every ordinary turn through two independent facts:
 *   - `transportConfirmed`: `child.send(message, cb)` succeeded, i.e. the bytes
 *     entered the worker's IPC channel. It says nothing about the worker
 *     reading them, and even less about the CLI executing them.
 *   - `received`: the worker itself acknowledged the turn. The worker sends
 *     this ACK synchronously at the top of its IPC handler, BEFORE it writes
 *     anything to the CLI.
 *
 * Only `!transportConfirmed && !received` proves the worker never even got the
 * bytes: the child is gone, its IPC channel never accepted the message, so no
 * copy can be waiting in a queue and nothing can have reached the CLI. That is
 * the one case where respawning the worker and sending the same turn again can
 * never execute it twice.
 *
 * Every other combination (transport confirmed, receipt seen, deliberate
 * retirement, a same-worker retry timeout) stays a human decision: the turn may
 * already be running in a CLI that outlived the worker (tmux), and a blind
 * resend would duplicate it.
 */

export type OrdinaryImRedeliveryDecision = 'auto-redeliver' | 'notify-human';

export interface OrdinaryImRedeliveryState {
  turnId: string;
  /** Failure reason label emitted by the delivery tracker (log/notice only). */
  reason: string;
  /** The worker acknowledged the turn itself. */
  received: boolean;
  /** `child.send` completed: the bytes entered the worker's IPC channel. */
  transportConfirmed: boolean;
  sessionStatus: string;
  /** The tracked payload carries no prompt text (defensive: a blank fork would
   *  spawn a worker and then never send the turn). */
  contentEmpty?: boolean;
  /** Turn ids of earlier automatic redeliveries for this session, read from the
   * persisted session record. A LIST because one dead worker can settle several
   * turns at once (the worker exit path loops over every pending record): with a
   * single slot the second turn would overwrite the first turn's mark, un-spend
   * its one retry, and allow a crash loop to replay it forever. Present ⇒ the
   * one retry was already spent (here or by a previous daemon process), so a
   * second failure must go to a human instead of retrying again. */
  priorAutoRedeliveryTurnIds?: readonly string[];
}

/** The turn provably never left the daemon. This is the only state that may be
 *  replayed; it is deliberately narrower than "the worker exited". */
export function isProvablyUndeliveredOrdinaryIm(state: {
  received: boolean;
  transportConfirmed: boolean;
}): boolean {
  return !state.received && !state.transportConfirmed;
}

/** Why `worker_exited_before_ipc_enqueue` is the only replayable reason: it is
 *  emitted only from the worker-exit settlement path, after `child.send` never
 *  completed. The other reasons either happen while the worker is alive
 *  (`ipc_callback_timeout`, `worker_generation_changed`) or describe a
 *  deliberate lifecycle retirement where a replacement may already exist
 *  (`worker_retired_before_commit`). */
export const ORDINARY_IM_REPLAYABLE_REASON = 'worker_exited_before_ipc_enqueue';

/** Turn-id family eligible for automatic replay. `bmx-recovery-` and `board:`
 *  share the ordinary delivery protocol but already own a durable recovery
 *  chain (continuation slot / dashboard batch), which must not be raced by a
 *  second replay path. A plain `om_` turn is the owner's own Lark message and
 *  has no other owner. */
function isPlainOwnerTurn(turnId: string): boolean {
  return turnId.startsWith('om_');
}

export function decideOrdinaryImRedelivery(
  state: OrdinaryImRedeliveryState,
): OrdinaryImRedeliveryDecision {
  if (!isProvablyUndeliveredOrdinaryIm(state)) return 'notify-human';
  if (state.reason !== ORDINARY_IM_REPLAYABLE_REASON) return 'notify-human';
  if (!isPlainOwnerTurn(state.turnId)) return 'notify-human';
  if (state.contentEmpty) return 'notify-human';
  if (state.sessionStatus !== 'active') return 'notify-human';
  if (state.priorAutoRedeliveryTurnIds?.includes(state.turnId)) return 'notify-human';
  return 'auto-redeliver';
}

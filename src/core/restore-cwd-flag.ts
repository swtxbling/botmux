// Boot-time working-directory verdict shared by restore, the inbound turn
// guard and the fork paths.
//
// `Session.restoreCwdUnverifiedAt` means "the boot probe could not read this
// session's directory". While it is set, transcript scans (token usage / open
// todos) are skipped for the row, because they resolve the transcript through a
// SYNCHRONOUS `realpathSync(workingDir)` that freezes the whole daemon when the
// directory hangs. The flag is cleared as soon as the directory is proven
// readable in the same process lifetime (verified probe or a successful fork),
// so the dashboard recovers without a restart.
import * as sessionStore from '../services/session-store.js';
import { logger } from '../utils/logger.js';
import { probeFlaggedCwd, type FlaggedCwdProbeOptions } from './restore-cwd-recovery.js';
import type { Session } from '../types.js';

export function markRestoreCwdUnverified(
  session: Session,
  at: string = new Date().toISOString(),
): void {
  session.restoreCwdUnverifiedAt = at;
}

/** Clear the verdict and persist it. Returns true when the row changed. */
export function clearRestoreCwdUnverified(session: Session): boolean {
  if (!session.restoreCwdUnverifiedAt) return false;
  session.restoreCwdUnverifiedAt = undefined;
  try {
    sessionStore.updateSession(session);
  } catch (err) {
    logger.warn(
      `[${session.sessionId.substring(0, 8)}] Could not clear working-directory verdict: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

export interface FlaggedTurnGuardOptions extends FlaggedCwdProbeOptions {
  cwd: string;
  reply: (text: string) => Promise<unknown>;
}

/**
 * Inbound-turn guard for a row the boot probe could not verify. Returns true
 * when the turn may proceed (directory proved readable, flag cleared); false
 * when the human was told why nothing was started and the caller must stop
 * before forking.
 *
 * This is the only place that WAITS for a directory: the fork choke points
 * (worker-pool.ts) refuse synchronously and let this shared, single-flight
 * probe cache supply the verdict — a recent timeout answers at once, so a
 * broken mount does not cost every message a full probe budget.
 */
export async function guardFlaggedSessionTurn(
  session: Session,
  options: FlaggedTurnGuardOptions,
): Promise<boolean> {
  if (!session.restoreCwdUnverifiedAt) return true;
  const check = await probeFlaggedCwd(options.cwd, {
    probe: options.probe,
    timeoutMs: options.timeoutMs,
    cooldownMs: options.cooldownMs,
    now: options.now,
  });
  if (check.status === 'ok') {
    clearRestoreCwdUnverified(session);
    return true;
  }
  const notice = `这条会话的工作目录暂时读不到：${options.cwd}`
    + `（${check.detail ?? 'directory check failed'}）。为了不卡住其他会话，我没有启动 CLI。`
    + '请先让这个目录恢复可访问，再用 /repo 或 /cd 换一个目录后重新发消息。';
  try {
    await options.reply(notice);
  } catch (err) {
    logger.warn(
      `[${session.sessionId.substring(0, 8)}] Could not send the working-directory notice: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return false;
}

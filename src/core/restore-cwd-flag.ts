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
import {
  probeRestoreSessionCwds,
  type RestoreCwdProbe,
  type RestoreCwdProbeResult,
} from './restore-cwd-probe.js';
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

export type VerifiedCwdResult =
  | { ok: true }
  | { ok: false; status: Exclude<RestoreCwdProbeResult['status'], 'ok'>; detail: string };

/**
 * Re-run the bounded, out-of-process directory check for a row the boot probe
 * could not verify. Success clears the flag; failure leaves it in place so every
 * later transcript scan keeps skipping the row.
 */
export async function verifyRestoreCwdBeforeUse(
  session: Session,
  cwd: string,
  options: { probe?: RestoreCwdProbe; timeoutMs?: number } = {},
): Promise<VerifiedCwdResult> {
  if (!cwd) return { ok: false, status: 'missing', detail: 'no working directory configured' };
  const results = await probeRestoreSessionCwds([{ sessionId: session.sessionId, cwd }], {
    probe: options.probe,
    timeoutMs: options.timeoutMs,
  });
  const result = results.get(session.sessionId);
  if (result?.status === 'ok') {
    clearRestoreCwdUnverified(session);
    return { ok: true };
  }
  return {
    ok: false,
    status: result?.status === 'missing' || result?.status === 'not_directory'
      || result?.status === 'unreadable' || result?.status === 'timeout'
      ? result.status
      : 'unreadable',
    detail: result?.detail ?? 'directory check failed',
  };
}

export interface FlaggedTurnGuardOptions {
  cwd: string;
  reply: (text: string) => Promise<unknown>;
  probe?: RestoreCwdProbe;
  timeoutMs?: number;
}

/**
 * Inbound-turn guard for a row the boot probe could not verify. Returns true
 * when the turn may proceed (directory proved readable, flag cleared); false
 * when the human was told why nothing was started and the caller must stop
 * before forking. The fork paths check existence synchronously, so this is the
 * only safe place to wait on the directory.
 */
export async function guardFlaggedSessionTurn(
  session: Session,
  options: FlaggedTurnGuardOptions,
): Promise<boolean> {
  if (!session.restoreCwdUnverifiedAt) return true;
  const check = await verifyRestoreCwdBeforeUse(session, options.cwd, {
    probe: options.probe,
    timeoutMs: options.timeoutMs,
  });
  if (check.ok) return true;
  const notice = `这条会话的工作目录暂时读不到：${options.cwd}`
    + `（${check.detail}）。为了不卡住其他会话，我没有启动 CLI。`
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

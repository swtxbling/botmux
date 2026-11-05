// Bounded, per-session working-directory probe used by daemon startup restore.
//
// Why this exists: restore runs BEFORE the Feishu websocket dispatchers start,
// and every dashboard row it announces (token usage, open todos) resolves the
// session transcript through `realpathSync(workingDir)`. A working directory
// that cannot answer — macOS TCC pending, external disk unplugged, dead network
// mount — turned one bad session into a daemon-wide outage: the synchronous
// probe blocked the event loop, `startEventDispatchers()` never ran, and every
// bot went offline.
//
// The probe here never blocks the event loop (it uses node:fs/promises) and is
// bounded per session, so one unresponsive directory can only cost the timeout
// once for the whole boot (all sessions are probed concurrently). It is purely
// advisory: the caller keeps the session in the store and registered either
// way, deferring the eager filesystem work for that row to its next message.
import { stat } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

/** How long one session's directory may take to answer before restore moves on. */
export const RESTORE_CWD_PROBE_TIMEOUT_MS = 1500;

export type RestoreCwdProbeStatus =
  | 'ok'
  /** The path does not exist (deleted, or an unmounted disk). Cheap to detect. */
  | 'missing'
  /** The path exists but is not a directory. */
  | 'not_directory'
  /** The path exists but cannot be read (permissions, privacy fencing). */
  | 'unreadable'
  /** The probe did not answer in time — the only status that defers eager work. */
  | 'timeout';

export interface RestoreCwdProbeTarget {
  sessionId: string;
  cwd: string;
}

export interface RestoreCwdProbeResult {
  status: RestoreCwdProbeStatus;
  /** Human-readable reason, always set for non-ok statuses. */
  detail?: string;
}

/**
 * Injectable directory check. Resolves when the directory is usable, rejects
 * otherwise. Tests replace this to model a hanging or failing cwd without
 * depending on the host filesystem.
 */
export type RestoreCwdProbe = (cwd: string) => Promise<void>;

class RestoreCwdProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${timeoutMs}ms`);
    this.name = 'RestoreCwdProbeTimeoutError';
  }
}

const defaultRestoreCwdProbe: RestoreCwdProbe = async (cwd) => {
  const info = await stat(cwd);
  if (!info.isDirectory()) {
    const error = new Error('path is not a directory') as NodeJS.ErrnoException;
    error.code = 'ENOTDIR';
    throw error;
  }
};

function classifyProbeError(error: unknown): RestoreCwdProbeResult {
  if (error instanceof RestoreCwdProbeTimeoutError) {
    return {
      status: 'timeout',
      detail: `${error.message} (directory may be on an unmounted disk or behind a `
        + 'privacy/permission prompt)',
    };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') return { status: 'missing', detail: 'no such directory' };
  if (code === 'ENOTDIR') return { status: 'not_directory', detail: 'path is not a directory' };
  if (code === 'EACCES' || code === 'EPERM') {
    return { status: 'unreadable', detail: `permission denied (${code})` };
  }
  return { status: 'unreadable', detail: message };
}

async function probeOne(
  cwd: string,
  probe: RestoreCwdProbe,
  timeoutMs: number,
): Promise<RestoreCwdProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // Defer the call so a probe that throws (or blocks) synchronously is
      // still classified instead of escaping as a bare exception.
      Promise.resolve().then(() => probe(cwd)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RestoreCwdProbeTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { status: 'ok' };
  } catch (error) {
    return classifyProbeError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Max directories probed at once. A syscall on a dead mount cannot be
 *  cancelled, so an unbounded fan-out of DISTINCT hung paths could pin every
 *  libuv thread-pool slot for the process lifetime. */
const RESTORE_CWD_PROBE_CONCURRENCY = 4;

/**
 * Probe every restored session's directory concurrently, each bounded by
 * `timeoutMs`. Never throws: a result map keyed by session id is always
 * returned, and every non-ok row gets one clear operator log line naming the
 * session, the directory, the reason and the recovery action.
 *
 * Targets sharing a directory (the common case: many sessions under one bot
 * default) are probed once.
 */
export async function probeRestoreSessionCwds(
  targets: ReadonlyArray<RestoreCwdProbeTarget>,
  probe: RestoreCwdProbe = defaultRestoreCwdProbe,
  timeoutMs: number = RESTORE_CWD_PROBE_TIMEOUT_MS,
): Promise<Map<string, RestoreCwdProbeResult>> {
  const results = new Map<string, RestoreCwdProbeResult>();
  const uniqueCwds = [...new Set(targets.map(target => target.cwd))];
  const byCwd = new Map<string, RestoreCwdProbeResult>();
  let next = 0;
  const runProbeQueue = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= uniqueCwds.length) return;
      const cwd = uniqueCwds[index]!;
      byCwd.set(cwd, await probeOne(cwd, probe, timeoutMs));
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(RESTORE_CWD_PROBE_CONCURRENCY, uniqueCwds.length) },
    runProbeQueue,
  ));
  for (const target of targets) {
    const result = byCwd.get(target.cwd) ?? { status: 'unreadable', detail: 'probe result lost' };
    results.set(target.sessionId, result);
    if (result.status === 'ok') continue;
    logger.warn(
      `[restore] working directory check ${result.status} for session ${target.sessionId}: `
      + `${target.cwd} — ${result.detail ?? 'unknown reason'}. `
      + (result.status === 'timeout'
        ? 'The session stays registered and its eager startup work is skipped this boot; '
          + 'send it a message to retry, or use /repo or /cd to pick another directory.'
        : 'The session is restored as usual; send it a message to retry, or use /repo or /cd '
          + 'to pick another directory.'),
    );
  }
  return results;
}

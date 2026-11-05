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
// The check MUST NOT run inside this process. An `fs.promises.stat` on a hung
// path cannot be cancelled: abandoning it after a timeout leaves it holding one
// libuv thread-pool slot forever, and with the default pool size of 4 a handful
// of hung directories starve every later async fs AND `dns.lookup` — including
// the Feishu websocket connect. So the existence/readability check runs in a
// short-lived `sh` child process, which we can SIGKILL. The daemon's own thread
// pool is never touched.
//
// All probes share ONE overall deadline, so startup delay is bounded by that
// deadline no matter how many directories hang.
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

/** Overall wall-clock budget for all probes of one boot. */
export const RESTORE_CWD_PROBE_TIMEOUT_MS = 1500;

/** How many probe child processes may run at once. Children, not libuv work. */
const RESTORE_CWD_PROBE_CONCURRENCY = 16;

export type RestoreCwdProbeStatus =
  | 'ok'
  /** The path does not exist (deleted, or an unmounted disk). Cheap to detect. */
  | 'missing'
  /** The path exists but is not a directory. */
  | 'not_directory'
  /** The path exists but cannot be read/entered (permissions, privacy fencing). */
  | 'unreadable'
  /** The probe did not answer before the deadline — the only status that defers work. */
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
 * otherwise. The default implementation runs out of process; tests replace this
 * to model a hanging or failing cwd without depending on the host filesystem.
 */
export type RestoreCwdProbe = (cwd: string) => Promise<void>;

class RestoreCwdProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`no answer within ${timeoutMs}ms`);
    this.name = 'RestoreCwdProbeTimeoutError';
  }
}

class RestoreCwdCheckError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RestoreCwdCheckError';
  }
}

/** Exit codes of the out-of-process check script. */
const CHECK_EXIT = {
  ok: 0,
  missing: 3,
  notDirectory: 4,
  unreadable: 5,
} as const;

// POSIX sh only (dash/bash/zsh on macOS and Linux). The path arrives as an
// argv parameter (`$1`), never interpolated into the script.
const CHECK_SCRIPT = [
  `[ -e "$1" ] || exit ${CHECK_EXIT.missing}`,
  `[ -d "$1" ] || exit ${CHECK_EXIT.notDirectory}`,
  `[ -r "$1" ] && [ -x "$1" ] || exit ${CHECK_EXIT.unreadable}`,
  'exit 0',
].join('\n');

export interface SubprocessCwdProbeOptions {
  /** Test seam: the command run for one check. Defaults to `/bin/sh`. */
  command?: string;
  /** Test seam: argv builder. Defaults to `sh -c <check script> sh <cwd>`. */
  args?: (cwd: string) => string[];
  /** Per-check kill deadline. Defaults to the restore budget. */
  timeoutMs?: number;
}

/**
 * Build a probe that answers from a child process, so a hung filesystem call
 * can be killed instead of occupying a daemon thread-pool slot.
 */
export function createSubprocessCwdProbe(
  options: SubprocessCwdProbeOptions = {},
): RestoreCwdProbe {
  const command = options.command ?? '/bin/sh';
  const argsFor = options.args ?? ((cwd: string) => ['-c', CHECK_SCRIPT, 'sh', cwd]);
  const timeoutMs = options.timeoutMs ?? RESTORE_CWD_PROBE_TIMEOUT_MS;
  return (cwd: string) => new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argsFor(cwd), { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(new RestoreCwdCheckError(
        `cannot start cwd check: ${error instanceof Error ? error.message : String(error)}`,
        'ECHECKSPAWN',
      ));
      return;
    }
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      // SIGKILL: the child may be stuck in an uninterruptible stat; only a hard
      // kill guarantees it stops holding the path (or waiting on it) for us.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      settle(() => reject(new RestoreCwdProbeTimeoutError(timeoutMs)));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => settle(() => reject(new RestoreCwdCheckError(
      `cwd check failed to run: ${error.message}`,
      'ECHECKRUN',
    ))));
    child.once('close', (code, signal) => settle(() => {
      if (signal) {
        reject(new RestoreCwdProbeTimeoutError(timeoutMs));
        return;
      }
      switch (code) {
        case CHECK_EXIT.ok: resolve(); return;
        case CHECK_EXIT.missing:
          reject(new RestoreCwdCheckError('no such directory', 'ENOENT')); return;
        case CHECK_EXIT.notDirectory:
          reject(new RestoreCwdCheckError('path is not a directory', 'ENOTDIR')); return;
        case CHECK_EXIT.unreadable:
          reject(new RestoreCwdCheckError('directory is not readable/enterable', 'EACCES')); return;
        default:
          reject(new RestoreCwdCheckError(`cwd check exited with code ${code ?? 'null'}`, 'ECHECKRUN'));
      }
    }));
  });
}

/** Default probe: out-of-process, killable, never touches the daemon pool. */
export const defaultRestoreCwdProbe: RestoreCwdProbe = createSubprocessCwdProbe();

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

export interface ProbeRestoreCwdsOptions {
  probe?: RestoreCwdProbe;
  /** Overall deadline for ALL probes (not per probe). */
  timeoutMs?: number;
  /** Max concurrent probes. */
  concurrency?: number;
  /** Skip the per-target warn lines (recovery probes run on every message). */
  silent?: boolean;
}

/**
 * Probe every restored session's directory within ONE overall deadline. Never
 * throws: a result map keyed by session id is always returned, and every non-ok
 * row gets one clear operator log line naming the session, the directory, the
 * reason and the recovery action.
 *
 * Targets sharing a directory (the common case: many sessions under one bot
 * default) are probed once. Anything started too late to matter is classified
 * `timeout` without spawning.
 */
export async function probeRestoreSessionCwds(
  targets: ReadonlyArray<RestoreCwdProbeTarget>,
  options: ProbeRestoreCwdsOptions = {},
): Promise<Map<string, RestoreCwdProbeResult>> {
  const probe = options.probe ?? defaultRestoreCwdProbe;
  const timeoutMs = options.timeoutMs ?? RESTORE_CWD_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? RESTORE_CWD_PROBE_CONCURRENCY);
  const results = new Map<string, RestoreCwdProbeResult>();
  const uniqueCwds = [...new Set(targets.map(target => target.cwd))];
  const byCwd = new Map<string, RestoreCwdProbeResult>();
  const deadline = Date.now() + timeoutMs;
  let next = 0;
  const runProbeQueue = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= uniqueCwds.length) return;
      const cwd = uniqueCwds[index]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        byCwd.set(cwd, {
          status: 'timeout',
          detail: `no answer within ${timeoutMs}ms (directory may be on an unmounted `
            + 'disk or behind a privacy/permission prompt)',
        });
        continue;
      }
      byCwd.set(cwd, await probeOne(cwd, probe, remaining));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueCwds.length) }, runProbeQueue));
  for (const target of targets) {
    const result = byCwd.get(target.cwd) ?? { status: 'unreadable', detail: 'probe result lost' };
    results.set(target.sessionId, result);
    if (result.status === 'ok' || options.silent) continue;
    logger.warn(
      `[restore] working directory check ${result.status} for session ${target.sessionId}: `
      + `${target.cwd} — ${result.detail ?? 'unknown reason'}. `
      + (result.status === 'timeout'
        ? 'The session stays registered with its eager startup work deferred; a message sent '
          + 'while the directory is still unreachable is refused with an explanation, and '
          + '/repo or /cd picks another directory.'
        : 'The session is restored as usual; send it a message to retry, or use /repo or /cd '
          + 'to pick another directory.'),
    );
  }
  return results;
}

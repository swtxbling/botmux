// Recovery policy for a working directory the boot probe could not read.
//
// Several independent callers need the same answer ("is this directory usable
// now?"): the daemon turn guard (it can wait briefly and answer the human), the
// synchronous fork paths (they must NOT wait — they refuse and let the next
// attempt succeed), and any later inspection. Running a fresh child-process
// check per call would let a message storm spawn a process per message, and a
// directory in uninterruptible D-state would accumulate one stuck child per
// call. So every caller goes through this cache:
//
//   - single-flight per directory: concurrent callers share one probe;
//   - a timeout is remembered for one cooldown window and answers instantly
//     afterwards (the daemon turn guard replies without waiting, the fork path
//     refuses without touching the directory), while a fresh probe is only
//     allowed again after that window;
//   - a positive answer is NEVER reused: clearing the boot flag must rest on a
//     fresh check right before it (the residual window where the directory
//     hangs between that check and the fork is a documented limit).
import {
  probeRestoreSessionCwds,
  type RestoreCwdProbe,
  type RestoreCwdProbeResult,
} from './restore-cwd-probe.js';

/** After a timeout (or a positive answer) reuse the verdict this long. */
export const FLAGGED_CWD_PROBE_COOLDOWN_MS = 30_000;

interface FlaggedCwdEntry {
  inFlight?: Promise<RestoreCwdProbeResult>;
  result?: RestoreCwdProbeResult;
  at?: number;
}

const cache = new Map<string, FlaggedCwdEntry>();

export interface FlaggedCwdProbeOptions {
  probe?: RestoreCwdProbe;
  timeoutMs?: number;
  cooldownMs?: number;
  /** Test seam: clock for the cooldown window. */
  now?: () => number;
}

const TIMEOUT_DETAIL = 'the directory did not answer a recent check '
  + '(it may be on an unmounted disk or behind a privacy/permission prompt)';

function timeoutResult(): RestoreCwdProbeResult {
  return { status: 'timeout', detail: TIMEOUT_DETAIL };
}

/**
 * Ask whether `cwd` is usable now. Never rejects. Concurrent calls for the same
 * directory share one probe, and a cached verdict is reused for the cooldown
 * window, so repeated messages cannot pile up stuck child processes.
 */
export function probeFlaggedCwd(
  cwd: string,
  options: FlaggedCwdProbeOptions = {},
): Promise<RestoreCwdProbeResult> {
  if (!cwd) {
    return Promise.resolve({ status: 'missing', detail: 'no working directory configured' });
  }
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? FLAGGED_CWD_PROBE_COOLDOWN_MS;
  const current = cache.get(cwd);
  if (current?.inFlight) return current.inFlight;
  if (current?.at !== undefined && current.result?.status === 'timeout'
      && now() - current.at < cooldownMs) {
    // A recent check timed out. Do not start another one during the cooldown;
    // the caller answers from this verdict immediately.
    return Promise.resolve(timeoutResult());
  }
  const started = probeRestoreSessionCwds([{ sessionId: cwd, cwd }], {
    probe: options.probe,
    timeoutMs: options.timeoutMs,
    silent: true,
  }).then((results): RestoreCwdProbeResult =>
    results.get(cwd) ?? { status: 'unreadable', detail: 'probe result lost' });
  const entry: FlaggedCwdEntry = { inFlight: started };
  cache.set(cwd, entry);
  return started.then((result) => {
    // Only a timeout is cached (to avoid spawning another stuck child and to
    // answer repeated messages instantly). A positive/missing/unreadable answer
    // is cheap to obtain and must be fresh: in particular an `ok` may clear the
    // boot flag, and a stale ok would hide a directory that hangs right after.
    if (result.status === 'timeout') {
      cache.set(cwd, { result, at: now() });
    } else {
      cache.delete(cwd);
    }
    return result;
  });
}

/**
 * Fire-and-forget probe used by the synchronous fork paths: refuse now, and let
 * the next fork attempt succeed once the directory answers. `onOk` runs only on
 * a positive verdict (the caller clears the persisted boot flag with it).
 */
export function scheduleFlaggedCwdProbe(
  cwd: string,
  onOk: () => void,
  options: FlaggedCwdProbeOptions = {},
): void {
  void probeFlaggedCwd(cwd, options)
    .then((result) => {
      if (result.status === 'ok') onOk();
    })
    .catch(() => { /* probeFlaggedCwd never rejects; keep the fork refusal safe */ });
}

const noticeSentAt = new Map<string, number>();

/**
 * Rate limit for the fork-path "directory still unreadable" notice: a session
 * gets at most one notice per cooldown window, so scheduler retries or a burst
 * of card actions cannot spam the chat. Returns true when the caller may send.
 */
export function claimUnverifiedWorkingDirNotice(
  sessionId: string,
  options: { cooldownMs?: number; now?: () => number } = {},
): boolean {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? FLAGGED_CWD_PROBE_COOLDOWN_MS;
  const last = noticeSentAt.get(sessionId);
  if (last !== undefined && now() - last < cooldownMs) return false;
  noticeSentAt.set(sessionId, now());
  return true;
}

/** Test hook: drop remembered verdicts and notice timestamps between cases. */
export function __resetFlaggedCwdProbeCacheForTests(): void {
  cache.clear();
  noticeSentAt.clear();
}

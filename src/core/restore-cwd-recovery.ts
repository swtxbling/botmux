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
//   - a positive answer is remembered for one cooldown window (fork proceeds);
//   - a timeout is remembered for one cooldown window and answers instantly
//     afterwards (the daemon turn guard replies without waiting, the fork path
//     refuses without touching the directory), while a fresh probe is only
//     allowed again after that window.
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
  if (current?.at !== undefined && current.result && now() - current.at < cooldownMs) {
    // Only ok/timeout verdicts are cached (cheap answers are re-checked).
    if (current.result.status === 'ok') return Promise.resolve(current.result);
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
    // Cache only verdicts worth reusing: a positive answer (fork may proceed)
    // and a timeout (do not spawn another stuck child). Missing/unreadable are
    // cheap to re-check and may be fixed between attempts.
    if (result.status === 'ok' || result.status === 'timeout') {
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

/** Test hook: drop remembered verdicts between cases. */
export function __resetFlaggedCwdProbeCacheForTests(): void {
  cache.clear();
}

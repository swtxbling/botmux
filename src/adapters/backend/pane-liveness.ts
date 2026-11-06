import { readFileSync } from 'node:fs';

import { procStatFieldsAfterComm } from '../../utils/proc-stat.js';

/**
 * Liveness of the process behind a tmux pane, as far as botmux can prove it
 * BEFORE deciding to reattach.
 *
 * Why this exists: `tmux has-session` only says the session still exists. A
 * pane whose CLI already died can keep answering that for a while — a retained
 * corpse (`remain-on-exit`) carries `#{pane_dead}=1`, and a pane tmux has not
 * reaped/classified yet still reports `#{pane_dead}=0` while
 * `#{pane_pid}` names a process the kernel already knows is gone (or an
 * unreaped zombie). Reattaching to either shape succeeds at the tmux level and
 * then fails with `target pane has exited`; every write after that goes into a
 * pane nobody runs, so the chat looks hung.
 *
 *   `alive`   — tmux says the pane is not dead AND its pane process is a live
 *               (non-zombie) process.
 *   `dead`    — tmux explicitly flags the pane dead, OR the pane process is
 *               provably gone/zombie. Only this verdict may tear a session down.
 *   `unknown` — anything we could not read or parse. Never a death: an
 *               unanswered probe must keep the historical behaviour (reattach,
 *               no kill), because a live pane must not be destroyed on a
 *               transient tmux stall.
 */
export type PaneLiveness = 'alive' | 'dead' | 'unknown';

export interface PaneLivenessObservation {
  liveness: PaneLiveness;
  /** `#{pane_pid}` from the same answer; null when absent/unparsable. */
  panePid: number | null;
  /** `#{pane_dead_status}` when tmux already published the real exit code. */
  deathStatus: number | null;
  /** Signal that killed the pane, available only from an unreaped zombie's
   *  kernel entry (tmux itself does not publish it in this format). */
  deathSignal: number | null;
  /** `#{pid}` — the tmux SERVER that answered, not the pane. Lets a reap prove
   *  the same server still owns the session, and gates the pid-namespace check
   *  in {@link readPaneProcessAliveForServer}. */
  serverPid: number | null;
  /** `#{session_id}` (`$N`) — the exact session object the answer described, so
   *  a reap can target it instead of a name that may be re-created meanwhile. */
  sessionId: string | null;
}

/**
 * One round-trip: explicit death flag, the process behind the pane, the real
 * exit code when tmux has one, the session object the answer came from, and
 * the tmux SERVER pid (so an unreaped zombie's real exit code can be read from
 * the kernel when tmux has not published it yet — see unreaped-pane-exit).
 */
export const PANE_LIVENESS_FORMAT = '#{pane_dead}:#{pane_pid}:#{pane_dead_status}:#{session_id}:#{pid}';

function unknown(
  sessionId: string | null = null,
  panePid: number | null = null,
  serverPid: number | null = null,
): PaneLivenessObservation {
  return { liveness: 'unknown', panePid, deathStatus: null, deathSignal: null, serverPid, sessionId };
}

/** tmux session ids are `$<digits>`; never treat a garbled field as a target. */
function parseSessionId(raw: string | undefined): string | null {
  return /^\$\d+$/.test(raw ?? '') ? raw! : null;
}

/**
 * Classify one {@link PANE_LIVENESS_FORMAT} line. Pure (the OS check is
 * injected) so the verdict is deterministically testable.
 *
 * `processAlive` answers `true` (running), `false` (provably gone: ESRCH /
 * missing `/proc` entry / zombie) or `null` (could not tell — permission,
 * spawn restriction, unparsable stat). Only `false` contributes to a death
 * verdict, and an explicit `#{pane_dead}=1` is authoritative on its own: a
 * dead pane cannot revive, so it is never re-read through the pid check (a
 * recycled pid must not un-latch a death).
 */
export function classifyPaneLiveness(
  raw: string,
  processAlive: (panePid: number, serverPid: number | null) => boolean | null,
): PaneLivenessObservation {
  const fields = String(raw ?? '').trim().split(':');
  const [deadRaw, pidRaw, statusRaw, sessionRaw, serverRaw] = fields;
  const sessionId = parseSessionId(sessionRaw);
  const panePid = /^[1-9]\d*$/.test(pidRaw ?? '') && Number.isSafeInteger(Number(pidRaw))
    ? Number(pidRaw)
    : null;
  const deathStatus = /^\d+$/.test(statusRaw ?? '') ? Number(statusRaw) : null;
  const serverPid = /^[1-9]\d*$/.test(serverRaw ?? '') && Number.isSafeInteger(Number(serverRaw))
    ? Number(serverRaw)
    : null;
  if (deadRaw !== '0' && deadRaw !== '1') {
    // '' (timeout / tmux error), garbled output, a tmux that does not report
    // the flag: no answer, not a death.
    return unknown(sessionId, panePid, serverPid);
  }
  if (deadRaw === '1') {
    return { liveness: 'dead', panePid, deathStatus, deathSignal: null, serverPid, sessionId };
  }
  // Explicitly "not dead" — but confirm the process the pane is supposed to be
  // running is still there. A missing/unparsable pid is "cannot confirm", not
  // "the process is gone". The server pid goes along because on Linux the pane
  // pid is only meaningful from the server's pid namespace — see
  // readPaneProcessAliveForServer.
  if (panePid === null) return unknown(sessionId, null, serverPid);
  const alive = processAlive(panePid, serverPid);
  if (alive === true) {
    return { liveness: 'alive', panePid, deathStatus, deathSignal: null, serverPid, sessionId };
  }
  if (alive === false) {
    return { liveness: 'dead', panePid, deathStatus, deathSignal: null, serverPid, sessionId };
  }
  return unknown(sessionId, panePid, serverPid);
}

export interface PaneProcessProbeDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  signal?: (pid: number, signal: number | 0) => void;
}

/**
 * Whether `pid` is a RUNNING process. `false` only on positive evidence of
 * absence, `null` when the answer is inconclusive.
 *
 * Linux reads `/proc/<pid>/stat`: a missing entry means the kernel has already
 * released the pid (the pane process was reaped); state `Z`/`X` means it
 * exited and is only waiting for its parent — a pane cannot run anything in
 * that state either. On other platforms `kill(pid, 0)` distinguishes ESRCH
 * (gone) from EPERM (exists, not ours); anything else is inconclusive.
 * Invalid ids (0, negative, non-integers) are inconclusive rather than dead:
 * they usually mean the caller got no pid at all (an old tmux that did not
 * report one), not that a pane died.
 */
export function readPaneProcessAlive(pid: number, deps: PaneProcessProbeDeps = {}): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') {
    try {
      const stat = (deps.readFile ?? (path => readFileSync(path, 'utf8')))(`/proc/${pid}/stat`);
      const state = procStatFieldsAfterComm(stat)?.[0];
      if (!state) return null; // unparsable line: do not invent a death
      return !/^[ZXx]$/.test(state);
    } catch (err: any) {
      // ENOENT = the kernel has no such process anymore. Every other read
      // failure (permission, I/O) is "we could not tell".
      return err?.code === 'ENOENT' || err?.code === 'ESRCH' ? false : null;
    }
  }
  try {
    (deps.signal ?? process.kill)(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return null;
  }
}

/**
 * {@link readPaneProcessAlive} as seen from the tmux SERVER that owns the pane.
 *
 * On Linux `/proc` is pid-namespaced: a botmux inside a container (or any
 * process in another pid namespace) can reach the tmux server through a mounted
 * socket while `/proc/<pane_pid>` for its children looks absent. There, an
 * ENOENT would be "not in OUR namespace", not "the process is gone" — acting on
 * it would kill a live session. The server pid comes from the SAME tmux answer;
 * if it is missing or not visible to us, this host's view is not the server's,
 * so an absent pane pid proves nothing: `null` (unknown). Other platforms use
 * `kill(pid, 0)`, which is not namespaced this way, so the plain check stands.
 */
export function readPaneProcessAliveForServer(
  panePid: number,
  serverPid: number | null,
  deps: PaneProcessProbeDeps = {},
): boolean | null {
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') {
    if (serverPid === null || readPaneProcessAlive(serverPid, deps) !== true) return null;
  }
  return readPaneProcessAlive(panePid, deps);
}

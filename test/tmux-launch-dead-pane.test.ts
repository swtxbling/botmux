/**
 * 重接前必须确认 pane 里真的有活进程（GitHub issue #4）。
 *
 * 事故形状：CLI 进程已经死了，但 tmux 还回答 `has-session` 成功——要么是
 * `remain-on-exit` 留下的尸体（`#{pane_dead}=1`），要么是 tmux 还没来得及
 * 把 pane 标死、而 `#{pane_pid}` 指的进程在内核里已经没了/只剩僵尸
 * （`#{pane_dead}=0`）。旧探针只看会话存在性，于是「重接」到一个没人干活的
 * pane，收到 `target pane has exited`，会话看起来就卡住了。
 *
 * 这里钉三层行为：
 *  1. 纯分类器：显式死亡、进程消失、僵尸、读不到 → alive / dead / unknown；
 *  2. `probeSessionForLaunch` 的接线（假 tmux）：死 → missing 且清掉旧会话；
 *     活 → exists 且不动它；探针答不上来 → exists 且绝不 kill；
 *  3. 真 tmux（私有 socket）：尸体被清掉后同名会话能重建；活会话原样保留；
 *     探针不确定时真会话仍然活着。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import {
  classifyPaneLiveness,
  readPaneProcessAlive,
  readPaneProcessAliveForServer,
} from '../src/adapters/backend/pane-liveness.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

/** A pid the kernel has already reaped. */
function reapedPid(): number {
  const child = spawnSync('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  expect(typeof child.pid).toBe('number');
  return child.pid!;
}

describe('classifyPaneLiveness', () => {
  const neverAsked = () => {
    throw new Error('an explicit corpse must not be re-read through its pid');
  };

  it('treats tmux\'s explicit pane_dead=1 as dead without asking the OS', () => {
    expect(classifyPaneLiveness('1::77:$3\n', neverAsked)).toEqual({
      liveness: 'dead', panePid: null, deathStatus: 77, deathSignal: null,
      serverPid: null, sessionId: '$3',
    });
  });

  it('keeps a corpse dead even when a pid was reused by a live process', () => {
    expect(classifyPaneLiveness('1:42::$3', () => true).liveness).toBe('dead');
  });

  it('treats pane_dead=0 with a gone pane process as dead', () => {
    expect(classifyPaneLiveness('0:4242::$3', () => false)).toEqual({
      liveness: 'dead', panePid: 4242, deathStatus: null, deathSignal: null,
      serverPid: null, sessionId: '$3',
    });
  });

  it('keeps pane_dead=0 with a live pane process as alive', () => {
    expect(classifyPaneLiveness('0:4242::$3', () => true).liveness).toBe('alive');
  });

  it('is undecided when the OS check cannot answer', () => {
    expect(classifyPaneLiveness('0:4242::$3', () => null).liveness).toBe('unknown');
  });

  it('is undecided when the pid is missing or invalid', () => {
    expect(classifyPaneLiveness('0:::$3', () => true).liveness).toBe('unknown');
    expect(classifyPaneLiveness('0:not-a-pid::$3', () => true).liveness).toBe('unknown');
    expect(classifyPaneLiveness('0:0::$3', () => false).liveness).toBe('unknown');
  });

  it('is undecided on an unreadable / garbled answer, never dead', () => {
    expect(classifyPaneLiveness('', () => false).liveness).toBe('unknown');
    expect(classifyPaneLiveness('target pane has exited', () => false).liveness).toBe('unknown');
    expect(classifyPaneLiveness('2:4242::$3', () => false).liveness).toBe('unknown');
  });

  it('never accepts a garbled session id as a kill target', () => {
    expect(classifyPaneLiveness('1::77:bmx-x', neverAsked).sessionId).toBeNull();
  });

  it('passes the SERVER pid from the same answer to the OS check', () => {
    const seen: Array<[number, number | null]> = [];
    classifyPaneLiveness('0:4242::$3:991', (pid, serverPid) => {
      seen.push([pid, serverPid]);
      return true;
    });
    expect(seen).toEqual([[4242, 991]]);
  });
});

describe('readPaneProcessAlive', () => {
  it('reads a running process as alive on Linux', () => {
    expect(readPaneProcessAlive(4242, {
      platform: 'linux',
      readFile: () => '4242 (claude) S 1 4242 4242 0 -1',
    })).toBe(true);
  });

  it('reads a missing /proc entry as gone on Linux', () => {
    expect(readPaneProcessAlive(4242, {
      platform: 'linux',
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    })).toBe(false);
  });

  it('reads an unreaped zombie as gone on Linux', () => {
    expect(readPaneProcessAlive(4242, {
      platform: 'linux',
      readFile: () => '4242 (claude) Z 1 4242 4242 0 -1',
    })).toBe(false);
  });

  it('is undecided when /proc cannot be read for another reason', () => {
    expect(readPaneProcessAlive(4242, {
      platform: 'linux',
      readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    })).toBeNull();
  });

  it('is undecided on an unparsable stat line', () => {
    expect(readPaneProcessAlive(4242, { platform: 'linux', readFile: () => 'garbage' })).toBeNull();
  });

  it('distinguishes ESRCH from EPERM where /proc is unavailable', () => {
    const signal = (code: string | null) => () => {
      throw Object.assign(new Error(code ?? 'weird'), { code: code ?? 'EWEIRD' });
    };
    expect(readPaneProcessAlive(4242, { platform: 'darwin', signal: () => {} })).toBe(true);
    expect(readPaneProcessAlive(4242, { platform: 'darwin', signal: signal('ESRCH') })).toBe(false);
    expect(readPaneProcessAlive(4242, { platform: 'darwin', signal: signal('EPERM') })).toBe(true);
    expect(readPaneProcessAlive(4242, { platform: 'darwin', signal: signal(null) })).toBeNull();
  });

  it('treats an invalid pid as undecided, not as a death', () => {
    expect(readPaneProcessAlive(0, { platform: 'linux', readFile: () => '' })).toBeNull();
    expect(readPaneProcessAlive(-1)).toBeNull();
    expect(readPaneProcessAlive(Number.NaN)).toBeNull();
  });
});

describe('readPaneProcessAliveForServer', () => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

  it('does not read an absent pane pid as death when the server itself is invisible', () => {
    // A container looking at a host tmux server through a mounted socket: the
    // pane pid is not in OUR /proc, but the pane may be perfectly alive.
    expect(readPaneProcessAliveForServer(4242, 991, {
      platform: 'linux',
      readFile: (path) => (path.includes('/991/') ? enoent() : enoent()),
    })).toBeNull();
  });

  it('does not read an absent pane pid as death when the server pid is missing', () => {
    expect(readPaneProcessAliveForServer(4242, null, {
      platform: 'linux',
      readFile: () => enoent(),
    })).toBeNull();
  });

  it('trusts the pane pid once the server is visible in the same /proc', () => {
    const readFile = (path: string) => {
      if (path.includes('/991/')) return '991 (tmux) S 1 991 991 0 -1';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(readPaneProcessAliveForServer(4242, 991, { platform: 'linux', readFile })).toBe(false);
  });

  it('does not need a server pid where kill(pid, 0) is authoritative', () => {
    expect(readPaneProcessAliveForServer(4242, null, {
      platform: 'darwin',
      signal: () => {},
    })).toBe(true);
  });
});

/**
 * Fake tmux: answers the two queries the launch probe makes, so the wiring
 * (which verdict becomes 'missing', and whether anything is killed) is driven
 * through the REAL TmuxBackend code without a live server.
 */
const FAKE = `#!/bin/sh
log="\${FAKE_TMUX_LOG:-}"
[ -n "$log" ] && printf '%s\\n' "$*" >> "$log"
killflag="\${FAKE_TMUX_KILLFLAG:-}"
cmd=""
for arg in "$@"; do
  case "$arg" in
    has-session|display-message|kill-session|if-shell) cmd="$arg"; break ;;
  esac
done
case "$cmd" in
  has-session)
    [ -n "$killflag" ] && [ -f "$killflag" ] && exit 1
    exit 0 ;;
  display-message)
    if [ -n "\${FAKE_TMUX_DISPLAY_COUNTER:-}" ]; then
      n=0
      [ -f "$FAKE_TMUX_DISPLAY_COUNTER" ] && n=$(cat "$FAKE_TMUX_DISPLAY_COUNTER")
      n=$((n + 1))
      printf '%s' "$n" > "$FAKE_TMUX_DISPLAY_COUNTER"
      if [ "$n" -le "\${FAKE_TMUX_GARBLE_READS:-0}" ]; then
        printf 'not a liveness answer'
        exit 0
      fi
    fi
    printf '%s' "\${FAKE_TMUX_DISPLAY:-}"
    exit "\${FAKE_TMUX_DISPLAY_EXIT:-0}" ;;
  kill-session)
    [ -n "$killflag" ] && : > "$killflag"
    exit 0 ;;
  if-shell)
    owner="\${FAKE_TMUX_OWNER_PID:-}"
    match=1
    case "$*" in
      *#{==:#{pid},*)
        match=0
        case "$*" in
          *"#{==:#{pid},$owner}"*) match=1 ;;
        esac ;;
    esac
    if [ "$match" = 1 ]; then
      [ -n "$killflag" ] && : > "$killflag"
      printf 'killed'
    else
      printf 'not-ours'
    fi
    exit 0 ;;
esac
exit 0
`;

describe('probeSessionForLaunch liveness wiring', () => {
  let dir: string;
  let logPath: string;
  let killFlag: string;
  const saved: Record<string, string | undefined> = {};
  const FAKE_ENV = [
    'PATH', 'FAKE_TMUX_LOG', 'FAKE_TMUX_DISPLAY', 'FAKE_TMUX_DISPLAY_EXIT',
    'FAKE_TMUX_KILLFLAG', 'FAKE_TMUX_OWNER_PID',
    'FAKE_TMUX_DISPLAY_COUNTER', 'FAKE_TMUX_GARBLE_READS',
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmx-liveness-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), FAKE, { mode: 0o755 });
    logPath = join(dir, 'calls.log');
    killFlag = join(dir, 'killed');
    for (const key of FAKE_ENV) saved[key] = process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FAKE_TMUX_LOG = logPath;
    process.env.FAKE_TMUX_KILLFLAG = killFlag;
    process.env.FAKE_TMUX_OWNER_PID = String(process.pid);
    for (const key of ['FAKE_TMUX_DISPLAY', 'FAKE_TMUX_DISPLAY_EXIT',
      'FAKE_TMUX_DISPLAY_COUNTER', 'FAKE_TMUX_GARBLE_READS']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSandboxScratch(dir);
  });

  const calls = (): string => {
    try { return readFileSync(logPath, 'utf8'); } catch { return ''; }
  };
  const displayReads = (): string[] => calls().split('\n')
    .filter(line => /-L fake display-message /.test(line));

  it('reports a retained corpse as missing and reaps that exact session', () => {
    process.env.FAKE_TMUX_DISPLAY = `1::77:$7:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    const log = calls();
    expect(log).toMatch(/display-message/);
    expect(log).toMatch(/-L fake if-shell .*kill-session -t '\$7'/);
    expect(existsSync(killFlag)).toBe(true);
  });

  it('reports a pane whose process is gone as missing and reaps it', () => {
    process.env.FAKE_TMUX_DISPLAY = `0:${reapedPid()}::$8:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    expect(calls()).toMatch(/if-shell .*kill-session -t '\$8'/);
  });

  it('keeps reattaching to a live pane and never kills it', () => {
    process.env.FAKE_TMUX_DISPLAY = `0:${process.pid}::$9:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
  });

  it('keeps reattaching (and kills nothing) when the liveness probe cannot answer', () => {
    process.env.FAKE_TMUX_DISPLAY_EXIT = '1';
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
    // A bounded retry happened, but never a kill.
    expect(displayReads()).toHaveLength(2);
  });

  it('keeps reattaching (and kills nothing) on a garbled liveness answer', () => {
    process.env.FAKE_TMUX_DISPLAY = 'target pane has exited';
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
  });

  it('does not kill when an UNKNOWN answer still carried a valid session id', () => {
    // pid 1 is never probeable, so the verdict is 'unknown' — a session id in
    // the same answer must not be turned into a kill target.
    process.env.FAKE_TMUX_DISPLAY = `0:1::$5:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
  });

  it('retries an unreadable liveness read and uses the decisive second answer', () => {
    process.env.FAKE_TMUX_DISPLAY_COUNTER = join(dir, 'reads');
    process.env.FAKE_TMUX_GARBLE_READS = '1';
    process.env.FAKE_TMUX_DISPLAY = `0:${reapedPid()}::$10:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    expect(displayReads()).toHaveLength(2);
    expect(existsSync(killFlag)).toBe(true);
  });

  it('never treats an invisible server pid as proof of a dead pane', () => {
    // The pane pid is a reaped one, but the "server" pid is reaped too: on
    // Linux that means this process cannot see the server's pid namespace, so
    // the absent pane pid proves nothing and nothing may be killed.
    if (process.platform !== 'linux') return;
    process.env.FAKE_TMUX_DISPLAY = `0:${reapedPid()}::$6:${reapedPid()}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
  });

  it('kills only when the answering server still owns that exact session', () => {
    // The answer came from server `process.pid`; the fake pretends the current
    // owner is another server, so the atomic if-shell condition must fail.
    process.env.FAKE_TMUX_OWNER_PID = '999999';
    process.env.FAKE_TMUX_DISPLAY = `0:${reapedPid()}::$11:${process.pid}`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    const log = calls();
    expect(log).toContain(`#{==:#{pid},${process.pid}}`);
    expect(log).toContain('#{==:#{session_id},$11}');
    expect(log).toMatch(/if-shell/);
    expect(existsSync(killFlag)).toBe(false);
  });

  it('does not kill by name when the answer carried no session id', () => {
    process.env.FAKE_TMUX_DISPLAY = `1::77:${process.pid}`;
    // Without a session id the corpse cannot be safely reaped; keep the old
    // reattach behaviour rather than kill something we cannot identify.
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/if-shell|kill-session/);
  });

  it('leaves an absent session at "missing" without probing liveness', () => {
    writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh
log="\${FAKE_TMUX_LOG:-}"
[ -n "$log" ] && printf '%s\\n' "$*" >> "$log"
for arg in "$@"; do
  case "$arg" in
    has-session) exit 1 ;;
  esac
done
exit 0
`, { mode: 0o755 });
    expect(TmuxBackend.probeSessionForLaunch('bmx-absent', 'fake')).toBe('missing');
    expect(calls()).not.toMatch(/display-message|if-shell|kill-session/);
  });
});

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional */ }

describe.skipIf(!realTmux)('launch selection on a real tmux server', () => {
  let dir: string;
  let socket: string;
  let binDir: string;
  const saved: Record<string, string | undefined> = {};

  const tmux = (...args: string[]) => spawnSync(realTmux!, ['-S', socket, ...args], { encoding: 'utf8', timeout: 5_000 });
  const writeShim = (script: string) => writeFileSync(join(binDir, 'tmux'), script, { mode: 0o755 });

  const waitForCorpse = async (name: string) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const line = String(tmux('display-message', '-p', '-t', name, '#{pane_dead}').stdout ?? '').trim();
      if (line === '1') return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmx-liveness-real-'));
    socket = join(dir, 'socket');
    binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeShim(`#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`);
    for (const key of ['PATH', 'SHELL']) saved[key] = process.env[key];
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.SHELL = '/bin/sh';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tmux('kill-server');
    rmSandboxScratch(dir);
  });

  it('reaps a retained corpse so the same name can be rebuilt', async () => {
    tmux('new-session', '-d', '-s', 'bmx-dead', 'sh -c "exit 77"', ';', 'set-option', '-t', 'bmx-dead', 'remain-on-exit', 'on');
    expect(await waitForCorpse('bmx-dead')).toBe(true);
    expect(tmux('has-session', '-t', 'bmx-dead').status).toBe(0);

    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', socket)).toBe('missing');

    expect(tmux('has-session', '-t', 'bmx-dead').status).not.toBe(0);
    // The cold path must be able to create this session name again.
    expect(tmux('new-session', '-d', '-s', 'bmx-dead', 'sleep 60').status).toBe(0);
  });

  it('leaves a live pane reattachable and untouched', () => {
    expect(tmux('new-session', '-d', '-s', 'bmx-live', 'sleep 60').status).toBe(0);
    const panePid = String(tmux('display-message', '-p', '-t', 'bmx-live', '#{pane_pid}').stdout ?? '').trim();
    expect(panePid).toMatch(/^[1-9]\d*$/);

    expect(TmuxBackend.probeSessionForLaunch('bmx-live', socket)).toBe('exists');

    expect(tmux('has-session', '-t', 'bmx-live').status).toBe(0);
    expect(String(tmux('display-message', '-p', '-t', 'bmx-live', '#{pane_pid}').stdout ?? '').trim()).toBe(panePid);
  });

  it('never kills a live session when the liveness probe cannot answer', () => {
    expect(tmux('new-session', '-d', '-s', 'bmx-uncertain', 'sleep 60').status).toBe(0);
    // has-session / kill-session reach the real server; only the liveness read
    // fails, which is exactly "tmux answered existence but not liveness".
    writeShim(`#!/bin/sh
for arg in "$@"; do
  [ "$arg" = "display-message" ] && exit 1
done
exec '${realTmux}' -S '${socket}' "$@"
`);

    expect(TmuxBackend.probeSessionForLaunch('bmx-uncertain', socket)).toBe('exists');
    expect(tmux('has-session', '-t', 'bmx-uncertain').status).toBe(0);
  });
});

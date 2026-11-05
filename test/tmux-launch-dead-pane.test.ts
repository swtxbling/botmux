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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import {
  classifyPaneLiveness,
  readPaneProcessAlive,
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
      liveness: 'dead', panePid: null, deathStatus: 77, sessionId: '$3',
    });
  });

  it('keeps a corpse dead even when a pid was reused by a live process', () => {
    expect(classifyPaneLiveness('1:42::$3', () => true).liveness).toBe('dead');
  });

  it('treats pane_dead=0 with a gone pane process as dead', () => {
    expect(classifyPaneLiveness('0:4242::$3', () => false)).toEqual({
      liveness: 'dead', panePid: 4242, deathStatus: null, sessionId: '$3',
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

/**
 * Fake tmux: answers the two queries the launch probe makes, so the wiring
 * (which verdict becomes 'missing', and whether anything is killed) is driven
 * through the REAL TmuxBackend code without a live server.
 */
describe('probeSessionForLaunch liveness wiring', () => {
  let dir: string;
  let logPath: string;
  const saved: Record<string, string | undefined> = {};

  const FAKE = `#!/bin/sh
log="\${FAKE_TMUX_LOG:-}"
[ -n "$log" ] && printf '%s\\n' "$*" >> "$log"
for arg in "$@"; do
  case "$arg" in
    has-session) exit 0 ;;
    display-message)
      printf '%s' "\${FAKE_TMUX_DISPLAY:-}"
      exit "\${FAKE_TMUX_DISPLAY_EXIT:-0}" ;;
    kill-session) exit 0 ;;
  esac
done
exit 0
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bmx-liveness-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), FAKE, { mode: 0o755 });
    logPath = join(dir, 'calls.log');
    for (const key of ['PATH', 'FAKE_TMUX_LOG', 'FAKE_TMUX_DISPLAY', 'FAKE_TMUX_DISPLAY_EXIT']) {
      saved[key] = process.env[key];
    }
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FAKE_TMUX_LOG = logPath;
    delete process.env.FAKE_TMUX_DISPLAY;
    delete process.env.FAKE_TMUX_DISPLAY_EXIT;
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

  it('reports a retained corpse as missing and reaps that exact session', () => {
    process.env.FAKE_TMUX_DISPLAY = '1::77:$7';
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    const log = calls();
    expect(log).toMatch(/display-message/);
    expect(log).toMatch(/-L fake kill-session -t \$7/);
  });

  it('reports a pane whose process is gone as missing and reaps it', () => {
    process.env.FAKE_TMUX_DISPLAY = `0:${reapedPid()}::$8`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    expect(calls()).toMatch(/kill-session -t \$8/);
  });

  it('keeps reattaching to a live pane and never kills it', () => {
    process.env.FAKE_TMUX_DISPLAY = `0:${process.pid}::$9`;
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/kill-session/);
  });

  it('keeps reattaching (and kills nothing) when the liveness probe cannot answer', () => {
    process.env.FAKE_TMUX_DISPLAY_EXIT = '1';
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/kill-session/);
  });

  it('keeps reattaching (and kills nothing) on a garbled liveness answer', () => {
    process.env.FAKE_TMUX_DISPLAY = 'target pane has exited';
    expect(TmuxBackend.probeSessionForLaunch('bmx-live', 'fake')).toBe('exists');
    expect(calls()).not.toMatch(/kill-session/);
  });

  it('does not kill by name when the answer carried no session id', () => {
    process.env.FAKE_TMUX_DISPLAY = '1::77:';
    expect(TmuxBackend.probeSessionForLaunch('bmx-dead', 'fake')).toBe('missing');
    expect(calls()).not.toMatch(/kill-session/);
  });

  it('leaves an absent session at "missing" without probing liveness', () => {
    // has-session is the only call that should happen; give the fake a
    // display answer that would otherwise read as dead.
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
    expect(calls()).not.toMatch(/display-message|kill-session/);
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

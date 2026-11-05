// test/restore-cwd-probe.test.ts
//
// Unit coverage for the bounded per-session working-directory probe used by
// daemon startup restore. The regression it guards: restore runs BEFORE the
// Feishu event dispatchers start, so one unresponsive session cwd (macOS TCC
// prompt pending, external disk unplugged, dead mount) used to block daemon
// startup and take every bot offline.
//
// Two properties matter and are asserted here:
//   1. the check runs OUT OF PROCESS, so a hung directory never occupies a
//      libuv thread-pool slot of the daemon (an `fs.promises.stat` on a hung
//      path cannot be cancelled and would starve `dns.lookup` too);
//   2. ALL probes share ONE overall deadline, so startup delay is bounded by
//      that deadline no matter how many directories hang.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createSubprocessCwdProbe,
  defaultRestoreCwdProbe,
  probeRestoreSessionCwds,
  RESTORE_CWD_PROBE_TIMEOUT_MS,
} from '../src/core/restore-cwd-probe.js';
import { logger } from '../src/utils/logger.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** A probe that never answers, modelling a dead mount. */
const hangingProbe = (): Promise<void> => new Promise<void>(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeRestoreSessionCwds', () => {
  it('classifies a usable directory as ok without logging', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-good', cwd: '/tmp' },
    ], { probe: async () => {}, timeoutMs: 1000 });
    expect(results.get('sess-good')).toEqual({ status: 'ok' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds a hanging directory by the deadline and explains it with id, cwd and remedy', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-hung', cwd: '/cwd-that-never-answers' },
    ], { probe: hangingProbe, timeoutMs: 25 });
    const elapsed = Date.now() - started;

    expect(results.get('sess-hung')?.status).toBe('timeout');
    expect(elapsed).toBeLessThan(1000);
    const line = warn.mock.calls.map(call => String(call[0])).find(text => text.includes('sess-hung'));
    expect(line).toBeDefined();
    expect(line).toContain('/cwd-that-never-answers');
    expect(line).toContain('timeout');
    expect(line).toContain('/repo');
    expect(line).toContain('/cd');
  });

  it('bounds N=8 hanging directories by ONE deadline, not one deadline per batch', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const targets = Array.from({ length: 8 }, (_, index) => ({
      sessionId: `sess-${index}`,
      cwd: `/hung/${index}`,
    }));
    const started = Date.now();
    const results = await probeRestoreSessionCwds(targets, { probe: hangingProbe, timeoutMs: 60 });
    const elapsed = Date.now() - started;

    expect([...results.values()].every(result => result.status === 'timeout')).toBe(true);
    // Serialized batches would take ceil(8/4) * 60ms = 120ms; one deadline is 60ms.
    expect(elapsed).toBeLessThan(120);
  });

  it('still returns at the one deadline when there are more directories than probe slots', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const probe = vi.fn(hangingProbe);
    const targets = Array.from({ length: 40 }, (_, index) => ({
      sessionId: `sess-${index}`,
      cwd: `/hung/${index}`,
    }));
    const started = Date.now();
    const results = await probeRestoreSessionCwds(targets, { probe, timeoutMs: 50, concurrency: 8 });
    const elapsed = Date.now() - started;

    expect([...results.values()].every(result => result.status === 'timeout')).toBe(true);
    expect(results.size).toBe(40);
    // Only one batch is started; the rest are classified at the deadline without spawning.
    expect(probe).toHaveBeenCalledTimes(8);
    expect(elapsed).toBeLessThan(150);
  });

  it('does not consume the daemon file-system thread pool when probes hang', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // Six children that hang like a dead mount. Their own kill deadline (250ms)
    // is longer than the overall probe deadline (120ms), so they are still
    // hanging while the assertion below runs.
    const hungChildren = createSubprocessCwdProbe({
      args: () => ['-c', 'sleep 5'],
      timeoutMs: 250,
    });
    const targets = Array.from({ length: 6 }, (_, index) => ({
      sessionId: `sess-hung-${index}`,
      cwd: `/hung/${index}`,
    }));
    let probesFinished = false;
    const probing = probeRestoreSessionCwds(targets, {
      probe: hungChildren,
      timeoutMs: 120,
    }).then((results) => {
      probesFinished = true;
      return results;
    });

    await sleep(40);
    // A plain async fs call in the daemon process must still get a pool slot. It
    // would stall if the hung checks were `fs.promises.stat` calls.
    const started = Date.now();
    const content = await Promise.race([
      readFile('/etc/hostname', 'utf8'),
      sleep(800).then(() => { throw new Error('daemon fs pool starved by hung cwd probes'); }),
    ]);
    expect(typeof content).toBe('string');
    expect(Date.now() - started).toBeLessThan(400);
    // The children were still hung when we proved the pool is free.
    expect(probesFinished).toBe(false);

    const results = await probing;
    expect([...results.values()].every(result => result.status === 'timeout')).toBe(true);
    // Let the child kill timers fire so no `sleep` process outlives this test.
    await sleep(250);
  });

  it('distinguishes missing, not-a-directory and unreadable answers', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-missing', cwd: '/nonexistent-restore-cwd-probe-test' },
      { sessionId: 'sess-file', cwd: '/etc/hostname' },
      { sessionId: 'sess-ok', cwd: '/tmp' },
    ], { probe: defaultRestoreCwdProbe, timeoutMs: 1000 });
    // /etc/hostname exists on Linux and is not a directory; on hosts where it
    // does not exist the classification is still a non-ok, non-timeout answer.
    expect(results.get('sess-missing')?.status).toBe('missing');
    expect(['not_directory', 'missing', 'unreadable']).toContain(results.get('sess-file')?.status);
    expect(results.get('sess-ok')?.status).toBe('ok');

    const unreadable = await probeRestoreSessionCwds([
      { sessionId: 'sess-denied', cwd: '/root' },
    ], {
      probe: async () => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      timeoutMs: 1000,
    });
    expect(unreadable.get('sess-denied')).toEqual({
      status: 'unreadable',
      detail: expect.stringContaining('EACCES'),
    });
  });

  it('never throws when the probe rejects with an unknown error', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(probeRestoreSessionCwds([
      { sessionId: 'sess-boom', cwd: '/boom' },
    ], {
      probe: async () => { throw new Error('input/output error'); },
      timeoutMs: 1000,
    })).resolves.toBeInstanceOf(Map);
  });

  it('probes a directory shared by many sessions only once', async () => {
    const probe = vi.fn(async () => {});
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-1', cwd: '/one/shared/root' },
      { sessionId: 'sess-2', cwd: '/one/shared/root' },
      { sessionId: 'sess-3', cwd: '/one/shared/root' },
    ], { probe, timeoutMs: 1000 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect([...results.values()].every(result => result.status === 'ok')).toBe(true);
    expect([...results.keys()].sort()).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });

  it('exposes a finite default deadline so a hung probe cannot stall boot forever', () => {
    expect(Number.isFinite(RESTORE_CWD_PROBE_TIMEOUT_MS)).toBe(true);
    expect(RESTORE_CWD_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RESTORE_CWD_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

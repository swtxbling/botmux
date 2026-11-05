// test/restore-cwd-probe.test.ts
//
// Unit coverage for the bounded per-session working-directory probe used by
// daemon startup restore. The regression it guards: restore runs BEFORE the
// Feishu event dispatchers start, so one unresponsive session cwd (macOS TCC
// prompt pending, external disk unplugged, dead mount) used to block daemon
// startup and take every bot offline. The probe must be concurrent, bounded,
// and must never throw or drop a session.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  probeRestoreSessionCwds,
  RESTORE_CWD_PROBE_TIMEOUT_MS,
} from '../src/core/restore-cwd-probe.js';
import { logger } from '../src/utils/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeRestoreSessionCwds', () => {
  it('classifies a usable directory as ok without logging', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-good', cwd: '/tmp' },
    ], async () => {}, 1000);
    expect(results.get('sess-good')).toEqual({ status: 'ok' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds a hanging directory by the timeout and explains it with id, cwd and remedy', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-hung', cwd: '/cwd-that-never-answers' },
    ], () => new Promise<void>(() => {}), 25);
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

  it('probes sessions concurrently so total startup delay is one timeout, not N', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-a', cwd: '/a' },
      { sessionId: 'sess-b', cwd: '/b' },
      { sessionId: 'sess-c', cwd: '/c' },
    ], () => new Promise<void>(() => {}), 40);
    const elapsed = Date.now() - started;

    expect([...results.values()].every(result => result.status === 'timeout')).toBe(true);
    // Three serialized 40ms timeouts would exceed 120ms.
    expect(elapsed).toBeLessThan(110);
  });

  it('distinguishes missing, not-a-directory and unreadable answers', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { probeRestoreSessionCwds: probe } = await import('../src/core/restore-cwd-probe.js');
    const results = await probe([
      { sessionId: 'sess-missing', cwd: '/nonexistent-restore-cwd-probe-test' },
      { sessionId: 'sess-file', cwd: '/etc/hostname' },
    ], undefined, 1000);
    // /etc/hostname exists on Linux and is not a directory; on hosts where it
    // does not exist the classification is still a non-ok, non-timeout answer.
    expect(results.get('sess-missing')?.status).toBe('missing');
    expect(['not_directory', 'missing', 'unreadable']).toContain(results.get('sess-file')?.status);

    const unreadable = await probe([
      { sessionId: 'sess-denied', cwd: '/root' },
    ], async () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }, 1000);
    expect(unreadable.get('sess-denied')).toEqual({
      status: 'unreadable',
      detail: expect.stringContaining('EACCES'),
    });
  });

  it('never throws when the probe rejects with an unknown error', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(probeRestoreSessionCwds([
      { sessionId: 'sess-boom', cwd: '/boom' },
    ], async () => { throw new Error('input/output error'); }, 1000)).resolves.toBeInstanceOf(Map);
  });

  it('probes a directory shared by many sessions only once', async () => {
    const probe = vi.fn(async () => {});
    const results = await probeRestoreSessionCwds([
      { sessionId: 'sess-1', cwd: '/one/shared/root' },
      { sessionId: 'sess-2', cwd: '/one/shared/root' },
      { sessionId: 'sess-3', cwd: '/one/shared/root' },
    ], probe, 1000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect([...results.values()].every(result => result.status === 'ok')).toBe(true);
    expect([...results.keys()].sort()).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });

  it('exposes a finite default timeout so a hung probe cannot stall boot forever', () => {
    expect(Number.isFinite(RESTORE_CWD_PROBE_TIMEOUT_MS)).toBe(true);
    expect(RESTORE_CWD_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RESTORE_CWD_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

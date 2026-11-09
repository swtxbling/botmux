/**
 * 群级默认目录（chatWorkingDirs）持久化与「不改权限」语义。
 *
 * Run: pnpm vitest run test/chat-working-dir-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/chat-working-dir-store.js');
  return { registry, store };
}

describe('chat-working-dir store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-chat-dir-store-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code',
    }], null, 2), 'utf-8');
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
  });

  const readEntry = () => JSON.parse(readFileSync(configPath, 'utf-8'))[0];

  it('bind persists, updates in memory, and does not create an oncall binding', async () => {
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.bindChatWorkingDir('app_a', 'oc_1', '~/repo');
    expect(r).toMatchObject({ ok: true, created: true });
    expect(readEntry().chatWorkingDirs).toEqual([{ chatId: 'oc_1', workingDir: '~/repo' }]);
    expect(readEntry().oncallChats).toBeUndefined();
    expect(registry.findChatWorkingDir('app_a', 'oc_1')?.workingDir).toBe('~/repo');
    expect(registry.findChatBoundWorkingDir('app_a', 'oc_1')).toBe('~/repo');
    expect(registry.findChatBoundWorkingDir('app_a', 'oc_2')).toBeUndefined();
    // 权限判断只看 oncall：群级默认目录不会让 findOncallChat 命中。
    expect(registry.findOncallChat('app_a', 'oc_1')).toBeUndefined();

    const again = await store.bindChatWorkingDir('app_a', 'oc_1', '~/repo2');
    expect(again).toMatchObject({ ok: true, created: false });
    expect(readEntry().chatWorkingDirs).toEqual([{ chatId: 'oc_1', workingDir: '~/repo2' }]);
  });

  it('unbind is idempotent and removes the entry', async () => {
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    await store.bindChatWorkingDir('app_a', 'oc_1', '~/repo');

    expect(await store.unbindChatWorkingDir('app_a', 'oc_1')).toEqual({ ok: true, wasBound: true });
    expect(readEntry().chatWorkingDirs).toEqual([]);
    expect(registry.findChatWorkingDir('app_a', 'oc_1')).toBeUndefined();
    expect(await store.unbindChatWorkingDir('app_a', 'oc_1')).toEqual({ ok: true, wasBound: false });
  });

  it('loader parses chatWorkingDirs and drops malformed entries', async () => {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code',
      chatWorkingDirs: [{ chatId: 'oc_1', workingDir: '/x' }, { chatId: 1 }, null],
    }]), 'utf-8');
    const { registry } = await freshModules();
    const [cfg] = registry.loadBotConfigs();
    expect(cfg.chatWorkingDirs).toEqual([{ chatId: 'oc_1', workingDir: '/x' }]);
  });

  it('webhook 外部事件新会话也落到群级默认目录，且不走 bot 默认目录的 auto-worktree', async () => {
    const chatDir = mkdtempSync(join(tmpdir(), 'botmux-chat-dir-repo-'));
    const defDir = mkdtempSync(join(tmpdir(), 'botmux-chat-dir-def-'));
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code',
      defaultWorkingDir: defDir,
      chatWorkingDirs: [{ chatId: 'oc_1', workingDir: chatDir }],
    }]), 'utf-8');
    const { registry } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const trigger = await import('../src/core/trigger-session.js');
    expect(trigger.__testOnly_resolveWorkingDir('app_a', 'oc_1')).toMatchObject({ ok: true, fromBotDefault: false });
    expect((trigger.__testOnly_resolveWorkingDir('app_a', 'oc_1') as any).workingDir).toContain('botmux-chat-dir-repo-');
    expect(trigger.__testOnly_resolveWorkingDir('app_a', 'oc_2')).toMatchObject({ ok: true, fromBotDefault: true });
  }, 60_000);

  it('defaultOncall 自动绑定跳过已设群级默认目录的群（不偷偷开放权限）', async () => {
    const defDir = mkdtempSync(join(tmpdir(), 'botmux-chat-dir-oncall-'));
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code',
      defaultOncall: { enabled: true, workingDir: defDir, since: 1 },
      chatWorkingDirs: [{ chatId: 'oc_1', workingDir: '/x' }],
    }]), 'utf-8');
    const { registry } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const oncall = await import('../src/services/oncall-store.js');
    expect(await oncall.ensureDefaultOncallBound('app_a', 'oc_1', 'group')).toBeUndefined();
    expect(registry.findOncallChat('app_a', 'oc_1')).toBeUndefined();
  });

  it('oncall binding takes precedence in findChatBoundWorkingDir', async () => {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code',
      oncallChats: [{ chatId: 'oc_1', workingDir: '/oncall' }],
      chatWorkingDirs: [{ chatId: 'oc_1', workingDir: '/chat' }],
    }]), 'utf-8');
    const { registry } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    expect(registry.findChatBoundWorkingDir('app_a', 'oc_1')).toBe('/oncall');
  });
});

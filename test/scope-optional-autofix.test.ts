/**
 * Startup scope self-check (checkRequiredScopes) and VC-event auto-subscribe
 * (ensureVcMeetingEventsSubscribed) in src/im/lark/event-dispatcher.ts, driven
 * through their real entry points: the Lark HTTP calls go through a stubbed
 * global fetch, while the Open Platform automation and the admin DM transport
 * are mocked at their module boundaries.
 *
 * What must hold (PR #715 and follow-ups):
 *  - All critical scopes granted + an optional one missing → a SILENT, QR-free
 *    top-up that requests only the missing scope and forwards the per-bucket
 *    granted set; nothing missing → no automation; a failed top-up changes nothing.
 *  - App stuck in review: DM the admin once per pending version, and only count it
 *    as notified once the DM was actually delivered (mark-then-send = one failure
 *    silences that version forever).
 *  - 99991672 (no self_manage): request every botmux-required scope in one shot,
 *    not the full manifest; fall back to the manual DM only when the auto-fix failed.
 *  - VC events: skip non-feishu / VC-inactive bots, probe read-only first, publish
 *    only when events are missing, never pop a QR at boot, DM only on failure.
 *
 * Run: bun run vitest run test/scope-optional-autofix.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: undefined as any,
  automate: vi.fn(),
  probe: vi.fn(),
  hints: vi.fn(),
  dm: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: () => h.bot,
}));
vi.mock('../src/setup/open-platform-automation.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  automateOpenPlatformSetup: h.automate,
  probeVcMeetingEventSubscription: h.probe,
  inspectUnderReviewConfigHints: h.hints,
}));
vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  sendUserMessage: h.dm,
}));

import { checkRequiredScopes, ensureVcMeetingEventsSubscribed } from '../src/im/lark/event-dispatcher.js';
import { readDefaultScopeManifest } from '../src/setup/open-platform-automation.js';
import { BOTMUX_REQUIRED_SCOPES, DOC_FEATURE_SCOPES } from '../src/setup/verify-permissions.js';
import { putDocSubscription, removeDocSubscription } from '../src/services/doc-subs-store.js';

const APP = 'cli_scope_selfcheck';
const makeBot = (config: Record<string, unknown> = {}) => ({
  config: { larkAppId: APP, larkAppSecret: 'secret', brand: 'feishu', vcMeetingAgent: { enabled: false }, ...config },
  resolvedAllowedUsers: ['ou_admin'],
  botName: 'ScopeBot',
});

/** Lark app-info stub: `granted` scopes in both token buckets, or an error `code`. */
function stubLark(app: { granted?: string[]; code?: number }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't' });
    if (app.code !== undefined) return Response.json({ code: app.code, msg: 'denied' });
    return Response.json({ code: 0, data: { app: {
      scopes: (app.granted ?? []).map(scope => ({ scope, token_types: ['tenant', 'user'] })),
    } } });
  }));
}

const manifest = readDefaultScopeManifest();
const inManifest = (name: string) => manifest.scopes.tenant.includes(name) || manifest.scopes.user.includes(name);
const critical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).map(s => s.name);
const optional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical).map(s => s.name);
const requested = (call: number): string[] => {
  const scopes = h.automate.mock.calls[call]![0].scopeManifest.scopes;
  return [...new Set([...scopes.tenant, ...scopes.user])].sort();
};
const applied = { ok: true, scopeCount: 1, skippedScopeCount: 0, privilegeRangeCount: 0, subscribedEventCount: 0, versionId: 'v9' };
const underReview = (inReviewVersionId: string) => ({ ok: false, reason: 'app_under_review', message: '', inReviewVersionId });

// 每条用例一份干净的数据目录：启动自检的去重状态就落在这一层，共用目录会让
// 「重启后再跑一次」被上一条用例的记录污染。
let dataDir = '';
let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env.SESSION_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'scope-selfcheck-'));
  process.env.SESSION_DATA_DIR = dataDir;
  h.bot = makeBot();
  h.automate.mockReset();
  h.probe.mockReset();
  h.hints.mockReset().mockResolvedValue('');
  h.dm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = savedDataDir;
});

describe('checkRequiredScopes — optional-scope top-up', () => {
  it('runs no automation when every required scope is granted', async () => {
    stubLark({ granted: [...critical, ...optional] });
    await checkRequiredScopes(APP);
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('tops up only the missing optional scope, silently and without a QR, with the bucketed granted set', async () => {
    const missing = optional.find(inManifest)!;
    const granted = [...critical, ...optional.filter(name => name !== missing)];
    stubLark({ granted });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(h.automate).toHaveBeenCalledTimes(1);
    expect(h.automate.mock.calls[0]![0]).toMatchObject({ disableQrLogin: true });
    expect(requested(0)).toEqual([missing]);
    expect(h.automate.mock.calls[0]![0].grantedScopeNames).toEqual({ tenant: granted, user: granted });
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('leaves a failed top-up (no cached web session) unannounced', async () => {
    stubLark({ granted: [...critical, ...optional.slice(1)] });
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await expect(checkRequiredScopes(APP)).resolves.toBeUndefined();
    expect(h.dm).not.toHaveBeenCalled();
  });
});

describe('checkRequiredScopes — app stuck in review', () => {
  it('DMs once per pending version, and counts it only after the DM was delivered', async () => {
    stubLark({ granted: optional });
    h.automate.mockResolvedValue(underReview('ver-1'));
    h.hints.mockResolvedValue('HINT-DATA-RANGE');
    h.dm.mockRejectedValueOnce(new Error('network down'));
    await checkRequiredScopes(APP); // delivery failed → not recorded
    await checkRequiredScopes(APP); // retried and delivered → recorded
    await checkRequiredScopes(APP); // same pending version → silent
    expect(h.dm).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls[1]![2]).toContain('HINT-DATA-RANGE');
    h.automate.mockResolvedValue(underReview('ver-2'));
    await checkRequiredScopes(APP); // a new pending version is news again
    expect(h.dm).toHaveBeenCalledTimes(3);
  });
});

describe('checkRequiredScopes — 99991672 (app lacks self_manage)', () => {
  it('requests every botmux-required scope in one shot, not the full manifest', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(requested(0)).toEqual(BOTMUX_REQUIRED_SCOPES.map(s => s.name).filter(inManifest).sort());
    expect(requested(0)).toContain('application:application:self_manage');
  });

  it('falls back to the manual self_manage DM only when the auto-fix failed', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(underReview('ver-x'));
    await checkRequiredScopes(APP);
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
    expect(h.dm.mock.calls[0]![2]).toContain('application:application:self_manage');
  });
});

describe('ensureVcMeetingEventsSubscribed', () => {
  const vcBot = (config: Record<string, unknown> = {}) => makeBot({ vcMeetingAgent: undefined, ...config });

  it('skips non-feishu, apiOnly and VC-disabled bots without probing', async () => {
    for (const bot of [vcBot({ brand: 'lark' }), vcBot({ apiOnly: true }), makeBot()]) {
      h.bot = bot;
      await ensureVcMeetingEventsSubscribed(APP);
    }
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('never publishes when the events are already subscribed', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: [], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.automate).not.toHaveBeenCalled();
  });

  it('subscribes missing events without a QR, and DMs the admin only when that fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: true, subscribedEventCount: 3, versionId: 'v1' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.automate).toHaveBeenCalledWith(expect.objectContaining({ disableQrLogin: true }));
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('degrades quietly when the read-only probe fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'no cached session' });
    await expect(ensureVcMeetingEventsSubscribed(APP)).resolves.toBeUndefined();
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });
});

/**
 * 启动自检提醒只发一次 —— 主人管 15 个 bot，fleet 每重启一次就是 15 条一模一样的
 * 私信。判据是「问题有没有变化」而不是「重启过几次」：内容没变不再发，缺的
 * scope 集合变了要发，修好之后又坏了要发，私信本身没发出去则不算发过。
 */
describe('checkRequiredScopes — 重启不重复私信', () => {
  const autofixFails = () => h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });

  it('同样的缺权限问题跨重启只发一条', async () => {
    stubLark({ granted: critical.slice(1) });
    autofixFails();
    await checkRequiredScopes(APP);
    await checkRequiredScopes(APP); // 第二次 daemon 启动
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('缺的权限集合变了就重新提醒', async () => {
    stubLark({ granted: critical.slice(1) });
    autofixFails();
    await checkRequiredScopes(APP);
    stubLark({ granted: critical.slice(2) }); // 又少了一项
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('补齐后再次缺失，会重新提醒（记录在自检通过时清掉）', async () => {
    stubLark({ granted: critical.slice(1) });
    autofixFails();
    await checkRequiredScopes(APP);
    stubLark({ granted: [...critical, ...optional] }); // 修好了
    await checkRequiredScopes(APP);
    stubLark({ granted: critical.slice(1) }); // 又坏了
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('自动补齐成功但版本没发布，第二步要再说一次（下一步动作不一样）', async () => {
    stubLark({ granted: critical.slice(1) });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP); // 已自动修复
    h.automate.mockResolvedValue({ ...applied, versionWarning: '版本还在草稿，没发布' });
    await checkRequiredScopes(APP); // 同样的 scope，但新版本没发布 → 权限不生效，要人工收尾
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('换了管理员就重新提醒（「已经说过」是对具体某个人说的）', async () => {
    stubLark({ granted: critical.slice(1) });
    autofixFails();
    await checkRequiredScopes(APP);
    h.bot = { ...makeBot(), resolvedAllowedUsers: ['ou_admin2'] };
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls[1]![0]).toBe(APP);
    expect(h.dm.mock.calls[1]![1]).toBe('ou_admin2');
  });

  it('私信没发出去不算发过（下一轮启动要重试）', async () => {
    stubLark({ granted: critical.slice(1) });
    autofixFails();
    h.dm.mockRejectedValueOnce(new Error('network down'));
    await checkRequiredScopes(APP); // 发送失败
    await checkRequiredScopes(APP); // 重试，这次成功
    await checkRequiredScopes(APP); // 已送达 → 不再发
    expect(h.dm).toHaveBeenCalledTimes(2);
  });
});

describe('ensureVcMeetingEventsSubscribed — 重启不重复私信', () => {
  const vcBot = () => makeBot({ vcMeetingAgent: undefined });

  it('同一个失败原因跨重启只发一条，修好后再坏会重新发', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom again (超时 60s)' });
    await ensureVcMeetingEventsSubscribed(APP); // 同样的失败，只是错误文本变了
    expect(h.dm).toHaveBeenCalledTimes(1);

    h.automate.mockResolvedValue({ ok: true, subscribedEventCount: 3, versionId: 'v1' });
    await ensureVcMeetingEventsSubscribed(APP); // 修好了
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP); // 又坏了
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('这台 bot 不该订阅 VC 事件时（功能关闭 / 非飞书）清掉旧记录，重新开启后再坏能再发', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.bot = makeBot(); // vcMeetingAgent.enabled=false
    await ensureVcMeetingEventsSubscribed(APP);
    h.bot = vcBot();
    await ensureVcMeetingEventsSubscribed(APP); // 再开，同一类失败 → 该再发
    expect(h.dm).toHaveBeenCalledTimes(2);
    h.bot = makeBot({ vcMeetingAgent: undefined, brand: 'lark' }); // 非 feishu 品牌
    await ensureVcMeetingEventsSubscribed(APP);
    h.bot = vcBot();
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(3);
  });

  it('事件已经订阅好了会清掉记录（删掉这一行则「修好又坏」不再提醒）', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: [], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP); // 已订阅 → 清记录
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP); // 又坏 → 该再发
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('probe 不可用（登录态缺失）不清记录：那时并不知道问题还在不在', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.probe.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'no cached session' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP); // 同一类失败还在 → 不再重复
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('失败原因换了一类就该重新提醒', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    h.automate.mockResolvedValue(underReview('ver-9'));
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(2);
  });
});

describe('checkRequiredScopes — 文档权限提醒去重', () => {
  const allRequiredGranted = () => stubLark({ granted: [...critical, ...optional] });
  const bindDoc = () => putDocSubscription(dataDir, APP, {
    fileToken: 'docTOKEN1', fileType: 'docx', sessionAnchor: 'chat:oc_1', scope: 'chat',
    chatId: 'oc_1', commentTriggerMode: 'all', managedBy: 'subscribe-lark-doc', createdAt: Date.now(),
  });

  it('同一个缺文档权限只发一次；退订再重新绑定同样的文档要重新发', async () => {
    allRequiredGranted();
    bindDoc();
    await checkRequiredScopes(APP);
    await checkRequiredScopes(APP); // 重启：同样缺 DOC_FEATURE_SCOPES
    expect(h.dm).toHaveBeenCalledTimes(1);
    expect(h.dm.mock.calls[0]![2]).toContain(DOC_FEATURE_SCOPES[0]!.name);

    removeDocSubscription(dataDir, APP, 'docTOKEN1');
    await checkRequiredScopes(APP); // 没有绑定 ⟹ 自检不适用，记录要清掉
    bindDoc();
    await checkRequiredScopes(APP); // 又绑上、还是缺同一批权限 ⟹ 该重新提醒
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('权限补齐后清掉记录', async () => {
    allRequiredGranted();
    bindDoc();
    await checkRequiredScopes(APP);
    stubLark({ granted: [...critical, ...optional, ...DOC_FEATURE_SCOPES.map(s => s.name)] });
    await checkRequiredScopes(APP); // 补齐
    allRequiredGranted();
    await checkRequiredScopes(APP); // 又缺
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('没有管理员可发时不留下记录（否则以后补上管理员也永远收不到）', async () => {
    allRequiredGranted();
    bindDoc();
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
    h.bot = { ...makeBot(), resolvedAllowedUsers: [] };
    await checkRequiredScopes(APP); // 没人可发 → 清记录
    h.bot = makeBot();
    await checkRequiredScopes(APP); // 有管理员了，还是缺 → 再发
    expect(h.dm).toHaveBeenCalledTimes(2);
  });
});

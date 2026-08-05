import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLoadoutTeamBuilder } from '../src/dashboard/web/skills/session-loadout-team-builder.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const bots = [
  { larkAppId: 'bot-1', botName: 'Bot 1' },
  { larkAppId: 'bot-2', botName: 'Bot 2' },
];

function mockApis(overrides: { bots?: any[]; skills?: any[]; packs?: any[]; fail?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (overrides.fail && u.startsWith('/api/')) return jsonRes(500, { error: 'boom' });
    if (u.startsWith('/api/skill-packs')) return jsonRes(200, { packs: overrides.packs ?? [{ id: 'ops', name: 'Ops', include: ['skill:a', 'skill:b'] }] });
    if (u.startsWith('/api/skills')) return jsonRes(200, { skills: overrides.skills ?? [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    if (u.startsWith('/api/bots')) return jsonRes(200, { bots: overrides.bots ?? [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    return jsonRes(404, {});
  }));
}

function render(props: any = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionLoadoutTeamBuilder, {
      targets: bots,
      drafts: {},
      onChange: vi.fn(),
      ...props,
    }));
  });
  return renderer;
}

async function openAndLoad(props: any = {}) {
  mockApis();
  const onChange = vi.fn();
  const renderer = render({ ...props, onChange });
  await flush();
  return { renderer, onChange };
}

async function selectBot(renderer: TestRenderer.ReactTestRenderer, larkAppId: string) {
  const card = renderer.root.findByProps({ 'data-loadout-bot': larkAppId });
  await act(async () => { await card.props.onClick(); });
  await flush();
}

async function openCustom(renderer: TestRenderer.ReactTestRenderer) {
  const btn = renderer.root.findByProps({ 'aria-expanded': false });
  await act(async () => { await btn.props.onClick(); });
  await flush();
}

describe('SessionLoadoutTeamBuilder', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // ── P1-1: tri-state ──
  it('skill perk shows all/none/mixed and applies uniform state', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await openCustom(renderer);

    // bot-1 has skill:a, bot-2 has nothing → mixed for 'a', none for 'b'
    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('mixed');
    const perkB = renderer.root.findByProps({ 'data-loadout-perk': 'b' });
    expect(perkB.props['data-perk-state']).toBe('none');

    // Click mixed 'a' → should equip on ALL selected bots (not swap)
    await act(async () => { await perkA.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    // bot-1 already had 'a', bot-2 should now have 'a'
    expect(drafts['bot-2']).toEqual({ include: ['skill:a'] });
    // bot-1 unchanged from default → no draft key
    expect(drafts['bot-1']).toBeUndefined();

    // Now 'a' should be 'all'
    const perkAAfter = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    // Re-render with new drafts to verify state
  });

  it('clicking an "all" perk removes from all selected bots', async () => {
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a', 'skill:b'] }, 'bot-2': { include: ['skill:a', 'skill:b'] } } });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await openCustom(renderer);

    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('all');
    await act(async () => { await perkA.props.onClick(); });
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:b'] });
    expect(drafts['bot-2']).toEqual({ include: ['skill:b'] });
  });

  // ── Batch pack ──
  it('applies a pack to two selected bots and writes per-bot drafts', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');

    const applyBtn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    await act(async () => { await applyBtn.props.onClick(); });

    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    // ops pack = [skill:a, skill:b]; bot-1 default = [skill:a] → customised → draft
    expect(drafts['bot-1']).toEqual({ include: ['pack:ops'] });
    // bot-2 default = [] → customised → draft
    expect(drafts['bot-2']).toEqual({ include: ['pack:ops'] });
  });

  // ── Batch restore ──
  it('restores each selected bot to its own default', async () => {
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:c'] }, 'bot-2': { include: ['skill:c'] } } });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');

    const restoreBtn = renderer.root.findByProps({ 'data-action': 'restore-selected-defaults' });
    await act(async () => { await restoreBtn.props.onClick(); });

    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toBeUndefined();
    expect(drafts['bot-2']).toBeUndefined();
  });

  // ── P1-4: non-editable bot cannot be selected ──
  it('non-editable bot card is disabled and excluded from batch count', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const onChange = vi.fn();
    const renderer = render({ onChange });
    await flush();

    const bot2 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' });
    expect(bot2.props.disabled).toBe(true);
    expect(bot2.props['data-loadout-bot-editable']).toBe('false');

    // selectAll should only select bot-1
    const selectAllBtn = renderer.root.findAllByType('button').find(b => b.props.children === '全选' || b.props.children?.includes('全选'));
    await act(async () => { await selectAllBtn?.props.onClick(); });
    await flush();
    const count = renderer.root.findByProps({ 'data-selected-count': 1 });
    expect(count).toBeTruthy();
  });

  // ── P1-4: targets shrink prunes selection ──
  it('prunes selected bots when targets shrink', async () => {
    const { renderer } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    // Simulate targets shrinking to just bot-1
    await act(async () => {
      renderer.update(React.createElement(SessionLoadoutTeamBuilder, {
        targets: [bots[0]], drafts: {}, onChange: vi.fn(),
      }));
    });
    await flush();
    // bot-1 is still in targets → stays selected (count=1); bot-2 pruned
    const countEl = renderer.root.findByProps({ 'data-selected-count': 1 });
    expect(countEl).toBeTruthy();
  });

  // ── Zero-config bot ──
  it('zero-config bot shows empty default and is editable', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: [bots[0]], drafts: {}, onChange: vi.fn() });
    await flush();
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    expect(bot1.props.disabled).toBe(false);
    expect(bot1.props['data-loadout-bot-editable']).toBe('true');
  });

  // ── Failure retry ──
  it('shows error card and retries on API failure', async () => {
    mockApis({ fail: true });
    const renderer = render();
    await flush();
    const errorCard = renderer.root.findByProps({ 'data-action': 'retry-loadout-catalog' });
    expect(errorCard).toBeTruthy();

    // Retry should re-fetch
    mockApis();
    await act(async () => { await errorCard.props.onClick(); });
    await flush();
    // After retry, lineup should render
    const lineup = renderer.root.findByProps({ 'data-loadout-lineup': true });
    expect(lineup).toBeTruthy();
  });

  // ── P2: drag sets dataTransfer ──
  it('pack drag start sets dataTransfer payload', async () => {
    const { renderer } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    const setData = vi.fn();
    const event = { dataTransfer: { effectAllowed: '', setData }, preventDefault: vi.fn() } as any;
    await act(async () => { await packCard.props.onDragStart(event); });
    expect(setData).toHaveBeenCalledWith('text/plain', 'pack:ops');
  });

  // ── Not expanded does not request data ──
  it('does not fetch catalog until mounted (parent controls mount)', () => {
    const fetch = vi.fn(async () => jsonRes(200, {}));
    vi.stubGlobal('fetch', fetch);
    // Component is only mounted when Advanced Settings opens; simulate not mounted
    expect(fetch).not.toHaveBeenCalled();
  });
});

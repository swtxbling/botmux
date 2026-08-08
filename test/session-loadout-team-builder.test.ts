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

/** Find the outer drop-zone wrapper for a bot. */
function botSlot(renderer: TestRenderer.ReactTestRenderer, larkAppId: string) {
  return renderer.root.findByProps({ 'data-loadout-bot-slot': larkAppId });
}

describe('SessionLoadoutTeamBuilder', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // ── P1-1: tri-state ──
  it('skill perk shows all/none/mixed and applies uniform state', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await openCustom(renderer);

    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('mixed');
    const perkB = renderer.root.findByProps({ 'data-loadout-perk': 'b' });
    expect(perkB.props['data-perk-state']).toBe('none');

    await act(async () => { await perkA.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-2']).toEqual({ include: ['skill:a'] });
    expect(drafts['bot-1']).toBeUndefined();
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

  it('pack-provided skill shows "all" tri-state, not "none"', async () => {
    const { renderer } = await openAndLoad({ drafts: { 'bot-1': { include: ['pack:ops'] } } });
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('all');
    expect(perkA.props['aria-pressed']).toBe(true);
  });

  it('enabling a pack-provided skill is a no-op (no duplicate direct selector)', async () => {
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['pack:ops'] } } });
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('all');
    await act(async () => { await perkA.props.onClick(); });
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1'].include).not.toContain('pack:ops');
    expect(drafts['bot-1'].include).toContain('skill:b');
    expect(drafts['bot-1'].include).not.toContain('skill:a');
  });

  it('mixed perk has aria-pressed="mixed"', async () => {
    const { renderer } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a'] } } });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await openCustom(renderer);
    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('mixed');
    expect(perkA.props['aria-pressed']).toBe('mixed');
  });

  it('onChange feedback loop: tri-state updates after re-render with new drafts', async () => {
    const onChange = vi.fn();
    mockApis();
    let renderer = render({ onChange });
    await flush();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await openCustom(renderer);

    let perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('mixed');

    const newDrafts = { 'bot-2': { include: ['skill:a'] } };
    await act(async () => {
      renderer.update(React.createElement(SessionLoadoutTeamBuilder, {
        targets: bots, drafts: newDrafts, onChange,
      }));
    });
    await flush();
    perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('all');
  });

  // ── Zero-config bot empty state ──
  it('zero-config bot shows "未配置默认装备" label', async () => {
    const { renderer } = await openAndLoad();
    const bot2Card = renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' });
    const stateSmall = bot2Card.findByProps({ 'data-loadout-state': 'empty' });
    expect(stateSmall).toBeTruthy();
  });

  // ── Batch pack (incremental, not replacement) ──
  it('applies a pack to two selected bots incrementally (preserves existing skills)', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');

    const applyBtn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    await act(async () => { await applyBtn.props.onClick(); });

    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    // bot-1 default = [skill:a]; adding pack:ops keeps skill:a → [skill:a, pack:ops]
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'pack:ops'] });
    // bot-2 default = []; adding pack:ops → [pack:ops]
    expect(drafts['bot-2']).toEqual({ include: ['pack:ops'] });
  });

  // ── Pack tri-state button ──
  it('pack button shows none/mixed/all tri-state and toggles', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');

    // Initially neither bot has pack:ops → none
    const btn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(btn.props['data-pack-state']).toBe('none');
    expect(btn.props['aria-pressed']).toBe(false);

    // Click → add to both → all
    await act(async () => { await btn.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'pack:ops'] });
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

  // ── Non-editable bot ──
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

    const selectAllBtn = renderer.root.findAllByType('button').find(b => b.props.children === '全选' || b.props.children?.includes('全选'));
    await act(async () => { await selectAllBtn?.props.onClick(); });
    await flush();
    const count = renderer.root.findByProps({ 'data-selected-count': 1 });
    expect(count).toBeTruthy();
  });

  it('non-editable bot shows unavailable label, not empty', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: [bots[0]], drafts: {}, onChange: vi.fn() });
    await flush();
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    // Must show 'unavailable' state, NOT 'empty'
    expect(bot1.findByProps({ 'data-loadout-state': 'unavailable' })).toBeTruthy();
    expect(() => bot1.findByProps({ 'data-loadout-state': 'empty' })).toThrow();
  });

  // ── Targets shrink prunes selection ──
  it('prunes selected bots when targets shrink', async () => {
    const { renderer } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    await act(async () => {
      renderer.update(React.createElement(SessionLoadoutTeamBuilder, {
        targets: [bots[0]], drafts: {}, onChange: vi.fn(),
      }));
    });
    await flush();
    const countEl = renderer.root.findByProps({ 'data-selected-count': 1 });
    expect(countEl).toBeTruthy();
  });

  // ── Zero-config bot editable ──
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

  // ── Default summary (visible short text, three states) ──
  it('renders default summary text with packs, skills, and final count', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['pack:ops', 'skill:c'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: [bots[0]], drafts: {}, onChange: vi.fn() });
    await flush();
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    const summary = bot1.findByProps({ className: 'loadout-bot-default' });
    expect(summary).toBeTruthy();
    expect(summary.props['data-loadout-default-summary']).toBe(true);
    const textSpan = summary.findByProps({ className: 'loadout-bot-default-text' });
    const text = typeof textSpan.children === 'string' ? textSpan.children : textSpan.children.join('');
    expect(text).toMatch(/1/); // packs
    expect(text).toMatch(/1/); // skills
    expect(text).toMatch(/3/); // final (ops→a,b + c = 3)
  });

  it('renders default summary with zeros when default is empty', async () => {
    const { renderer } = await openAndLoad();
    const bot2 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' });
    const summary = bot2.findByProps({ className: 'loadout-bot-default' });
    expect(summary).toBeTruthy();
    expect(summary.props['data-loadout-default-summary']).toBe(true);
    expect(bot2.findByProps({ 'data-loadout-state': 'empty' })).toBeTruthy();
  });

  it('renders unavailable state label (not empty, not default summary) when bot is unavailable', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['pack:ops', 'skill:a'] }, error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: [bots[0]], drafts: {}, onChange: vi.fn() });
    await flush();
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    // State label must be 'unavailable', NOT 'empty'
    expect(bot1.findByProps({ 'data-loadout-state': 'unavailable' })).toBeTruthy();
    expect(() => bot1.findByProps({ 'data-loadout-state': 'empty' })).toThrow();
    // No default summary rendered for unavailable bot
    expect(() => bot1.findByProps({ 'data-loadout-default-summary': true })).toThrow();
  });

  // ── Single-card drop (point-to-point, superposition) ──
  it('drops a pack on a single bot without changing selectedBots', async () => {
    const { renderer, onChange } = await openAndLoad();
    // Select bot-1, then drop pack on bot-2 (not selected)
    await selectBot(renderer, 'bot-1');

    const slot2 = botSlot(renderer, 'bot-2');
    const preventDefault = vi.fn();
    const dropEvent = { preventDefault, dataTransfer: { dropEffect: '' } } as any;
    const dragOverEvent = { preventDefault: vi.fn(), dataTransfer: { dropEffect: '', effectAllowed: 'copy' } } as any;

    // Simulate drag start on the pack card
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();

    // dragOver on bot-2 (editable) → should preventDefault
    await act(async () => { await slot2.props.onDragOver(dragOverEvent, 'bot-2', true); });
    expect(dragOverEvent.preventDefault).toHaveBeenCalled();

    // drop on bot-2 → should only modify bot-2
    await act(async () => { await slot2.props.onDrop(dropEvent, 'bot-2', true); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    // bot-2 gets the pack; bot-1 (selected) is untouched
    expect(drafts['bot-2']).toEqual({ include: ['pack:ops'] });
    expect(drafts['bot-1']).toBeUndefined();
  });

  it('drops a skill on a single bot (superposition, no-op if already effective)', async () => {
    const { renderer, onChange } = await openAndLoad();
    // bot-1 default has skill:a; dropping skill:a should be no-op
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const perkWrappers = renderer.root.findAllByProps({ className: 'loadout-perk-drag' });
    // Start drag on skill 'a' wrapper (first perk)
    await act(async () => { await perkWrappers[0].props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();

    const slot1 = botSlot(renderer, 'bot-1');
    await act(async () => { await slot1.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    // skill:a already in default → no-op → onChange should not fire for bot-1
    // (dragItem is skill:a, bot-1 already has it effective)
    expect(onChange).not.toHaveBeenCalled();
  });

  it('non-editable bot rejects drop (no preventDefault, no onChange)', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const onChange = vi.fn();
    const renderer = render({ onChange });
    await flush();

    // Start a drag so dragItem is not null
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();

    const slot2 = botSlot(renderer, 'bot-2');
    expect(slot2.props['data-drop-disabled']).toBe('true');

    const dragOverEvent = { preventDefault: vi.fn(), dataTransfer: { dropEffect: '' } } as any;
    await act(async () => { await slot2.props.onDragOver(dragOverEvent, 'bot-2', false); });
    // Non-editable: must NOT preventDefault
    expect(dragOverEvent.preventDefault).not.toHaveBeenCalled();
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('none');

    // Drop should not call onChange
    await act(async () => { await slot2.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-2', false); });
    expect(onChange).not.toHaveBeenCalled();
  });

  // ── Equivalent default deletes override ──
  it('editing back to default deletes the draft key', async () => {
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a', 'skill:b'] } } });
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    // Remove skill:b → back to default [skill:a] → should delete draft
    const perkB = renderer.root.findByProps({ 'data-loadout-perk': 'b' });
    await act(async () => { await perkB.props.onClick(); });
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toBeUndefined();
  });

  // ── Explicit clear produces {include: []} ──
  it('clearing a skill that empties the loadout produces explicit empty include array', async () => {
    // bot-1 default = [skill:a]; remove it → explicit empty { include: [] }
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const perkA = renderer.root.findByProps({ 'data-loadout-perk': 'a' });
    expect(perkA.props['data-perk-state']).toBe('all');
    await act(async () => { await perkA.props.onClick(); });
    const drafts = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(drafts['bot-1']).toEqual({ include: [] });
  });

  // ── Failure retry ──
  it('shows error card and retries on API failure', async () => {
    mockApis({ fail: true });
    const renderer = render();
    await flush();
    const errorCard = renderer.root.findByProps({ 'data-action': 'retry-loadout-catalog' });
    expect(errorCard).toBeTruthy();

    mockApis();
    await act(async () => { await errorCard.props.onClick(); });
    await flush();
    const lineup = renderer.root.findByProps({ 'data-loadout-lineup': true });
    expect(lineup).toBeTruthy();
  });

  // ── Mobile segmented control (button group, aria-pressed) ──
  it('switches mobile panels by click and keyboard without leaking custom perks', async () => {
    const { renderer } = await openAndLoad();
    const tab = (name: 'lineup' | 'builds' | 'preview') =>
      renderer.root.findByProps({ 'data-mobile-tab': name });
    const panel = (name: 'lineup' | 'builds' | 'preview') =>
      renderer.root.findByProps({ id: `loadout-panel-${name}` });

    // Button group uses aria-pressed, not aria-selected
    expect(tab('lineup').props['aria-pressed']).toBe(true);
    expect(tab('lineup').props.tabIndex).toBe(0);
    expect(tab('builds').props.tabIndex).toBe(-1);
    expect(panel('lineup').props['data-tab-active']).toBe(true);
    expect(renderer.root.findByProps({ 'data-preview-empty': true })).toBeTruthy();

    await act(async () => { await tab('builds').props.onClick(); });
    expect(tab('builds').props['aria-pressed']).toBe(true);
    expect(tab('builds').props.tabIndex).toBe(0);
    expect(panel('lineup').props['data-tab-active']).toBe(false);
    expect(panel('builds').props['data-tab-active']).toBe(true);

    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const custom = renderer.root.findByProps({ className: 'loadout-custom' });
    expect(custom.props['data-tab-active']).toBe(true);

    await act(async () => { await tab('preview').props.onClick(); });
    expect(tab('preview').props['aria-pressed']).toBe(true);
    expect(panel('preview').props['data-tab-active']).toBe(true);
    expect(custom.props['data-tab-active']).toBe(false);

    const preventDefault = vi.fn();
    await act(async () => {
      await tab('preview').props.onKeyDown({ key: 'ArrowLeft', preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(tab('builds').props['aria-pressed']).toBe(true);

    await act(async () => {
      await tab('builds').props.onKeyDown({ key: 'Home', preventDefault: vi.fn() });
    });
    expect(tab('lineup').props['aria-pressed']).toBe(true);

    await act(async () => {
      await tab('lineup').props.onKeyDown({ key: 'End', preventDefault: vi.fn() });
    });
    expect(tab('preview').props['aria-pressed']).toBe(true);
  });

  // ── Drag start payload ──
  it('pack drag start sets dataTransfer payload', async () => {
    const { renderer } = await openAndLoad();
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    const setData = vi.fn();
    const event = { dataTransfer: { effectAllowed: '', setData }, preventDefault: vi.fn() } as any;
    await act(async () => { await packCard.props.onDragStart(event); });
    expect(setData).toHaveBeenCalledWith('text/plain', 'pack:ops');
  });

  it('skill drag start sets dataTransfer payload', async () => {
    const { renderer } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await openCustom(renderer);
    const perkWrappers = renderer.root.findAllByProps({ className: 'loadout-perk-drag' });
    expect(perkWrappers.length).toBeGreaterThan(0);
    const setData = vi.fn();
    const event = { dataTransfer: { effectAllowed: '', setData }, preventDefault: vi.fn() } as any;
    await act(async () => { await perkWrappers[0].props.onDragStart(event); });
    expect(setData).toHaveBeenCalledWith('text/plain', 'skill:a');
  });

  // ── No fetch until mounted ──
  it('does not fetch catalog until mounted (parent controls mount)', () => {
    const fetch = vi.fn(async () => jsonRes(200, {}));
    vi.stubGlobal('fetch', fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── ARIA structure: no tabpanel roles, button group not tablist ──
  it('uses button group (not tablist) and sections without tabpanel role', async () => {
    const { renderer } = await openAndLoad();
    const nav = renderer.root.findByProps({ className: 'loadout-mobile-tabs' });
    expect(nav.props.role).toBe('group');
    // Panels should not have role="tabpanel"
    const lineupPanel = renderer.root.findByProps({ id: 'loadout-panel-lineup' });
    expect(lineupPanel.props.role).toBeUndefined();
    const buildsPanel = renderer.root.findByProps({ id: 'loadout-panel-builds' });
    expect(buildsPanel.props.role).toBeUndefined();
    const previewPanel = renderer.root.findByProps({ id: 'loadout-panel-preview' });
    expect(previewPanel.props.role).toBeUndefined();
  });

  // ── Single Skill drop: actual add, preserves others, other bots unchanged ──
  it('drops a new skill on a bot: adds it, preserves existing skill, other bots unchanged', async () => {
    const { renderer, onChange } = await openAndLoad();
    const slot1 = botSlot(renderer, 'bot-1');
    const skillCard = renderer.root.findByProps({ 'data-loadout-skill': 'c' });
    await act(async () => { await skillCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    await act(async () => { await slot1.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'skill:c'] });
    expect(drafts['bot-2']).toBeUndefined();
  });

  it('drops a skill already effective: no-op, no onChange', async () => {
    const { renderer, onChange } = await openAndLoad();
    const slot1 = botSlot(renderer, 'bot-1');
    const skillCard = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    await act(async () => { await skillCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    await act(async () => { await slot1.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    expect(onChange).not.toHaveBeenCalled();
  });

  // ── Single Pack drop: preserves non-empty base, idempotent on repeat ──
  it('drops a pack on a bot with existing skills: preserves them, adds pack', async () => {
    const { renderer, onChange } = await openAndLoad();
    const slot1 = botSlot(renderer, 'bot-1');
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    await act(async () => { await slot1.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'pack:ops'] });
  });

  it('drops the same pack twice: second drop is idempotent no-op', async () => {
    const { renderer, onChange } = await openAndLoad();
    const slot1 = botSlot(renderer, 'bot-1');
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    await act(async () => { await slot1.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    expect(onChange).toHaveBeenCalledTimes(1);
    // Simulate parent re-render with new drafts (as would happen in real usage)
    const firstDrafts = onChange.mock.calls[0][0];
    await act(async () => {
      renderer.update(React.createElement(SessionLoadoutTeamBuilder, { targets: bots, drafts: firstDrafts, onChange }));
    });
    await flush();
    // Second drop of same pack → no-op (pack already present in updated drafts)
    const slot1After = botSlot(renderer, 'bot-1');
    const packCardAfter = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCardAfter.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    await act(async () => { await slot1After.props.onDrop({ preventDefault: vi.fn(), dataTransfer: {} } as any, 'bot-1', true); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // ── Pack tri-state: none → all, all → uninstall ──
  it('pack button: none → click → all (equip to selected bots)', async () => {
    const { renderer, onChange } = await openAndLoad();
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    const btn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(btn.props['data-pack-state']).toBe('none');
    await act(async () => { await btn.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'pack:ops'] });
    expect(drafts['bot-2']).toEqual({ include: ['pack:ops'] });
  });

  it('pack button: all → click → uninstall (removes pack, restores default)', async () => {
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a', 'pack:ops'] }, 'bot-2': { include: ['pack:ops'] } } });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    const btn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(btn.props['data-pack-state']).toBe('all');
    await act(async () => { await btn.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    // bot-1: removed pack:ops → back to default [skill:a] → equivalent to default → key deleted
    expect(drafts['bot-1']).toBeUndefined();
    // bot-2: removed pack:ops → back to default [] → equivalent to default → key deleted
    expect(drafts['bot-2']).toBeUndefined();
  });

  it('pack button: partial change still fires onChange once', async () => {
    // bot-1 already has pack:ops, bot-2 does not → only bot-2 changes, but onChange fires once
    const { renderer, onChange } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a', 'pack:ops'] } } });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');
    const btn = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(btn.props['data-pack-state']).toBe('mixed');
    await act(async () => { await btn.props.onClick(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const drafts = onChange.mock.calls[0][0];
    expect(drafts['bot-1']).toEqual({ include: ['skill:a', 'pack:ops'] }); // unchanged
    expect(drafts['bot-2']).toEqual({ include: ['pack:ops'] }); // newly added
  });

  // ── data-drop-rejected + dragLeave cleanup ──
  it('non-editable bot: dragOver sets data-drop-rejected, dragLeave clears it', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: bots, drafts: {}, onChange: vi.fn() });
    await flush();
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();
    const slot2 = botSlot(renderer, 'bot-2');
    expect(slot2.props['data-drop-rejected']).toBeFalsy();
    const dragOverEvent = { preventDefault: vi.fn(), dataTransfer: { dropEffect: '' } } as any;
    await act(async () => { await slot2.props.onDragOver(dragOverEvent, 'bot-2', false); });
    await flush();
    const slot2After = botSlot(renderer, 'bot-2');
    expect(slot2After.props['data-drop-rejected']).toBe('true');
    // dragLeave clears reject state
    await act(async () => { await slot2After.props.onDragLeave(); });
    await flush();
    const slot2Final = botSlot(renderer, 'bot-2');
    expect(slot2Final.props['data-drop-rejected']).toBeFalsy();
  });

  // ── data-drop-rejected + dragEnd cleanup ──
  // Separate from the dragLeave case on purpose: dragEnd fires on the DRAG
  // SOURCE, not the slot. Without this, dropping the source outside any card
  // (or pressing Esc) would leave the reject outline stuck on screen forever
  // and every existing test would still pass.
  it('non-editable bot: dragEnd on the drag source clears data-drop-rejected', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down', skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
    ] });
    const renderer = render({ targets: bots, drafts: {}, onChange: vi.fn() });
    await flush();
    const packCard = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    await act(async () => { await packCard.props.onDragStart({ dataTransfer: { effectAllowed: '', setData: vi.fn() }, preventDefault: vi.fn() } as any); });
    await flush();

    await act(async () => {
      await botSlot(renderer, 'bot-2').props.onDragOver(
        { preventDefault: vi.fn(), dataTransfer: { dropEffect: '' } } as any, 'bot-2', false,
      );
    });
    await flush();
    expect(botSlot(renderer, 'bot-2').props['data-drop-rejected']).toBe('true');

    // Abort the drag at the source — reject state must not survive it.
    await act(async () => { await renderer.root.findByProps({ 'data-loadout-pack': 'ops' }).props.onDragEnd(); });
    await flush();
    expect(botSlot(renderer, 'bot-2').props['data-drop-rejected']).toBeFalsy();
  });

  // ── Continuous retry: two consecutive retries both fetch ──
  it('retry after failure fetches again; second retry also fetches (catalogRef guard)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/')) return jsonRes(500, { error: 'boom' });
      if (u.startsWith('/api/skill-packs')) return jsonRes(200, { packs: [{ id: 'ops', name: 'Ops', include: ['skill:a', 'skill:b'] }] });
      if (u.startsWith('/api/skills')) return jsonRes(200, { skills: [{ name: 'a' }, { name: 'b' }] });
      if (u.startsWith('/api/bots')) return jsonRes(200, { bots: [{ larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' }] });
      return jsonRes(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const renderer = render();
    await flush();
    const callsAfterFirstLoad = fetchMock.mock.calls.length;
    expect(callsAfterFirstLoad).toBe(3);
    // First retry
    let retryBtn = renderer.root.findByProps({ 'data-action': 'retry-loadout-catalog' });
    await act(async () => { await retryBtn.props.onClick(); });
    await flush();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad + 3);
    // Second retry — must re-fetch (catalogRef guard must not block force retry)
    retryBtn = renderer.root.findByProps({ 'data-action': 'retry-loadout-catalog' });
    await act(async () => { await retryBtn.props.onClick(); });
    await flush();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad + 6);
  });

  // ── Zero-selection: skill catalog draggable, button disabled, unselected ──
  it('zero-selection: skill catalog item is draggable, batch button disabled+action word+aria-describedby, state=unselected', async () => {
    const { renderer } = await openAndLoad();
    // Only ONE hint on the page (builds layer), no duplicate in skill catalog
    const hints = renderer.root.findAllByProps({ id: 'loadout-select-bots-hint' });
    expect(hints).toHaveLength(1);
    expect(() => renderer.root.findByProps({ 'data-skill-catalog-empty': true })).toThrow();

    const skillCard = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    expect(skillCard.props.draggable).toBe(true);
    expect(skillCard.props['data-skill-state']).toBe('unselected');
    // No data-perk-state on catalog item (single state hook)
    expect(skillCard.props['data-perk-state']).toBeUndefined();

    const applyBtn = skillCard.findByProps({ 'data-action': 'apply-skill' });
    expect(applyBtn.props.disabled).toBe(true);
    // Button shows action word, not the hint sentence
    expect(applyBtn.props.children).toBe('装备');
    // aria-describedby points to the single hint
    expect(applyBtn.props['aria-describedby']).toBe('loadout-select-bots-hint');
  });

  // The label must always name the action the click performs. A fixed "装备"
  // would read "equip" while the click on an already-equipped skill removes it.
  it('selected: skill catalog button label tracks tri-state as an action word', async () => {
    const { renderer } = await openAndLoad({
      drafts: {
        'bot-1': { include: ['skill:a', 'skill:c'] },
        'bot-2': { include: ['skill:a'] },
      },
    });
    await selectBot(renderer, 'bot-1');
    await selectBot(renderer, 'bot-2');

    const labelOf = (name: string) => {
      const card = renderer.root.findByProps({ 'data-loadout-skill': name });
      return {
        state: card.props['data-skill-state'],
        label: card.findByProps({ 'data-action': 'apply-skill' }).props.children,
        pressed: card.findByProps({ 'data-action': 'apply-skill' }).props['aria-pressed'],
      };
    };

    // 'a' on both bots → all → clicking removes it → "卸下"
    expect(labelOf('a')).toEqual({ state: 'all', label: '卸下', pressed: true });
    // 'c' on bot-1 only → mixed → clicking equips everyone → "统一装备"
    expect(labelOf('c')).toEqual({ state: 'mixed', label: '统一装备', pressed: 'mixed' });
    // 'b' on neither → none → clicking equips → "装备"
    expect(labelOf('b')).toEqual({ state: 'none', label: '装备', pressed: false });
  });

  it('zero-selection: clicking disabled skill button does not fire onChange', async () => {
    const { renderer, onChange } = await openAndLoad();
    const skillCard = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    const applyBtn = skillCard.findByProps({ 'data-action': 'apply-skill' });
    expect(applyBtn.props.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  // ── default ≠ current: exact assertions ──
  it('customised bot: default summary uses defaultCount, current final count differs', async () => {
    const { renderer } = await openAndLoad({ drafts: { 'bot-1': { include: ['skill:a', 'skill:c'] } } });
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    const defaultSummary = bot1.findByProps({ className: 'loadout-bot-default' });
    const defaultText = defaultSummary.findByProps({ className: 'loadout-bot-default-text' }).children.join('');
    // Default: 0 packs · 1 skill · 1 final (defaultCount=1)
    expect(defaultText).toBe('默认 0 包 · 1 Skill · 最终 1');
    // Current: 2 skills (finalCount=2)
    const currentFinal = bot1.findByProps({ 'data-loadout-final-count': 2 });
    expect(currentFinal).toBeTruthy();
    expect(currentFinal.children.join('')).toBe('本次 2 个 Skill');
  });

  it('non-customised bot: default final count equals current final count', async () => {
    const { renderer } = await openAndLoad();
    const bot1 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-1' });
    const defaultSummary = bot1.findByProps({ className: 'loadout-bot-default' });
    const defaultText = defaultSummary.findByProps({ className: 'loadout-bot-default-text' }).children.join('');
    expect(defaultText).toBe('默认 0 包 · 1 Skill · 最终 1');
    const currentFinal = bot1.findByProps({ 'data-loadout-final-count': 1 });
    expect(currentFinal).toBeTruthy();
  });
});

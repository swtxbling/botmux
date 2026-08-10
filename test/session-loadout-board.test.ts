import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLoadoutBoard } from '../src/dashboard/web/skills/session-loadout-board.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

const targets = [
  { larkAppId: 'bot-1', botName: 'Bot 1' },
  { larkAppId: 'bot-2', botName: 'Bot 2' },
];

function mockApis(overrides: {
  bots?: any[];
  skills?: any[];
  packs?: any[];
  packsStatus?: number;
  fail?: boolean;
} = {}) {
  const fetch = vi.fn(async (url: string) => {
    const value = String(url);
    if (overrides.fail) return jsonRes(500, { error: 'boom' });
    if (value.startsWith('/api/skill-packs')) {
      const status = overrides.packsStatus ?? 200;
      return jsonRes(status, status === 200 ? {
        packs: overrides.packs ?? [{ id: 'ops', name: 'Ops Pack', include: ['skill:a', 'skill:b'] }],
      } : { error: 'packs_down' });
    }
    if (value.startsWith('/api/skills')) return jsonRes(200, {
      skills: overrides.skills ?? [
        { name: 'a', description: 'Alpha' },
        { name: 'b', description: 'Beta' },
        { name: 'c', description: 'Gamma' },
      ],
    });
    if (value.startsWith('/api/bots')) return jsonRes(200, {
      bots: overrides.bots ?? [
        { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['pack:ops', 'skill:c'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
        { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      ],
    });
    return jsonRes(404, {});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function render(props: Record<string, any> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const onChange = props.onChange ?? vi.fn();
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionLoadoutBoard, {
      targets,
      drafts: {},
      onChange,
      ...props,
    }));
  });
  return { renderer, onChange };
}

async function renderLoaded(props: Record<string, any> = {}, apiOverrides: Parameters<typeof mockApis>[0] = {}) {
  mockApis(apiOverrides);
  const result = render(props);
  await flush();
  return result;
}

function slot(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ 'data-loadout-bot-slot': id });
}

function dragEvent() {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: vi.fn() },
  } as any;
}

describe('SessionLoadoutBoard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the requested armory → Bot slots hierarchy with accessible Pack/Skill tabs', async () => {
    const { renderer } = await renderLoaded();
    const packsTab = renderer.root.findByProps({ 'data-catalog-tab': 'packs' });
    const skillsTab = renderer.root.findByProps({ 'data-catalog-tab': 'skills' });
    expect(packsTab.props.role).toBe('tab');
    expect(packsTab.props['aria-selected']).toBe(true);
    expect(skillsTab.props['aria-selected']).toBe(false);
    expect(renderer.root.findByProps({ 'data-catalog-panel': 'packs' }).props.hidden).toBe(false);
    expect(renderer.root.findByProps({ 'data-catalog-panel': 'skills' }).props.hidden).toBe(true);
    expect(renderer.root.findAll(node => typeof node.props['data-loadout-bot-slot'] === 'string')).toHaveLength(2);

    await act(async () => { await skillsTab.props.onClick(); });
    expect(renderer.root.findByProps({ 'data-catalog-panel': 'skills' }).props.hidden).toBe(false);
  });

  it('supports arrow-key tab switching', async () => {
    const { renderer } = await renderLoaded();
    const packsTab = renderer.root.findByProps({ 'data-catalog-tab': 'packs' });
    const preventDefault = vi.fn();
    await act(async () => { await packsTab.props.onKeyDown({ key: 'ArrowRight', preventDefault }); });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ 'data-catalog-tab': 'skills' }).props['aria-selected']).toBe(true);
  });

  it('shows each Bot inherited Pack and direct Skill by name, not counts only', async () => {
    const { renderer } = await renderLoaded();
    const equipped = renderer.root.findByProps({ 'data-loadout-equipped': 'bot-1' });
    expect(equipped.findByProps({ 'data-equipped-pack': 'ops' }).children.join('')).toContain('Ops Pack');
    expect(equipped.findByProps({ 'data-equipped-skill': 'c' }).children.join('')).toContain('c');
    expect(renderer.root.findByProps({ 'data-loadout-final-count': 3 })).toBeTruthy();
  });

  it('shows an actionable empty slot for a Bot with no default selectors', async () => {
    const { renderer } = await renderLoaded();
    const equipped = renderer.root.findByProps({ 'data-loadout-equipped': 'bot-2' });
    expect(equipped.findByProps({ className: 'loadout-equipped-empty' })).toBeTruthy();
    expect(renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' }).findByProps({ 'data-loadout-state': 'empty' })).toBeTruthy();
  });

  it('drags one Pack onto one precise Bot without requiring selection', async () => {
    const { renderer, onChange } = await renderLoaded();
    const pack = renderer.root.findByProps({ 'data-loadout-pack': 'ops' });
    const start = dragEvent();
    await act(async () => { await pack.props.onDragStart(start); });
    expect(start.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'pack:ops');

    const target = slot(renderer, 'bot-2');
    const over = dragEvent();
    await act(async () => { await target.props.onDragOver(over); });
    expect(over.preventDefault).toHaveBeenCalledOnce();
    await act(async () => { await target.props.onDrop(dragEvent()); });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ 'bot-2': { include: ['pack:ops'] } });
  });

  it('drags one Skill onto one precise Bot and preserves existing selectors', async () => {
    const { renderer, onChange } = await renderLoaded();
    await act(async () => { await renderer.root.findByProps({ 'data-catalog-tab': 'skills' }).props.onClick(); });
    const skill = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    const start = dragEvent();
    await act(async () => { await skill.props.onDragStart(start); });
    expect(start.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'skill:a');
    await act(async () => { await slot(renderer, 'bot-2').props.onDrop(dragEvent()); });
    expect(onChange.mock.calls[0][0]).toEqual({ 'bot-2': { include: ['skill:a'] } });
  });

  it('does not duplicate a Skill already effective through a Pack', async () => {
    const { renderer, onChange } = await renderLoaded();
    await act(async () => { await renderer.root.findByProps({ 'data-catalog-tab': 'skills' }).props.onClick(); });
    const skill = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    await act(async () => { await skill.props.onDragStart(dragEvent()); });
    await act(async () => { await slot(renderer, 'bot-1').props.onDrop(dragEvent()); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes one inherited direct Skill as an explicit session override', async () => {
    const { renderer, onChange } = await renderLoaded({}, {
      bots: [{ larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' }],
    });
    const remove = renderer.root.findByProps({ 'data-equipped-skill': 'a' });
    await act(async () => { await remove.props.onClick(); });
    expect(onChange.mock.calls[0][0]).toEqual({ 'bot-1': { include: [] } });
  });

  it('removes one Pack while preserving the Bot direct Skills', async () => {
    const { renderer, onChange } = await renderLoaded();
    await act(async () => { await renderer.root.findByProps({ 'data-equipped-pack': 'ops' }).props.onClick(); });
    expect(onChange.mock.calls[0][0]).toEqual({ 'bot-1': { include: ['skill:c'] } });
  });

  it('restores a customised Bot to inheritance by deleting its draft key', async () => {
    const { renderer, onChange } = await renderLoaded({ drafts: { 'bot-1': { include: ['skill:a'] } } });
    const restore = renderer.root.findByProps({ 'data-action': 'restore-bot-default' });
    await act(async () => { await restore.props.onClick(); });
    expect(onChange.mock.calls[0][0]).toEqual({});
  });

  it('keeps batch selection optional and offers a touch/keyboard fallback', async () => {
    const { renderer, onChange } = await renderLoaded();
    const apply = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(apply.props.disabled).toBe(true);
    await act(async () => { await renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' }).props.onClick(); });
    expect(renderer.root.findByProps({ 'data-selected-count': 1 })).toBeTruthy();
    const activeApply = renderer.root.findByProps({ 'data-action': 'apply-pack', 'data-pack-id': 'ops' });
    expect(activeApply.props.disabled).toBe(false);
    await act(async () => { await activeApply.props.onClick(); });
    expect(onChange.mock.calls[0][0]).toEqual({ 'bot-2': { include: ['pack:ops'] } });
  });

  it('rejects drops onto an unavailable Bot without creating a draft', async () => {
    const { renderer, onChange } = await renderLoaded({}, {
      bots: [
        { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
        { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down' },
      ],
    });
    await act(async () => { await renderer.root.findByProps({ 'data-loadout-pack': 'ops' }).props.onDragStart(dragEvent()); });
    const target = slot(renderer, 'bot-2');
    const over = dragEvent();
    await act(async () => { await target.props.onDragOver(over); });
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('none');
    await act(async () => { await target.props.onDrop(dragEvent()); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('revalidates a Bot added after the catalog was cached and keeps an unavailable row read-only', async () => {
    mockApis({ bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      { larkAppId: 'bot-2', botName: 'Bot 2', error: 'daemon_down' },
    ] });
    const onChange = vi.fn();
    const { renderer } = render({ targets: [targets[0]], onChange });
    await flush();
    await act(async () => {
      renderer.update(React.createElement(SessionLoadoutBoard, { targets, drafts: {}, onChange }));
    });
    await flush();

    const bot2 = renderer.root.findByProps({ 'data-loadout-bot': 'bot-2' });
    expect(bot2.props.disabled).toBe(true);
    expect(bot2.findByProps({ 'data-loadout-state': 'unavailable' })).toBeTruthy();
    expect(() => renderer.root.findByProps({ 'data-loadout-equipped': 'bot-2' })).toThrow();
    expect(renderer.root.findByProps({ 'data-loadout-slot-error': 'bot-2' }).findByType('button')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('only shows the global-injection warning when capability and effective mode are both global', async () => {
    const { renderer } = await renderLoaded({}, {
      bots: [
        { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: [] }, skillInjectionSupport: 'global', skillInjection: 'global' },
        { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'global', skillInjection: 'prompt' },
      ],
    });
    const warnings = renderer.root.findAllByProps({ 'data-loadout-degraded': true });
    expect(warnings).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-loadout-equipped': 'bot-1' }).findByProps({ 'data-loadout-degraded': true })).toBeTruthy();
  });

  it('blocks editing on first-load Pack failure and exposes a real retry', async () => {
    const fetch = mockApis({ packsStatus: 500 });
    const { renderer } = render();
    await flush();
    expect(renderer.root.findByProps({ 'data-loadout-blocked': true })).toBeTruthy();
    const before = fetch.mock.calls.length;
    await act(async () => { await renderer.root.findByProps({ 'data-action': 'retry-loadout-catalog' }).props.onClick(); });
    await flush();
    expect(fetch.mock.calls.length).toBe(before + 3);
  });

  it('treats an explicit Pack API 404 as a known empty catalog', async () => {
    const { renderer } = await renderLoaded({}, { packsStatus: 404 });
    expect(renderer.root.findByProps({ 'data-catalog-panel': 'packs' })).toBeTruthy();
    expect(() => renderer.root.findByProps({ 'data-loadout-blocked': true })).toThrow();
  });

  it('marks per-Bot additions and removals inline', async () => {
    const { renderer } = await renderLoaded({ drafts: { 'bot-1': { include: ['skill:a'] } } });
    const diff = renderer.root.findByProps({ 'data-preview-bot': 'bot-1' });
    expect(diff.findByProps({ className: 'is-remove' }).children.join('')).toContain('b');
    expect(diff.findByProps({ className: 'is-remove' }).children.join('')).toContain('c');
  });
});

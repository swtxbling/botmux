import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLoadoutAccordion } from '../src/dashboard/web/skills/session-loadout-accordion.js';
import type { LoadoutDrafts } from '../src/dashboard/web/create-session-loadout.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

function mockCatalog(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const u = String(url);
    if (u.startsWith('/api/skill-packs')) {
      return jsonRes(200, { packs: [{ id: 'ops', name: 'Ops', include: ['skill:a'] }] });
    }
    if (u.startsWith('/api/skills')) {
      return jsonRes(200, { skills: [{ name: 'a', tags: [] }, { name: 'b', tags: [] }] });
    }
    if (u.startsWith('/api/bots')) {
      return jsonRes(200, { bots: [
        { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic' },
        { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'global' },
      ] });
    }
    return jsonRes(404, {});
  }));
  return { calls };
}

const targets = [
  { larkAppId: 'bot-1', botName: 'Bot 1' },
  { larkAppId: 'bot-2', botName: 'Bot 2' },
];

function render(drafts: LoadoutDrafts, onChange: (d: LoadoutDrafts) => void = () => {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionLoadoutAccordion, { targets, drafts, onChange }));
  });
  return renderer;
}

async function expand(renderer: TestRenderer.ReactTestRenderer, larkAppId: string) {
  const toggle = renderer.root
    .findByProps({ 'data-loadout-row': larkAppId })
    .findByProps({ 'data-action': 'toggle-loadout' });
  await act(async () => { await toggle.props.onClick(); });
  await flush();
}

describe('per-session loadout accordion', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('costs nothing until a row is expanded', async () => {
    // The create-session dialog is a lightweight entry point: a user who never
    // touches loadouts must not pay for the catalog fetch.
    const { calls } = mockCatalog();
    const renderer = render({});
    await flush();
    expect(calls).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-loadout-state': 'inherit' })).toHaveLength(2);
  });

  it('fetches the catalog on first expand and reuses it afterwards', async () => {
    const { calls } = mockCatalog();
    const renderer = render({});
    await expand(renderer, 'bot-1');
    expect(calls.some(url => url.startsWith('/api/skills'))).toBe(true);

    const afterFirst = calls.length;
    await expand(renderer, 'bot-2');
    expect(calls).toHaveLength(afterFirst);
  });

  it('keeps at most one row open', async () => {
    mockCatalog();
    const renderer = render({});
    await expand(renderer, 'bot-1');
    await expand(renderer, 'bot-2');

    const row1 = renderer.root.findByProps({ 'data-loadout-row': 'bot-1' });
    const row2 = renderer.root.findByProps({ 'data-loadout-row': 'bot-2' });
    expect(row1.findAllByProps({ 'data-loadout-panel': 'closed' }).length).toBeGreaterThan(0);
    expect(row2.findAllByProps({ 'data-loadout-panel': 'open' }).length).toBeGreaterThan(0);
  });

  it('warns that a global-injection bot only gets the prompt catalog', async () => {
    mockCatalog();
    const renderer = render({});
    await expand(renderer, 'bot-1');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(0);

    await expand(renderer, 'bot-2');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(1);
  });

  it('pre-fills from the bot policy and submits the complete final set', async () => {
    // Replacement semantics: the draft is the whole policy, never a delta.
    mockCatalog();
    let received: LoadoutDrafts | null = null;
    const renderer = render({}, drafts => { received = drafts; });
    await expand(renderer, 'bot-1');

    const skillB = renderer.root.findByProps({ 'data-loadout-skill': 'b' });
    await act(async () => { skillB.props.onChange(); });

    expect([...(received!['bot-1'].include ?? [])].sort()).toEqual(['skill:a', 'skill:b']);
  });

  it('restore-default deletes the entry so the bot inherits again', async () => {
    // Storing the bot policy instead would submit a loadout, which is a
    // different thing from inheriting one.
    mockCatalog();
    let received: LoadoutDrafts | null = null;
    const renderer = render({ 'bot-1': { include: ['skill:b'] } }, drafts => { received = drafts; });
    await expand(renderer, 'bot-1');

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'restore-loadout-default' }).props.onClick();
    });
    expect(received).toEqual({});
    expect('bot-1' in received!).toBe(false);
  });

  it('summarises customised vs inherited rows', async () => {
    mockCatalog();
    const renderer = render({ 'bot-1': { include: ['skill:b'] } });
    await flush();
    expect(renderer.root.findByProps({ 'data-loadout-row': 'bot-1' })
      .findAllByProps({ 'data-loadout-state': 'custom' })).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-loadout-row': 'bot-2' })
      .findAllByProps({ 'data-loadout-state': 'inherit' })).toHaveLength(1);
  });

  it('renders nothing when no bot will spawn (Lead mode without a Lead)', () => {
    mockCatalog();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SessionLoadoutAccordion, {
        targets: [], drafts: {}, onChange: () => {},
      }));
    });
    expect(renderer.toJSON()).toBeNull();
  });
});

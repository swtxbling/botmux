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

interface CatalogOptions {
  skills?: number;
  bots?: number;
  packs?: number;
  packsNetworkFail?: boolean;
  /** Resolved injection mode for bot-2, which is on a global-capable CLI. */
  bot2Injection?: 'global' | 'prompt' | 'off';
  /** Replaces the whole /api/bots payload, for malformed / failed-entry cases. */
  botsPayload?: unknown;
}

function mockCatalog(options: CatalogOptions = {}): { calls: string[] } {
  const { skills = 200, bots = 200, packs = 200, packsNetworkFail = false, bot2Injection = 'global' } = options;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const u = String(url);
    if (u.startsWith('/api/skill-packs')) {
      if (packsNetworkFail) throw new Error('offline');
      return packs === 200
        ? jsonRes(200, { packs: [{ id: 'ops', name: 'Ops', include: ['skill:a'] }] })
        : jsonRes(packs, { error: 'packs_failed' });
    }
    if (u.startsWith('/api/skills')) {
      return skills === 200
        ? jsonRes(200, { skills: [{ name: 'a', tags: [] }, { name: 'b', tags: [] }] })
        : jsonRes(skills, { error: 'skills_failed' });
    }
    if (u.startsWith('/api/bots')) {
      if (options.botsPayload !== undefined) return jsonRes(200, options.botsPayload);
      return bots === 200
        ? jsonRes(200, { bots: [
          { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
          { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'global', skillInjection: bot2Injection },
        ] })
        : jsonRes(bots, { error: 'bots_failed' });
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

  it('warns based on the RESOLVED injection mode, not the CLI capability', async () => {
    // skillInjectionSupport only says the CLI *can* share a global skills dir.
    // Warning on that alone would cry wolf for every bot on such a CLI that is
    // actually running in prompt mode.
    mockCatalog({ bot2Injection: 'global' });
    const renderer = render({});
    await expand(renderer, 'bot-1');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(0);
    await expand(renderer, 'bot-2');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(1);
  });

  it('stays silent for a global-capable CLI that is configured for prompt injection', async () => {
    mockCatalog({ bot2Injection: 'prompt' });
    const renderer = render({});
    await expand(renderer, 'bot-2');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(0);
  });

  it('stays silent for a dynamic CLI even if its resolved mode reads global', async () => {
    // Capability AND mode must both hold; a stale or legacy value on a
    // per-session-capable CLI must not raise a warning that does not apply.
    mockCatalog({ botsPayload: { bots: [
      { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'global' },
      { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'global' },
    ] } });
    const renderer = render({});
    await expand(renderer, 'bot-1');
    expect(renderer.root.findAllByProps({ 'data-loadout-degraded': true })).toHaveLength(0);
  });

  describe('a failed catalog blocks editing instead of looking like empty data', () => {
    // Reading a failure as "empty" is the dangerous interpretation: an errored
    // /api/bots looks like "this bot has no policy", so the first checkbox the
    // user ticks would submit a loadout that silently replaces the real default.
    it.each([
      ['skills 500', { skills: 500 }],
      ['bots 500', { bots: 500 }],
      ['packs 500', { packs: 500 }],
      ['packs network error', { packsNetworkFail: true }],
    ])('%s blocks the picker and surfaces the error', async (_label, options) => {
      mockCatalog(options as CatalogOptions);
      const renderer = render({});
      await expand(renderer, 'bot-1');
      expect(renderer.root.findAllByProps({ 'data-loadout-skill': 'a' })).toHaveLength(0);
      expect(JSON.stringify(renderer.toJSON())).toContain('hint-warn');
    });

    it('treats an explicit packs 404 as "no packs" and still allows editing', async () => {
      // Older daemons have no pack API at all; that is not a failure.
      mockCatalog({ packs: 404 });
      const renderer = render({});
      await expand(renderer, 'bot-1');
      expect(renderer.root.findAllByProps({ 'data-loadout-skill': 'a' })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ 'data-loadout-pack': 'ops' })).toHaveLength(0);
    });
  });

  describe('a 200 from /api/bots is not proof the policy is usable', () => {
    // The aggregator returns one row per bot, and an unreachable daemon yields
    // `{ larkAppId, error }` with no `skills`. Left unchecked that is
    // indistinguishable from "this bot has no policy", so the first checkbox
    // ticked would submit a loadout replacing a default we never read.
    it.each([
      ['a malformed bots payload', { bots: 'garbage' }, 'bots_malformed_response'],
      ['a target missing from the roster', { bots: [{ larkAppId: 'other', botName: 'Other' }] }, 'bot_missing:bot-1'],
      ['a target returned as a failed entry', { bots: [{ larkAppId: 'bot-1', error: 'daemon offline' }] }, 'bot_unavailable:bot-1'],
    ])('%s blocks editing', async (_label, botsPayload, marker) => {
      mockCatalog({ botsPayload });
      const renderer = render({});
      await expand(renderer, 'bot-1');
      expect(renderer.root.findAllByProps({ 'data-loadout-skill': 'a' })).toHaveLength(0);
      expect(JSON.stringify(renderer.toJSON())).toContain(marker as string);
    });
  });

  it('removes a collapsed panel from the tab order and the a11y tree', async () => {
    // The DOM is kept mounted so collapsing can animate, but 0fr +
    // overflow:hidden only hides it visually — its checkboxes would still be
    // reachable with Tab without inert/aria-hidden.
    mockCatalog();
    const renderer = render({});
    await expand(renderer, 'bot-1');

    const open = renderer.root.findByProps({ 'data-loadout-panel': 'open' });
    expect(open.props.inert).toBeUndefined();
    expect(open.props['aria-hidden']).toBeUndefined();

    const summary = renderer.root
      .findByProps({ 'data-loadout-row': 'bot-1' })
      .findByProps({ 'data-action': 'toggle-loadout' });
    expect(summary.props['aria-controls']).toBe(open.props.id);

    await expand(renderer, 'bot-1');
    const closed = renderer.root.findByProps({ 'data-loadout-panel': 'closed' });
    expect(closed.props.inert).toBe(true);
    expect(closed.props['aria-hidden']).toBe(true);
  });

  it('editing back to the bot default drops the draft instead of submitting an override', async () => {
    // Check then uncheck: the summary says "inherit", so the wire must agree.
    mockCatalog();
    let received: LoadoutDrafts = {};
    let renderer = render({}, drafts => { received = drafts; });
    await expand(renderer, 'bot-1');
    await act(async () => { renderer.root.findByProps({ 'data-loadout-skill': 'b' }).props.onChange(); });
    expect(received['bot-1']).toBeTruthy();

    renderer = render(received, drafts => { received = drafts; });
    await expand(renderer, 'bot-1');
    await act(async () => { renderer.root.findByProps({ 'data-loadout-skill': 'b' }).props.onChange(); });
    expect('bot-1' in received).toBe(false);
    expect(received).toEqual({});
  });

  it('keeps a collapsed row mounted so the close transition can play', async () => {
    mockCatalog();
    const renderer = render({});
    await expand(renderer, 'bot-1');
    await expand(renderer, 'bot-1');
    expect(renderer.root.findAllByProps({ 'data-loadout-panel': 'closed' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ 'data-loadout-skill': 'a' })).toHaveLength(1);
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

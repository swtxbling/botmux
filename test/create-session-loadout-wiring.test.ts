import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateSessionDialog } from '../src/dashboard/web/sessions-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The helper-level tests prove buildLoadoutSubmission is correct, but they
// would keep passing if the dialog stopped calling it. These drive an actual
// submit and read the request body, so the wiring itself is under test.

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

/** The dialog only ever touches these members of the <dialog> element. */
function stubDialog(): HTMLDialogElement {
  const classList = new Set<string>();
  return {
    open: false,
    showModal() { (this as any).open = true; },
    close() { (this as any).open = false; },
    classList: {
      add: (c: string) => classList.add(c),
      remove: (c: string) => classList.delete(c),
      contains: (c: string) => classList.has(c),
      toggle: (c: string) => { if (classList.has(c)) classList.delete(c); else classList.add(c); },
    } as any,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLDialogElement;
}

const bots = [
  { larkAppId: 'bot-1', botName: 'Bot 1' },
  { larkAppId: 'bot-2', botName: 'Bot 2' },
];

function mockApis(): { bodies: any[]; calls: string[] } {
  const bodies: any[] = [];
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('/api/skill-packs')) return jsonRes(200, { packs: [{ id: 'ops', name: 'Ops', include: ['skill:a'] }] });
    if (u.startsWith('/api/skills')) return jsonRes(200, { skills: [{ name: 'a', tags: [] }, { name: 'b', tags: [] }] });
    if (u.startsWith('/api/bots')) {
      return jsonRes(200, { bots: [
        { larkAppId: 'bot-1', botName: 'Bot 1', skills: { include: ['skill:a'] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
        { larkAppId: 'bot-2', botName: 'Bot 2', skills: { include: [] }, skillInjectionSupport: 'dynamic', skillInjection: 'prompt' },
      ] });
    }
    if (u.startsWith('/api/sessions/create')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonRes(200, { ok: true, column: 'in_progress', spawned: ['s1'] });
    }
    return jsonRes(404, {});
  }));
  return { bodies, calls };
}

function renderDialog() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(CreateSessionDialog, {
      dialog: stubDialog(),
      state: { bots },
      onClose: () => {},
      onSuccess: () => {},
    }));
  });
  return renderer;
}

/** The dialog reads `event.currentTarget.checked`, nothing else. */
async function checkBot(renderer: TestRenderer.ReactTestRenderer, larkAppId: string, checked: boolean) {
  const box = renderer.root.findAllByType('input')
    .find(input => input.props.name === 'bot' && input.props.value === larkAppId);
  await act(async () => { box!.props.onChange({ currentTarget: { checked } }); });
}

async function setContent(renderer: TestRenderer.ReactTestRenderer, text: string) {
  const textarea = renderer.root.findByProps({ name: 'content' });
  await act(async () => {
    textarea.props.onChange({ currentTarget: { value: text, selectionStart: text.length } });
  });
}

async function submit(renderer: TestRenderer.ReactTestRenderer) {
  const form = renderer.root.findByProps({ id: 'cs-form' });
  await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
  await flush();
}

async function openAdvanced(renderer: TestRenderer.ReactTestRenderer) {
  if (renderer.root.findAllByProps({ id: 'cs-advanced-fields' }).length > 0) return;
  await act(async () => { renderer.root.findByProps({ id: 'cs-advanced-title' }).props.onClick(); });
  await flush();
}

/** Open the fullscreen loadout workshop from the advanced-area summary card. */
async function openWorkshop(renderer: TestRenderer.ReactTestRenderer) {
  await openAdvanced(renderer);
  await flush();
  const btn = renderer.root.findByProps({ 'data-action': 'open-loadout-workshop' });
  await act(async () => { await btn.props.onClick(); });
  await flush();
}

/** In the team builder, "selecting" a bot means clicking its lineup card. */
async function selectLineupBot(renderer: TestRenderer.ReactTestRenderer, larkAppId: string) {
  await openWorkshop(renderer);
  const card = renderer.root.findByProps({ 'data-loadout-bot': larkAppId });
  await act(async () => { await card.props.onClick(); });
  await flush();
}

/** Open the custom fine-tune drawer so individual skills are reachable. */
async function openCustomDrawer(renderer: TestRenderer.ReactTestRenderer) {
  const btn = renderer.root.findByProps({ 'aria-expanded': false });
  await act(async () => { await btn.props.onClick(); });
  await flush();
}

/** Commit the workshop (click "完成") so drafts are written back to the parent form. */
async function commitWorkshop(renderer: TestRenderer.ReactTestRenderer) {
  const btn = renderer.root.findByProps({ 'data-action': 'workshop-commit' });
  await act(async () => { await btn.props.onClick(); });
  await flush();
}

describe('create-session dialog ↔ skillLoadouts wiring', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('omits skillLoadouts entirely when the user never opens a loadout', async () => {
    const { bodies } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await setContent(renderer, 'go');
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect('skillLoadouts' in bodies[0]).toBe(false);
  });

  it('sends the edited loadout for the bot that was customised', async () => {
    const { bodies } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await setContent(renderer, 'go');
    await selectLineupBot(renderer, 'bot-1');

    // bot-1's own policy is skill:a; applying the Ops pack (skill:a) is a no-op,
    // so toggle skill:b in the custom drawer to make a real override.
    await openCustomDrawer(renderer);
    await act(async () => { renderer.root.findByProps({ 'data-loadout-perk': 'b' }).props.onClick(); });
    // Commit the workshop so drafts are staged back to the parent form.
    await commitWorkshop(renderer);
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].skillLoadouts).toEqual({ 'bot-1': { include: ['skill:a', 'skill:b'] } });
  });

  it('drops the loadout of a bot the user unchecked before submitting', async () => {
    const { bodies } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await checkBot(renderer, 'bot-2', true);
    await act(async () => { renderer.root.findAllByProps({ name: 'mode', value: 'all' })[0]!.props.onChange(); });
    await setContent(renderer, 'go');

    await selectLineupBot(renderer, 'bot-2');
    await openCustomDrawer(renderer);
    await act(async () => { renderer.root.findByProps({ 'data-loadout-perk': 'b' }).props.onClick(); });
    // Commit the workshop so drafts are staged, then uncheck bot-2.
    await commitWorkshop(renderer);
    await checkBot(renderer, 'bot-2', false);
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect('skillLoadouts' in bodies[0]).toBe(false);
  });

  it('discards workshop edits when cancelled (staged Save/Cancel contract)', async () => {
    const { bodies } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await setContent(renderer, 'go');
    await selectLineupBot(renderer, 'bot-1');
    await openCustomDrawer(renderer);
    await act(async () => { renderer.root.findByProps({ 'data-loadout-perk': 'b' }).props.onClick(); });
    // Cancel the workshop — drafts must NOT be staged back to the parent.
    await act(async () => { renderer.root.findByProps({ 'data-action': 'workshop-cancel' }).props.onClick(); });
    await flush();
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect('skillLoadouts' in bodies[0]).toBe(false);
  });

  it('shows a lineup card for the fallback Lead the request will actually carry', async () => {
    mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-2', true);
    await openWorkshop(renderer);

    expect(renderer.root.findAllByProps({ 'data-loadout-bot': 'bot-2' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-loadout-bot': 'bot-1' })).toHaveLength(0);
  });

  it('offers no loadout workshop until the entry button is clicked', async () => {
    mockApis();
    const renderer = renderDialog();
    await openAdvanced(renderer);
    await flush();
    // Summary card is in advanced area, but the TeamBuilder (workshop) is not mounted yet
    expect(renderer.root.findAllByProps({ 'data-loadout-summary': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-session-loadout': true })).toHaveLength(0);
  });

  it('keeps loadout inside Advanced Settings and pays no catalog cost until workshop opens', async () => {
    const { calls } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await flush();

    expect(renderer.root.findAllByProps({ id: 'cs-advanced-fields' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-session-loadout': true })).toHaveLength(0);
    expect(calls.filter(url => url.startsWith('/api/skills')
      || url.startsWith('/api/skill-packs')
      || url.startsWith('/api/bots'))).toHaveLength(0);

    // Opening advanced shows the summary card but does NOT fetch the catalog
    await openAdvanced(renderer);
    expect(renderer.root.findAllByProps({ 'data-loadout-summary': true })).toHaveLength(1);
    expect(calls.filter(url => url.startsWith('/api/skills')
      || url.startsWith('/api/skill-packs')
      || url.startsWith('/api/bots'))).toHaveLength(0);

    // Opening the workshop mounts the TeamBuilder and fetches the catalog
    await openWorkshop(renderer);
    expect(renderer.root.findAllByProps({ 'data-session-loadout': true })).toHaveLength(1);
    expect(calls.filter(url => url.startsWith('/api/skills')
      || url.startsWith('/api/skill-packs')
      || url.startsWith('/api/bots'))).toHaveLength(3);
  });
});

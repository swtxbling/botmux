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
  return {
    open: false,
    showModal() { (this as any).open = true; },
    close() { (this as any).open = false; },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLDialogElement;
}

const bots = [
  { larkAppId: 'bot-1', botName: 'Bot 1' },
  { larkAppId: 'bot-2', botName: 'Bot 2' },
];

function mockApis(): { bodies: any[] } {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
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
  return { bodies };
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

async function expandLoadout(renderer: TestRenderer.ReactTestRenderer, larkAppId: string) {
  const toggle = renderer.root
    .findByProps({ 'data-loadout-row': larkAppId })
    .findByProps({ 'data-action': 'toggle-loadout' });
  await act(async () => { await toggle.props.onClick(); });
  await flush();
}

describe('create-session dialog ↔ skillLoadouts wiring', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('omits skillLoadouts entirely when the user never opens a loadout', async () => {
    // Absence is what makes the daemon inherit each bot's own policy. An
    // explicit null would be rejected as bad_skill_loadout, and an empty object
    // would be a real (wrong) override — so the key must simply not be there.
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
    await expandLoadout(renderer, 'bot-1');

    // bot-1's own policy is skill:a; adding skill:b makes it a real override.
    await act(async () => { renderer.root.findByProps({ 'data-loadout-skill': 'b' }).props.onClick(); });
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].skillLoadouts).toEqual({ 'bot-1': { include: ['skill:a', 'skill:b'] } });
  });

  it('drops the loadout of a bot the user unchecked before submitting', async () => {
    // All mode gives every checked bot a row; unchecking one must not leave a
    // stale entry for a bot that will never spawn.
    const { bodies } = mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-1', true);
    await checkBot(renderer, 'bot-2', true);
    await act(async () => { renderer.root.findAllByProps({ name: 'mode', value: 'all' })[0]!.props.onChange(); });
    await setContent(renderer, 'go');

    await expandLoadout(renderer, 'bot-2');
    await act(async () => { renderer.root.findByProps({ 'data-loadout-row': 'bot-2' }).findByProps({ 'data-loadout-skill': 'b' }).props.onClick(); });
    await checkBot(renderer, 'bot-2', false);
    await submit(renderer);

    expect(bodies).toHaveLength(1);
    expect('skillLoadouts' in bodies[0]).toBe(false);
  });

  it('shows a row for the fallback Lead the request will actually carry', async () => {
    // The Lead <select> is untouched, so `lead` is still empty while submit
    // falls back to the first checked bot. Reading the raw state would render
    // no rows at all for the bot that is about to spawn.
    mockApis();
    const renderer = renderDialog();
    await checkBot(renderer, 'bot-2', true);
    await flush();

    expect(renderer.root.findAllByProps({ 'data-loadout-row': 'bot-2' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-loadout-row': 'bot-1' })).toHaveLength(0);
  });

  it('offers no loadout rows until a bot is selected', async () => {
    mockApis();
    const renderer = renderDialog();
    await flush();
    expect(renderer.root.findAllByProps({ 'data-session-loadout': true })).toHaveLength(0);
  });
});

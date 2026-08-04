import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SkillLoadoutPicker, resolveLoadoutPreview } from '../src/dashboard/web/skills/skill-loadout-picker.js';
import type { SkillRow } from '../src/dashboard/web/skills/types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const packs = [
  { id: 'ops', name: 'Ops', include: ['skill:a', 'skill:b'] },
  { id: 'qa', name: 'QA', include: ['skill:c', 'skill:gone'] },
];

const skills: SkillRow[] = [
  { name: 'a', tags: [], rootDir: '/a', entrypoint: 'SKILL.md', source: { type: 'user', root: '/a' } },
  { name: 'b', tags: [], rootDir: '/b', entrypoint: 'SKILL.md', source: { type: 'user', root: '/b' } },
  { name: 'c', tags: [], rootDir: '/c', entrypoint: 'SKILL.md', source: { type: 'user', root: '/c' } },
];

describe('resolveLoadoutPreview', () => {
  it('matches the backend precedence: a direct pick shadows the same pack member', () => {
    const resolved = resolveLoadoutPreview(['b'], ['ops'], packs);
    const bySource = Object.fromEntries(resolved.map(entry => [entry.name, entry.source]));
    expect(bySource).toEqual({ b: 'direct', a: 'pack:Ops' });
    expect(resolved).toHaveLength(2);
  });

  it('deduplicates skills shared by two packs', () => {
    const overlapping = [
      { id: 'p1', name: 'P1', include: ['skill:a'] },
      { id: 'p2', name: 'P2', include: ['skill:a'] },
    ];
    expect(resolveLoadoutPreview([], ['p1', 'p2'], overlapping)).toEqual([{ name: 'a', source: 'pack:P1' }]);
  });

  it('ignores unknown packs and non-skill selectors rather than throwing', () => {
    expect(resolveLoadoutPreview([], ['nope'], packs)).toEqual([]);
    const weird = [{ id: 'w', name: 'W', include: ['workflow:x', 'skill:a'] }];
    expect(resolveLoadoutPreview([], ['w'], weird)).toEqual([{ name: 'a', source: 'pack:W' }]);
  });

  it('returns an empty set for an empty selection (explicit "no skills")', () => {
    expect(resolveLoadoutPreview([], [], packs)).toEqual([]);
  });
});

describe('SkillLoadoutPicker', () => {
  function render(over: Partial<React.ComponentProps<typeof SkillLoadoutPicker>> = {}) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SkillLoadoutPicker, {
        skills,
        packs,
        selectedSkills: new Set<string>(),
        selectedPacks: new Set<string>(),
        onToggleSkill: vi.fn(),
        onTogglePack: vi.fn(),
        ...over,
      }));
    });
    return renderer;
  }

  it('is fully controlled: toggling reports upward without mutating its own view', () => {
    const onToggleSkill = vi.fn();
    const renderer = render({ selectedSkills: new Set(['a']), onToggleSkill });
    const box = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    expect(box.props.checked).toBe(true);

    act(() => { box.props.onChange(); });
    expect(onToggleSkill).toHaveBeenCalledWith('a');
    // No internal draft state — the checkbox still reflects the prop, so the
    // caller stays the single owner of the selection it will submit.
    expect(renderer.root.findByProps({ 'data-loadout-skill': 'a' }).props.checked).toBe(true);
  });

  it('reflects pack selection and reports pack toggles', () => {
    const onTogglePack = vi.fn();
    const renderer = render({ selectedPacks: new Set(['ops']), onTogglePack });
    expect(renderer.root.findByProps({ 'data-loadout-pack': 'ops' }).props.checked).toBe(true);
    act(() => { renderer.root.findByProps({ 'data-loadout-pack': 'qa' }).props.onChange(); });
    expect(onTogglePack).toHaveBeenCalledWith('qa');
  });

  it('renders the resolved preview with provenance, direct winning over pack', () => {
    const renderer = render({ selectedSkills: new Set(['b']), selectedPacks: new Set(['ops']) });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(renderer.root.findAllByProps({ 'data-resolved-skill': 'b' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ 'data-resolved-skill': 'a' }).length).toBeGreaterThan(0);
    expect(rendered).toContain('pack:Ops');
  });

  it('flags selected-but-missing skills instead of hiding them', () => {
    // A loadout may name a skill that is no longer installed; the picker must
    // surface it so the user can deselect, not silently drop it.
    const renderer = render({
      selectedSkills: new Set(['b', 'gone']),
      unavailableSkills: new Set(['gone']),
    });
    const missing = renderer.root.findByProps({ 'data-resolved-skill': 'gone' });
    expect(String(missing.props.className)).toContain('skills-resolved-missing');
  });

  it('renders removable rows for selected-but-missing skills and packs', () => {
    // A saved loadout can outlive the things it names. Without a checkbox the
    // stale entry is visible but un-removable, so the user can never clean it.
    const onToggleSkill = vi.fn();
    const onTogglePack = vi.fn();
    const renderer = render({
      selectedSkills: new Set(['a', 'uninstalled']),
      selectedPacks: new Set(['ops', 'deleted-pack']),
      onToggleSkill,
      onTogglePack,
    });

    const orphanSkill = renderer.root.findByProps({ 'data-loadout-orphan': 'skill' });
    expect(orphanSkill.props.checked).toBe(true);
    act(() => { orphanSkill.props.onChange(); });
    expect(onToggleSkill).toHaveBeenCalledWith('uninstalled');

    const orphanPack = renderer.root.findByProps({ 'data-loadout-orphan': 'pack' });
    expect(orphanPack.props.checked).toBe(true);
    act(() => { orphanPack.props.onChange(); });
    expect(onTogglePack).toHaveBeenCalledWith('deleted-pack');
  });

  it('does not invent orphan rows when everything resolves', () => {
    const renderer = render({ selectedSkills: new Set(['a']), selectedPacks: new Set(['ops']) });
    expect(renderer.root.findAllByProps({ 'data-loadout-orphan': 'skill' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-loadout-orphan': 'pack' })).toHaveLength(0);
  });

  it('honours disabled without losing the current selection', () => {
    const renderer = render({ selectedSkills: new Set(['a']), disabled: true });
    const box = renderer.root.findByProps({ 'data-loadout-skill': 'a' });
    expect(box.props.disabled).toBe(true);
    expect(box.props.checked).toBe(true);
  });

  it('scopes itself with idPrefix so two pickers can coexist', () => {
    const renderer = render({ idPrefix: 'session-loadout' });
    expect(renderer.root.findAllByProps({ 'data-loadout-picker': 'session-loadout' })).toHaveLength(1);
  });
});

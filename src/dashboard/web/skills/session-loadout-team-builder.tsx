import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useT } from '../react-hooks.js';
import {
  resolveLoadoutPreview,
  type LoadoutPackOption,
} from './skill-loadout-picker.js';
import {
  isLoadoutCustomised,
  policyFromSelection,
  selectionFromPolicy,
  type LoadoutDrafts,
} from '../create-session-loadout.js';
import type { BotRow, SkillRow } from './types.js';
import type { BotSkillPolicy } from '../../../core/skills/types.js';

interface LoadoutCatalog {
  skills: SkillRow[];
  packs: LoadoutPackOption[];
  bots: BotRow[];
}

/** Tri-state of a skill across the currently selected (writable) bots. */
type SkillTriState = 'all' | 'none' | 'mixed';

/** Game-style "team → loadout → fine-tune" builder.
 *
 *  Replaces the per-bot dual-column workbench with three layers:
 *    1. Lineup  — multi-select Bot cards (the "team")
 *    2. Loadout — Pack/Build cards applied to all selected Bots at once
 *    3. Fine-tune — individual Skills (Perks), only in the custom drawer
 *
 *  Backend contract is unchanged: `LoadoutDrafts` is still a per-bot map,
 *  absent = inherit, `{ include: [] }` = explicit clear. */
export function SessionLoadoutTeamBuilder(props: {
  targets: Array<{ larkAppId: string; botName: string }>;
  drafts: LoadoutDrafts;
  onChange: (drafts: LoadoutDrafts) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const [selectedBots, setSelectedBots] = useState<Set<string>>(() => new Set());
  const [showCustom, setShowCustom] = useState(false);
  const [mobileTab, setMobileTab] = useState<'lineup' | 'builds' | 'preview'>('lineup');
  const [catalog, setCatalog] = useState<LoadoutCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadCatalog = useCallback(async (opts?: { force?: boolean }) => {
    if (inFlightRef.current) return;
    if (catalog && !opts?.force) return;
    inFlightRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const [skillsRes, packsRes, botsRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/skill-packs').catch(() => null),
        fetch('/api/bots'),
      ]);
      const skillsBody = await skillsRes.json().catch(() => ({}));
      const packsBody = packsRes ? await packsRes.json().catch(() => ({})) : {};
      const botsBody = await botsRes.json().catch(() => ({}));
      if (!skillsRes.ok) throw new Error(skillsBody?.error ?? `skills HTTP ${skillsRes.status}`);
      if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
      let packs: LoadoutPackOption[] = [];
      if (packsRes?.ok && Array.isArray(packsBody.packs)) {
        packs = packsBody.packs.map((pack: any) => ({ id: pack.id, name: pack.name, include: pack.include ?? [] }));
      } else if (packsRes && packsRes.status !== 404) {
        throw new Error(packsBody?.error ?? `packs HTTP ${packsRes.status}`);
      } else if (!packsRes) {
        throw new Error('packs_network_error');
      }
      if (!Array.isArray(botsBody.bots)) throw new Error('bots_malformed_response');
      if (!mountedRef.current) return;
      setCatalog({
        skills: Array.isArray(skillsBody.skills) ? skillsBody.skills : [],
        packs,
        bots: botsBody.bots,
      });
    } catch (err: any) {
      if (mountedRef.current) setLoadError(err?.message ?? String(err));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [catalog]);

  useEffect(() => {
    if (props.targets.length > 0) void loadCatalog();
  }, [loadCatalog, props.targets.length]);

  // Prune selection when targets shrink so we never hold a stale id for a bot
  // that will not spawn — otherwise the count reads "2 / 1" and batch writes
  // target a hidden bot.
  useEffect(() => {
    setSelectedBots(prev => {
      const ids = new Set(props.targets.map(t => t.larkAppId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id); else changed = true;
      }
      return changed ? next : prev;
    });
  }, [props.targets]);

  const installedNames = useMemo(
    () => new Set((catalog?.skills ?? []).map(s => s.name)),
    [catalog],
  );

  const botStatusOf = useCallback((larkAppId: string): { ok: true; row: BotRow } | { ok: false; reason: string } => {
    if (!catalog) return { ok: false, reason: 'catalog_unavailable' };
    const row = catalog.bots.find(b => b.larkAppId === larkAppId);
    if (!row) return { ok: false, reason: `bot_missing:${larkAppId}` };
    if (row.error) return { ok: false, reason: `bot_unavailable:${larkAppId}:${row.error}` };
    return { ok: true, row };
  }, [catalog]);

  const botPolicyOf = useCallback(
    (larkAppId: string): { include?: readonly string[] } | undefined =>
      catalog?.bots.find(b => b.larkAppId === larkAppId)?.skills ?? undefined,
    [catalog],
  );

  const reloadCatalog = useCallback(() => { void loadCatalog({ force: true }); }, [loadCatalog]);

  /** Only bots that are both selected AND editable — the real batch target. */
  const writableSelected = useMemo(
    () => props.targets
      .filter(t => selectedBots.has(t.larkAppId))
      .filter(t => botStatusOf(t.larkAppId).ok)
      .map(t => t.larkAppId),
    [props.targets, selectedBots, botStatusOf],
  );

  // ── Lineup selection ──────────────────────────────────────────────
  const toggleBot = useCallback((larkAppId: string) => {
    setSelectedBots(prev => {
      const next = new Set(prev);
      if (next.has(larkAppId)) next.delete(larkAppId); else next.add(larkAppId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    // Only select editable bots; non-editable cards are disabled and cannot
    // be picked, so the count always matches the real writable target set.
    const editable = props.targets.filter(t => botStatusOf(t.larkAppId).ok).map(t => t.larkAppId);
    setSelectedBots(new Set(editable));
  }, [props.targets, botStatusOf]);

  const clearSelection = useCallback(() => setSelectedBots(new Set()), []);

  // ── Batch operations ──────────────────────────────────────────────
  /** Apply a pack's include to all writable selected bots. */
  const applyPackToSelected = useCallback((packId: string) => {
    if (!catalog) return;
    const pack = catalog.packs.find(p => p.id === packId);
    if (!pack) return;
    const next = { ...props.drafts };
    for (const larkAppId of writableSelected) {
      const policy = policyFromSelection([], [packId]);
      if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
      else delete next[larkAppId];
    }
    props.onChange(next);
  }, [catalog, writableSelected, props.drafts, props.onChange, botPolicyOf]);

  /** Restore each writable selected bot to its own default (delete the draft key). */
  const restoreSelectedDefaults = useCallback(() => {
    const next = { ...props.drafts };
    for (const larkAppId of writableSelected) delete next[larkAppId];
    props.onChange(next);
  }, [writableSelected, props.drafts, props.onChange]);

  /** Set a skill to a uniform state across all writable selected bots.
   *  `enabled: true` forces the skill on for everyone; `false` forces it off.
   *
   *  Must account for pack-provided skills:
   *  - Enabling a skill already provided by a pack is a no-op (no duplicate
   *    direct selector; the effective set is unchanged).
   *  - Disabling a pack-provided skill requires materializing the current
   *    effective skill set as direct selectors, dropping the pack(s) that
   *    provide the target skill, then removing the target — so the final
   *    effective set actually shrinks. This is "from loadout to custom". */
  const setSkillForSelected = useCallback((skillName: string, enabled: boolean) => {
    if (!catalog) return;
    const next = { ...props.drafts };
    for (const larkAppId of writableSelected) {
      const draft = next[larkAppId];
      const base = draft ?? botPolicyOf(larkAppId);
      const { skills: directSkills, packs } = selectionFromPolicy(base);
      const effective = new Set(
        resolveLoadoutPreview(directSkills, packs, catalog.packs).map(e => e.name),
      );

      if (enabled) {
        // Already effective (direct or via pack) → no-op.
        if (effective.has(skillName)) continue;
        const nextSkills = new Set(directSkills);
        nextSkills.add(skillName);
        const policy = policyFromSelection(nextSkills, packs);
        if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
        else delete next[larkAppId];
      } else {
        // Not effective → nothing to remove.
        if (!effective.has(skillName)) continue;
        // If a pack provides this skill, materialize all effective skills as
        // direct selectors and drop the providing pack(s).
        const packList = [...packs];
        const providingPacks = packList.filter(packId => {
          const pack = catalog.packs.find(p => p.id === packId);
          return pack?.include.some(sel => sel === `skill:${skillName}`);
        });
        if (providingPacks.length > 0) {
          const materialized = new Set(effective);
          materialized.delete(skillName);
          const remainingPacks = packList.filter(packId => !providingPacks.includes(packId));
          const policy = policyFromSelection(materialized, remainingPacks);
          if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
          else delete next[larkAppId];
        } else {
          // Purely direct selector → just remove it.
          const nextSkills = new Set(directSkills);
          nextSkills.delete(skillName);
          const policy = policyFromSelection(nextSkills, packs);
          if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
          else delete next[larkAppId];
        }
      }
    }
    props.onChange(next);
  }, [catalog, writableSelected, props.drafts, props.onChange, botPolicyOf]);

  /** Tri-state of a skill across writable selected bots, for the perk UI.
   *  Based on EFFECTIVE skills (direct + pack-expanded), not just direct
   *  selectors — otherwise a skill provided only by a pack reads as "none". */
  const skillTriState = useCallback((skillName: string): SkillTriState => {
    if (writableSelected.length === 0) return 'none';
    let onCount = 0;
    for (const larkAppId of writableSelected) {
      const sel = selectionFromPolicy(props.drafts[larkAppId] ?? botPolicyOf(larkAppId));
      const effective = resolveLoadoutPreview(sel.skills, sel.packs, catalog?.packs ?? []);
      if (effective.some(e => e.name === skillName)) onCount++;
    }
    if (onCount === 0) return 'none';
    if (onCount === writableSelected.length) return 'all';
    return 'mixed';
  }, [writableSelected, props.drafts, botPolicyOf, catalog]);

  // ── Diff preview ──────────────────────────────────────────────────
  const preview = useMemo<null | {
    rows: Array<{
      larkAppId: string; botName: string; editable: boolean; customised: boolean;
      defaultCount: number; finalCount: number; added: string[]; removed: string[];
    }>;
    commonSkills: Set<string>;
  }>(() => {
    if (!catalog) return null;
    const rows = props.targets
      .filter(t => selectedBots.has(t.larkAppId))
      .map(t => {
        const status = botStatusOf(t.larkAppId);
        const botPolicy = botPolicyOf(t.larkAppId);
        const draft = props.drafts[t.larkAppId];
        const effective: { include?: readonly string[] } | undefined = draft ?? botPolicy;
        const sel = selectionFromPolicy(effective);
        const finalSkills = resolveLoadoutPreview(sel.skills, sel.packs, catalog.packs);
        const defaultSel = selectionFromPolicy(botPolicy);
        const defaultSkills = resolveLoadoutPreview(defaultSel.skills, defaultSel.packs, catalog.packs);
        const defaultNames = new Set(defaultSkills.map(s => s.name));
        const finalNames = new Set(finalSkills.map(s => s.name));
        const added = [...finalNames].filter(n => !defaultNames.has(n));
        const removed = [...defaultNames].filter(n => !finalNames.has(n));
        return {
          larkAppId: t.larkAppId,
          botName: t.botName,
          editable: status.ok,
          customised: isLoadoutCustomised(draft, botPolicy),
          defaultCount: defaultSkills.length,
          finalCount: finalSkills.length,
          added,
          removed,
        };
      });
    const commonSkills = rows.length > 0
      ? rows.reduce<Set<string>>((acc, r, i) => {
          if (i === 0) return new Set([...resolveLoadoutPreview(
            selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId)).skills,
            selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId)).packs,
            catalog.packs,
          ).map(s => s.name)]);
          const names = new Set(resolveLoadoutPreview(
            selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId)).skills,
            selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId)).packs,
            catalog.packs,
          ).map(s => s.name));
          return new Set([...acc].filter(n => names.has(n)));
        }, new Set<string>())
      : new Set<string>();
    return { rows, commonSkills };
  }, [catalog, props.targets, selectedBots, props.drafts, botStatusOf, botPolicyOf]);

  // ── Drag-and-drop: drop a pack on the lineup to apply to all selected ──
  const [dragPackId, setDragPackId] = useState<string | null>(null);

  const startPackDrag = useCallback((event: DragEvent<HTMLElement>, packId: string) => {
    setDragPackId(packId);
    event.dataTransfer.effectAllowed = 'copy';
    // Firefox refuses to begin native DnD unless at least one payload is set.
    event.dataTransfer.setData('text/plain', `pack:${packId}`);
  }, []);

  if (props.targets.length === 0) return null;

  const errorCard = (message: string) => (
    <div className="session-loadout-blocked">
      <p className="hint-warn">{message}</p>
      <button type="button" data-action="retry-loadout-catalog" disabled={props.disabled || loading} onClick={reloadCatalog}>
        {tr('skills.refresh')}
      </button>
    </div>
  );

  return (
    <div className="session-loadout session-loadout-team" data-session-loadout>
      <div className="session-loadout-head">
        <strong>{tr('sessions.create.loadoutTitle')}</strong>
        <small>{tr('sessions.create.loadoutHint')}</small>
      </div>

      {!catalog && loading && <small className="muted">{tr('common.loading')}</small>}
      {!catalog && loadError && errorCard(loadError)}

      {catalog && (
        <>
          {/* Mobile segmented control — switches between lineup/builds/preview.
              Hidden on desktop where the 3-column grid shows all sections. */}
          <nav className="loadout-mobile-tabs" role="tablist" aria-label={tr('sessions.create.loadoutMobileTabs')}>
            {(['lineup', 'builds', 'preview'] as const).map((tab, idx) => {
              const tabs = ['lineup', 'builds', 'preview'] as const;
              const active = mobileTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`loadout-tab-${tab}`}
                  aria-selected={active}
                  aria-controls={`loadout-panel-${tab}`}
                  tabIndex={active ? 0 : -1}
                  className={`loadout-mobile-tab${active ? ' is-active' : ''}`}
                  data-mobile-tab={tab}
                  ref={el => { tabRefs.current[tab] = el; }}
                  onClick={() => setMobileTab(tab)}
                  onKeyDown={e => {
                    let next = -1;
                    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
                    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
                    else if (e.key === 'Home') next = 0;
                    else if (e.key === 'End') next = tabs.length - 1;
                    if (next >= 0) {
                      e.preventDefault();
                      setMobileTab(tabs[next]);
                      // Move focus to the newly activated tab (roving tabindex).
                      tabRefs.current[tabs[next]]?.focus();
                    }
                  }}
                >
                  {tab === 'lineup'
                    ? tr('sessions.create.loadoutLineup')
                    : tab === 'builds'
                      ? tr('sessions.create.loadoutBuilds')
                      : tr('sessions.create.loadoutPreview')}
                </button>
              );
            })}
          </nav>
          {/* ── Layer 1: Lineup ── */}
          <section className="loadout-lineup" data-tab="lineup" data-tab-active={mobileTab === 'lineup'} role="tabpanel" id="loadout-panel-lineup" aria-labelledby="loadout-tab-lineup" aria-label={tr('sessions.create.loadoutLineup')}>
            <div className="loadout-lineup-head">
              <span>
                <strong>{tr('sessions.create.loadoutLineup')}</strong>
                <small>{tr('sessions.create.loadoutLineupHint')}</small>
              </span>
              <span className="loadout-lineup-actions">
                <button type="button" className="bd-button small" onClick={selectAll} disabled={props.disabled}>
                  {tr('sessions.create.loadoutSelectAll')}
                </button>
                <button type="button" className="bd-button small" onClick={clearSelection} disabled={props.disabled || selectedBots.size === 0}>
                  {tr('sessions.create.loadoutClear')}
                </button>
                <span className="loadout-selected-count" data-selected-count={writableSelected.length}>
                  {tr('sessions.create.loadoutSelectedCount', { count: writableSelected.length, total: props.targets.length })}
                </span>
              </span>
            </div>

            <div
              className="loadout-lineup-grid"
              data-loadout-lineup
              onDragOver={e => { if (dragPackId) e.preventDefault(); }}
              onDrop={e => { if (dragPackId) { e.preventDefault(); applyPackToSelected(dragPackId); setDragPackId(null); } }}
            >
              {props.targets.map(target => {
                const status = botStatusOf(target.larkAppId);
                const botPolicy = botPolicyOf(target.larkAppId);
                const draft = props.drafts[target.larkAppId];
                const customised = isLoadoutCustomised(draft, botPolicy);
                const sel = selectionFromPolicy(draft ?? botPolicy);
                const finalCount = resolveLoadoutPreview(sel.skills, sel.packs, catalog.packs).length;
                const defaultSel = selectionFromPolicy(botPolicy);
                const defaultCount = resolveLoadoutPreview(defaultSel.skills, defaultSel.packs, catalog.packs).length;
                const isEmptyDefault = !customised && defaultCount === 0;
                const selected = selectedBots.has(target.larkAppId);
                const disabled = props.disabled || !status.ok;
                return (
                  <button
                    key={target.larkAppId}
                    type="button"
                    className={`loadout-bot-card${selected ? ' is-selected' : ''}${customised ? ' is-customised' : ''}${!status.ok ? ' is-unavailable' : ''}`}
                    data-loadout-bot={target.larkAppId}
                    data-loadout-bot-editable={status.ok ? 'true' : 'false'}
                    aria-pressed={selected}
                    aria-disabled={disabled || undefined}
                    title={status.ok ? target.botName : tr('sessions.create.loadoutBotUnavailable', { reason: status.reason })}
                    disabled={disabled}
                    onClick={() => toggleBot(target.larkAppId)}
                  >
                    <span className="loadout-bot-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                    <span className="loadout-bot-name">
                      <strong>{target.botName}</strong>
                    </span>
                    <span className="loadout-bot-meta">
                      <small data-loadout-state={customised ? 'custom' : isEmptyDefault ? 'empty' : 'inherit'}>
                        {customised
                          ? tr('sessions.create.loadoutCustomLabel')
                          : isEmptyDefault
                            ? tr('sessions.create.loadoutDefaultEmpty')
                            : tr('sessions.create.loadoutDefaultLabel')}
                      </small>
                      <span className="loadout-bot-count" data-loadout-final-count={finalCount}>
                        {tr('sessions.create.loadoutFinalCount', { count: finalCount })}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Layer 2: Loadouts (Packs / Builds) ── */}
          <section className="loadout-builds" data-tab="builds" data-tab-active={mobileTab === 'builds'} role="tabpanel" id="loadout-panel-builds" aria-labelledby="loadout-tab-builds" aria-label={tr('sessions.create.loadoutBuilds')}>
            <div className="loadout-builds-head">
              <span>
                <strong>{tr('sessions.create.loadoutBuilds')}</strong>
                <small>{tr('sessions.create.loadoutBuildsHint', { count: writableSelected.length })}</small>
              </span>
              <button
                type="button"
                className="bd-button small"
                onClick={() => setShowCustom(v => !v)}
                disabled={props.disabled || writableSelected.length === 0}
                aria-expanded={showCustom}
              >
                {showCustom ? tr('sessions.create.loadoutHideCustom') : tr('sessions.create.loadoutCustomFine')}
              </button>
            </div>

            {writableSelected.length === 0 && (
              <p className="loadout-empty-hint">{tr('sessions.create.loadoutSelectBotsFirst')}</p>
            )}

            <div className="loadout-build-grid">
              {catalog.packs.map(pack => {
                const appliedCount = preview?.rows.filter(r => {
                  const sel = selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId));
                  return sel.packs.has(pack.id);
                }).length ?? 0;
                return (
                  <div
                    key={pack.id}
                    className="loadout-build-card"
                    data-loadout-pack={pack.id}
                    draggable={!props.disabled && writableSelected.length > 0}
                    onDragStart={e => startPackDrag(e, pack.id)}
                    onDragEnd={() => setDragPackId(null)}
                  >
                    <div className="loadout-build-card-head">
                      <strong>{pack.name}</strong>
                      <span className="loadout-build-count">{tr('skills.skillCount', { count: pack.include.length })}</span>
                    </div>
                    <div className="loadout-build-card-skills">
                      {pack.include.slice(0, 4).map(sel => (
                        <span key={sel} className="loadout-build-skill">{sel.replace('skill:', '')}</span>
                      ))}
                      {pack.include.length > 4 && <span className="loadout-build-more">+{pack.include.length - 4}</span>}
                    </div>
                    <button
                      type="button"
                      className="bd-button primary small loadout-build-apply"
                      data-action="apply-pack"
                      data-pack-id={pack.id}
                      disabled={props.disabled || writableSelected.length === 0}
                      onClick={() => applyPackToSelected(pack.id)}
                    >
                      {tr('sessions.create.loadoutApplyBuild', { count: writableSelected.length })}
                    </button>
                    {appliedCount > 0 && (
                      <span className="loadout-build-applied" data-pack-applied={appliedCount}>
                        {tr('sessions.create.loadoutAppliedTo', { count: appliedCount })}
                      </span>
                    )}
                  </div>
                );
              })}
              {catalog.packs.length === 0 && (
                <small className="muted">{tr('skills.packsEmpty')}</small>
              )}
            </div>
          </section>

          {/* ── Layer 3: Custom fine-tune (Perks — skills only, no packs) ── */}
          {showCustom && writableSelected.length > 0 && (
            <section className="loadout-custom" data-tab="builds" data-tab-active={mobileTab === 'builds'} role="tabpanel" aria-label={tr('sessions.create.loadoutCustomFine')}>
              <div className="loadout-custom-head">
                <strong>{tr('sessions.create.loadoutCustomFine')}</strong>
                <small>{tr('sessions.create.loadoutCustomHint', { count: writableSelected.length })}</small>
              </div>
              {writableSelected.length > 1 && (
                <p className="hint-warn loadout-custom-multi">
                  {tr('sessions.create.loadoutMultiWarning')}
                </p>
              )}
              <div className="loadout-perk-list" data-loadout-perk-list>
                {catalog.skills.map(skill => {
                  const state = skillTriState(skill.name);
                  const enabled = state === 'all';
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      className={`loadout-perk${enabled ? ' is-on' : ''}${state === 'mixed' ? ' is-mixed' : ''}`}
                      data-loadout-perk={skill.name}
                      data-perk-state={state}
                      aria-pressed={state === 'mixed' ? 'mixed' : enabled}
                      disabled={props.disabled}
                      onClick={() => setSkillForSelected(skill.name, !enabled)}
                    >
                      <span className="loadout-perk-check" aria-hidden="true">
                        {state === 'all' ? '✓' : state === 'mixed' ? '−' : ''}
                      </span>
                      <span className="loadout-perk-name">
                        <strong>{skill.name}</strong>
                        {skill.description && <small>{skill.description}</small>}
                      </span>
                      <span className="loadout-perk-state">
                        {state === 'all' ? tr('sessions.create.loadoutPerkAll') : state === 'mixed' ? tr('sessions.create.loadoutPerkMixed') : tr('sessions.create.loadoutPerkNone')}
                      </span>
                    </button>
                  );
                })}
                {catalog.skills.length === 0 && (
                  <small className="muted">{tr('skills.emptyTitle')}</small>
                )}
              </div>
            </section>
          )}

          {/* ── Diff preview ── */}
          <section className="loadout-preview" data-tab="preview" data-tab-active={mobileTab === 'preview'} role="tabpanel" id="loadout-panel-preview" aria-labelledby="loadout-tab-preview" aria-label={tr('sessions.create.loadoutPreview')}>
            <div className="loadout-preview-head">
              <strong>{tr('sessions.create.loadoutPreview')}</strong>
              <small>{tr('sessions.create.loadoutPreviewHint')}</small>
            </div>
            {preview && preview.rows.length > 0 ? (
              <>
                {preview.commonSkills.size > 0 && (
                  <div className="loadout-preview-common">
                    <span>{tr('sessions.create.loadoutCommonSkills')}</span>
                    <div className="loadout-preview-chips">
                      {[...preview.commonSkills].map(n => (
                        <span key={n} className="loadout-preview-chip">{n}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="loadout-preview-rows">
                  {preview.rows.map(r => (
                    <div key={r.larkAppId} className="loadout-preview-row" data-preview-bot={r.larkAppId}>
                      <div className="loadout-preview-bot">
                        <strong>{r.botName}</strong>
                        <small>
                          {r.editable
                            ? tr('sessions.create.loadoutPreviewCount', { from: r.defaultCount, to: r.finalCount })
                            : tr('sessions.create.loadoutDefaultUnavailable')}
                        </small>
                      </div>
                      {r.added.length > 0 && (
                        <span className="loadout-preview-diff is-add">
                          +{r.added.join(', ')}
                        </span>
                      )}
                      {r.removed.length > 0 && (
                        <span className="loadout-preview-diff is-remove">
                          −{r.removed.join(', ')}
                        </span>
                      )}
                      {r.added.length === 0 && r.removed.length === 0 && r.editable && (
                        <span className="loadout-preview-diff is-same">{tr('sessions.create.loadoutPreviewSame')}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="loadout-preview-actions">
                  <button
                    type="button"
                    className="bd-button small"
                    data-action="restore-selected-defaults"
                    disabled={props.disabled || writableSelected.length === 0}
                    onClick={restoreSelectedDefaults}
                  >
                    {tr('sessions.create.loadoutRestoreSelected', { count: writableSelected.length })}
                  </button>
                </div>
              </>
            ) : (
              <p className="loadout-preview-empty" data-preview-empty>
                {tr('sessions.create.loadoutPreviewEmpty')}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

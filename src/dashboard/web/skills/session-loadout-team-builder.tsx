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

interface LoadoutCatalog {
  skills: SkillRow[];
  packs: LoadoutPackOption[];
  bots: BotRow[];
}

/** Tri-state of a skill/pack across the currently selected (writable) bots. */
type TriState = 'all' | 'none' | 'mixed';

/** Unified drag payload: kind discriminates skill vs pack, id is the name/packId. */
interface DragItem {
  kind: 'skill' | 'pack';
  id: string;
}

/** Game-style "team → loadout → fine-tune" builder.
 *
 *  Replaces the per-bot dual-column workbench with three layers:
 *    1. Lineup  — multi-select Bot cards (the "team")
 *    2. Loadout — Pack/Build cards applied to all selected Bots at once
 *    3. Fine-tune — individual Skills (Perks), only in the custom drawer
 *
 *  Backend contract is unchanged: `LoadoutDrafts` is still a per-bot map,
 *  absent = inherit, `{ include: [] }` = explicit clear.
 *
 *  Drag-and-drop is point-to-point: a Pack or Skill dropped on an editable
 *  Bot card is ADDED (superposition) to that bot only, without changing the
 *  selected set. Batch buttons / keyboard toggles still operate on the
 *  selected set. Non-editable cards reject drops. */
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
  const catalogRef = useRef<LoadoutCatalog | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // ── Unified drag state ──
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  /** Bot currently showing a drop-reject highlight (non-editable target). */
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadCatalog = useCallback(async (opts?: { force?: boolean }) => {
    if (inFlightRef.current) return;
    // catalogRef guards against the stale-closure retry bug: a retry runs in
    // the same tick as the click, before React re-renders with cleared state,
    // so reading `catalog` from closure would still see the stale value and
    // silently no-op. catalogRef always reflects the latest committed catalog.
    if (catalogRef.current && !opts?.force) return;
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
      const next: LoadoutCatalog = {
        skills: Array.isArray(skillsBody.skills) ? skillsBody.skills : [],
        packs,
        bots: botsBody.bots,
      };
      catalogRef.current = next;
      setCatalog(next);
    } catch (err: any) {
      if (mountedRef.current) setLoadError(err?.message ?? String(err));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

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
    const editable = props.targets.filter(t => botStatusOf(t.larkAppId).ok).map(t => t.larkAppId);
    setSelectedBots(new Set(editable));
  }, [props.targets, botStatusOf]);

  const clearSelection = useCallback(() => setSelectedBots(new Set()), []);

  // ── Superposition helpers (single-card: wrap the shared Mut) ──────
  /** Add a pack to a single bot — delegates to addPackToBotMut so the
   *  single-card drop path and the batch path share one implementation.
   *  Only fires onChange if the draft actually changed. */
  const addPackToBot = useCallback((larkAppId: string, packId: string) => {
    const next = { ...props.drafts };
    if (addPackToBotMut(next, larkAppId, packId, catalog, botPolicyOf, botStatusOf)) {
      props.onChange(next);
    }
  }, [props.drafts, props.onChange, catalog, botPolicyOf, botStatusOf]);

  /** Add a single skill to a single bot — delegates to addSkillToBotMut.
   *  Only fires onChange if the draft actually changed. */
  const addSkillToBot = useCallback((larkAppId: string, skillName: string) => {
    const next = { ...props.drafts };
    if (addSkillToBotMut(next, larkAppId, skillName, catalog, botPolicyOf, botStatusOf)) {
      props.onChange(next);
    }
  }, [props.drafts, props.onChange, catalog, botPolicyOf, botStatusOf]);

  // ── Batch operations (operate on the selected set) ────────────────
  /** Incrementally add a pack to all writable selected bots (superposition).
   *  Fires onChange once if ANY bot changed; skips entirely if all no-ops. */
  const applyPackToSelected = useCallback((packId: string) => {
    const next = { ...props.drafts };
    let changed = false;
    for (const larkAppId of writableSelected) {
      if (addPackToBotMut(next, larkAppId, packId, catalog, botPolicyOf, botStatusOf)) changed = true;
    }
    if (changed) props.onChange(next);
  }, [writableSelected, props.drafts, props.onChange, catalog, botPolicyOf, botStatusOf]);

  /** Remove a pack from all writable selected bots, keeping other skills/packs. */
  const removePackFromSelected = useCallback((packId: string) => {
    const next = { ...props.drafts };
    let changed = false;
    for (const larkAppId of writableSelected) {
      if (removePackFromBotMut(next, larkAppId, packId, catalog, botPolicyOf, botStatusOf)) changed = true;
    }
    if (changed) props.onChange(next);
  }, [writableSelected, props.drafts, props.onChange, catalog, botPolicyOf, botStatusOf]);

  /** Restore each writable selected bot to its own default (delete the draft key). */
  const restoreSelectedDefaults = useCallback(() => {
    const next = { ...props.drafts };
    let changed = false;
    for (const larkAppId of writableSelected) {
      if (larkAppId in next) { delete next[larkAppId]; changed = true; }
    }
    if (changed) props.onChange(next);
  }, [writableSelected, props.drafts, props.onChange]);

  /** Set a skill to a uniform state across all writable selected bots.
   *  Add branch delegates to addSkillToBotMut (shared with single-card drop);
   *  remove branch keeps its pack-materialization logic (structurally asymmetric,
   *  has dedicated test coverage). */
  const setSkillForSelected = useCallback((skillName: string, enabled: boolean) => {
    if (!catalog) return;
    const next = { ...props.drafts };
    let changed = false;
    for (const larkAppId of writableSelected) {
      if (enabled) {
        if (addSkillToBotMut(next, larkAppId, skillName, catalog, botPolicyOf, botStatusOf)) changed = true;
        continue;
      }
      // Remove branch: materialize if pack-provided, else just drop the direct selector.
      const base = next[larkAppId] ?? botPolicyOf(larkAppId);
      const { skills: directSkills, packs } = selectionFromPolicy(base);
      const effective = new Set(
        resolveLoadoutPreview(directSkills, packs, catalog.packs).map(e => e.name),
      );
      if (!effective.has(skillName)) continue;
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
        const nextSkills = new Set(directSkills);
        nextSkills.delete(skillName);
        const policy = policyFromSelection(nextSkills, packs);
        if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
        else delete next[larkAppId];
      }
      changed = true;
    }
    if (changed) props.onChange(next);
  }, [catalog, writableSelected, props.drafts, props.onChange, botPolicyOf, botStatusOf]);

  /** Tri-state of a skill across writable selected bots (effective skills). */
  const skillTriState = useCallback((skillName: string): TriState => {
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

  /** Tri-state of a pack across writable selected bots (direct pack selector). */
  const packTriState = useCallback((packId: string): TriState => {
    if (writableSelected.length === 0) return 'none';
    let onCount = 0;
    for (const larkAppId of writableSelected) {
      const sel = selectionFromPolicy(props.drafts[larkAppId] ?? botPolicyOf(larkAppId));
      if (sel.packs.has(packId)) onCount++;
    }
    if (onCount === 0) return 'none';
    if (onCount === writableSelected.length) return 'all';
    return 'mixed';
  }, [writableSelected, props.drafts, botPolicyOf]);

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

  // ── Drag start (unified for packs and skills) ──
  const startDrag = useCallback((event: DragEvent<HTMLElement>, item: DragItem) => {
    setDragItem(item);
    event.dataTransfer.effectAllowed = 'copy';
    // Firefox refuses to begin native DnD unless at least one payload is set.
    event.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
  }, []);

  const clearDrag = useCallback(() => {
    setDragItem(null);
    setRejectTarget(null);
  }, []);

  // ── Single-bot drop handlers (point-to-point, superposition) ──
  const onBotDragOver = useCallback((event: DragEvent<HTMLElement>, larkAppId: string, editable: boolean) => {
    if (!dragItem) return;
    if (!editable) {
      // Non-editable: signal rejection, do NOT preventDefault (so the browser
      // shows no-drop cursor and the drop never fires).
      event.dataTransfer.dropEffect = 'none';
      setRejectTarget(larkAppId);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, [dragItem]);

  const onBotDragLeave = useCallback((larkAppId: string) => {
    setRejectTarget(prev => prev === larkAppId ? null : prev);
  }, []);

  const onBotDrop = useCallback((event: DragEvent<HTMLElement>, larkAppId: string, editable: boolean) => {
    if (!dragItem) return;
    if (!editable) {
      // Defensive: should never fire because dragOver didn't preventDefault,
      // but guard anyway so onChange is never called for a non-editable bot.
      event.preventDefault();
      clearDrag();
      return;
    }
    event.preventDefault();
    if (dragItem.kind === 'pack') addPackToBot(larkAppId, dragItem.id);
    else addSkillToBot(larkAppId, dragItem.id);
    clearDrag();
  }, [dragItem, addPackToBot, addSkillToBot, clearDrag]);

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
              Hidden on desktop where the 3-column grid shows all sections.
              Uses a button group with aria-pressed (not tablist/tab) so the
              structure stays valid when the tablist is hidden on desktop and
              panels are all visible at once. Roving tabindex + arrow keys kept. */}
          <nav className="loadout-mobile-tabs" role="group" aria-label={tr('sessions.create.loadoutMobileTabs')}>
            {(['lineup', 'builds', 'preview'] as const).map((tab, idx) => {
              const tabs = ['lineup', 'builds', 'preview'] as const;
              const active = mobileTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  id={`loadout-tab-${tab}`}
                  aria-pressed={active}
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
          <section className="loadout-lineup" data-tab="lineup" data-tab-active={mobileTab === 'lineup'} id="loadout-panel-lineup" aria-label={tr('sessions.create.loadoutLineup')}>
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

            {/* Lineup grid: NO container-level drag handlers. Each bot card
                has its own outer drop zone so drops land on a precise target. */}
            <div className="loadout-lineup-grid" data-loadout-lineup>
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
                const editable = status.ok && !props.disabled;
                const isReject = rejectTarget === target.larkAppId;
                // State label: distinguish unavailable (default unreadable) from
                // empty default — previously both collapsed to "empty".
                const stateLabel = !status.ok
                  ? tr('sessions.create.loadoutDefaultUnavailable')
                  : customised
                    ? tr('sessions.create.loadoutCustomLabel')
                    : isEmptyDefault
                      ? tr('sessions.create.loadoutDefaultEmpty')
                      : tr('sessions.create.loadoutDefaultLabel');
                const stateKind = !status.ok ? 'unavailable' : customised ? 'custom' : isEmptyDefault ? 'empty' : 'inherit';
                return (
                  <div
                    key={target.larkAppId}
                    className={`loadout-bot-slot${isReject ? ' is-drop-rejected' : ''}${dragItem && editable ? ' is-drop-target' : ''}`}
                    data-loadout-bot-slot={target.larkAppId}
                    data-drop-disabled={!editable ? 'true' : undefined}
                    onDragOver={e => onBotDragOver(e, target.larkAppId, editable)}
                    onDragLeave={() => onBotDragLeave(target.larkAppId)}
                    onDrop={e => onBotDrop(e, target.larkAppId, editable)}
                  >
                    <button
                      type="button"
                      className={`loadout-bot-card${selected ? ' is-selected' : ''}${customised ? ' is-customised' : ''}${!status.ok ? ' is-unavailable' : ''}`}
                      data-loadout-bot={target.larkAppId}
                      data-loadout-bot-editable={status.ok ? 'true' : 'false'}
                      aria-pressed={selected}
                      disabled={!editable}
                      title={status.ok ? target.botName : tr('sessions.create.loadoutBotUnavailable', { reason: status.reason })}
                      onClick={() => toggleBot(target.larkAppId)}
                    >
                      <span className="loadout-bot-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                      <span className="loadout-bot-name">
                        <strong>{target.botName}</strong>
                      </span>
                      <span className="loadout-bot-meta">
                        <small data-loadout-state={stateKind}>{stateLabel}</small>
                        {/* Visible, localizable default summary — replaces the
                            old P:N/S:N hover-only badges. Reads: "默认 1 包 · 1 Skill · 最终 3".
                            Uses DEFAULT counts (defaultSel/defaultCount), NOT the current
                            draft's finalCount — otherwise a customised bot would pass off
                            its post-edit total as the original default. */}
                        {status.ok && (
                          <span className="loadout-bot-default" data-loadout-default-summary>
                            <span className="loadout-bot-default-text">
                              {tr('sessions.create.loadoutDefaultSummary', {
                                packs: defaultSel.packs.size,
                                skills: defaultSel.skills.size,
                                final: defaultCount,
                              })}
                            </span>
                          </span>
                        )}
                        {!status.ok && (
                          <span className="loadout-bot-default" data-loadout-default-unavailable>
                            <span className="loadout-bot-default-text">
                              {tr('sessions.create.loadoutDefaultUnavailable')}
                            </span>
                          </span>
                        )}
                        {/* Independent current final count — distinct from the default
                            summary's "最终" so a customised bot shows "默认 M → 本次 N".
                            Uses finalCount (draft??default) so the user sees the live
                            post-edit total without switching to the preview panel. */}
                        {status.ok && (
                          <span className="loadout-bot-current" data-loadout-final-count={finalCount}>
                            {tr('sessions.create.loadoutCurrentFinal', { count: finalCount })}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Layer 2: Loadouts (Packs / Builds) ── */}
          <section className="loadout-builds" data-tab="builds" data-tab-active={mobileTab === 'builds'} id="loadout-panel-builds" aria-label={tr('sessions.create.loadoutBuilds')}>
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
                const tri = packTriState(pack.id);
                const appliedCount = preview?.rows.filter(r => {
                  const sel = selectionFromPolicy(props.drafts[r.larkAppId] ?? botPolicyOf(r.larkAppId));
                  return sel.packs.has(pack.id);
                }).length ?? 0;
                const buttonLabel = tri === 'all'
                  ? tr('sessions.create.loadoutPackUnequip', { count: writableSelected.length })
                  : tri === 'mixed'
                    ? tr('sessions.create.loadoutPackEquipAll', { count: writableSelected.length })
                    : tr('sessions.create.loadoutPackEquip', { count: writableSelected.length });
                return (
                  <div
                    key={pack.id}
                    className="loadout-build-card"
                    data-loadout-pack={pack.id}
                    draggable={!props.disabled}
                    onDragStart={e => startDrag(e, { kind: 'pack', id: pack.id })}
                    onDragEnd={clearDrag}
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
                      className={`bd-button small loadout-build-apply${tri === 'all' ? ' is-active' : ''}`}
                      data-action="apply-pack"
                      data-pack-id={pack.id}
                      data-pack-state={tri}
                      aria-pressed={tri === 'mixed' ? 'mixed' : tri === 'all'}
                      disabled={props.disabled || writableSelected.length === 0}
                      onClick={() => (tri === 'all' ? removePackFromSelected(pack.id) : applyPackToSelected(pack.id))}
                    >
                      {buttonLabel}
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

            {/* ── Skill catalog (always visible, always draggable) ──
                Individual Skills are draggable from here onto any editable Bot
                card — no pre-selection required, matching the "逐项从左拖到每个
                Bot" contract. The batch button inside each card is disabled until
                at least one bot is selected; at zero-selection it shows
                "unselected" state (not "none") and the "先选 Bot" hint. The
                custom drawer below still offers full tri-state fine-tuning. */}
            <div className="loadout-skill-catalog" data-loadout-skill-catalog>
              <div className="loadout-skill-catalog-head">
                <strong>{tr('sessions.create.loadoutSkillCatalog')}</strong>
                <small>{tr('sessions.create.loadoutSkillCatalogHint')}</small>
              </div>
              {writableSelected.length === 0 && (
                <p className="loadout-empty-hint" data-skill-catalog-empty>{tr('sessions.create.loadoutSelectBotsFirst')}</p>
              )}
              <div className="loadout-skill-catalog-list">
                {catalog.skills.map(skill => {
                  const noSelection = writableSelected.length === 0;
                  const state = noSelection ? 'unselected' : skillTriState(skill.name);
                  const enabled = state === 'all';
                  return (
                    <div
                      key={skill.name}
                      className="loadout-skill-card"
                      data-loadout-skill={skill.name}
                      data-skill-state={state}
                      draggable={!props.disabled}
                      onDragStart={e => startDrag(e, { kind: 'skill', id: skill.name })}
                      onDragEnd={clearDrag}
                    >
                      <span className="loadout-skill-card-name">
                        <strong>{skill.name}</strong>
                        {skill.description && <small>{skill.description}</small>}
                      </span>
                      <button
                        type="button"
                        className={`bd-button small loadout-skill-apply${enabled ? ' is-active' : ''}`}
                        data-action="apply-skill"
                        data-skill-name={skill.name}
                        data-perk-state={state}
                        aria-pressed={noSelection ? undefined : state === 'mixed' ? 'mixed' : enabled}
                        disabled={props.disabled || noSelection}
                        onClick={() => setSkillForSelected(skill.name, !enabled)}
                      >
                        {noSelection
                          ? tr('sessions.create.loadoutSelectBotsFirst')
                          : enabled
                            ? tr('sessions.create.loadoutPerkAll')
                            : state === 'mixed'
                              ? tr('sessions.create.loadoutPerkMixed')
                              : tr('sessions.create.loadoutPerkNone')}
                      </button>
                    </div>
                  );
                })}
                {catalog.skills.length === 0 && (
                  <small className="muted">{tr('skills.emptyTitle')}</small>
                )}
              </div>
            </div>

            {/* ── Custom fine-tune (Perks — skills only, no packs) ──
                NOT a tabpanel: it's a sub-section of the builds panel,
                toggled by the "自定义微调" button. Giving it role="tabpanel"
                created an invalid one-tab-two-panels ARIA structure. */}
            {showCustom && writableSelected.length > 0 && (
              <div className="loadout-custom" data-loadout-custom data-tab="builds" data-tab-active={mobileTab === 'builds'}>
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
                      <div
                        key={skill.name}
                        className="loadout-perk-drag"
                        draggable={!props.disabled}
                        onDragStart={e => startDrag(e, { kind: 'skill', id: skill.name })}
                        onDragEnd={clearDrag}
                      >
                        <button
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
                      </div>
                    );
                  })}
                  {catalog.skills.length === 0 && (
                    <small className="muted">{tr('skills.emptyTitle')}</small>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ── Diff preview ── */}
          <section className="loadout-preview" data-tab="preview" data-tab-active={mobileTab === 'preview'} id="loadout-panel-preview" aria-label={tr('sessions.create.loadoutPreview')}>
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

// ── Mutation helpers (operate on a draft object, no React state) ──
// Single implementation shared by single-card drop and batch operations.
// Each checks catalog + botStatusOf().ok, mutates `next` in place, and
// returns true if the draft actually changed (so callers can skip no-op onChange).

function addPackToBotMut(
  next: LoadoutDrafts,
  larkAppId: string,
  packId: string,
  catalog: LoadoutCatalog | null,
  botPolicyOf: (id: string) => { include?: readonly string[] } | undefined,
  botStatusOf: (id: string) => { ok: boolean },
): boolean {
  if (!catalog || !botStatusOf(larkAppId).ok) return false;
  const base = next[larkAppId] ?? botPolicyOf(larkAppId);
  const { skills, packs } = selectionFromPolicy(base);
  if (packs.has(packId)) return false; // idempotent
  const nextPacks = new Set(packs);
  nextPacks.add(packId);
  const policy = policyFromSelection(skills, nextPacks);
  if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
  else delete next[larkAppId];
  return true;
}

function removePackFromBotMut(
  next: LoadoutDrafts,
  larkAppId: string,
  packId: string,
  catalog: LoadoutCatalog | null,
  botPolicyOf: (id: string) => { include?: readonly string[] } | undefined,
  botStatusOf: (id: string) => { ok: boolean },
): boolean {
  if (!catalog || !botStatusOf(larkAppId).ok) return false;
  const base = next[larkAppId] ?? botPolicyOf(larkAppId);
  const { skills, packs } = selectionFromPolicy(base);
  if (!packs.has(packId)) return false;
  const nextPacks = new Set(packs);
  nextPacks.delete(packId);
  const policy = policyFromSelection(skills, nextPacks);
  if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
  else delete next[larkAppId];
  return true;
}

function addSkillToBotMut(
  next: LoadoutDrafts,
  larkAppId: string,
  skillName: string,
  catalog: LoadoutCatalog | null,
  botPolicyOf: (id: string) => { include?: readonly string[] } | undefined,
  botStatusOf: (id: string) => { ok: boolean },
): boolean {
  if (!catalog || !botStatusOf(larkAppId).ok) return false;
  const base = next[larkAppId] ?? botPolicyOf(larkAppId);
  const { skills, packs } = selectionFromPolicy(base);
  const effective = new Set(
    resolveLoadoutPreview(skills, packs, catalog.packs).map(e => e.name),
  );
  if (effective.has(skillName)) return false; // already effective → no-op
  const nextSkills = new Set(skills);
  nextSkills.add(skillName);
  const policy = policyFromSelection(nextSkills, packs);
  if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
  else delete next[larkAppId];
  return true;
}

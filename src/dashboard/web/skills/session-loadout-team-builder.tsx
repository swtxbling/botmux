import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../react-hooks.js';
import {
  resolveLoadoutPreview,
  SkillLoadoutPicker,
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

/** Game-style "team → loadout → fine-tune" builder.
 *
 *  Replaces the per-bot dual-column workbench with three layers:
 *    1. Lineup  — multi-select Bot cards (the "team")
 *    2. Loadout — Pack/Build cards applied to all selected Bots at once
 *    3. Fine-tune — individual Skills, only in the custom drawer
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
  const [catalog, setCatalog] = useState<LoadoutCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

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

  // ── Lineup selection ──────────────────────────────────────────────
  const toggleBot = useCallback((larkAppId: string) => {
    setSelectedBots(prev => {
      const next = new Set(prev);
      if (next.has(larkAppId)) next.delete(larkAppId); else next.add(larkAppId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedBots(new Set(props.targets.map(t => t.larkAppId)));
  }, [props.targets]);

  const clearSelection = useCallback(() => setSelectedBots(new Set()), []);

  // ── Batch operations ──────────────────────────────────────────────
  /** Apply a pack's include to all selected bots that are editable. */
  const applyPackToSelected = useCallback((packId: string) => {
    if (!catalog) return;
    const pack = catalog.packs.find(p => p.id === packId);
    if (!pack) return;
    const next = { ...props.drafts };
    for (const larkAppId of selectedBots) {
      const status = botStatusOf(larkAppId);
      if (!status.ok) continue;
      const policy = policyFromSelection([], [packId]);
      if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
      else delete next[larkAppId];
    }
    props.onChange(next);
  }, [catalog, selectedBots, props.drafts, props.onChange, botStatusOf, botPolicyOf]);

  /** Restore each selected bot to its own default (delete the draft key). */
  const restoreSelectedDefaults = useCallback(() => {
    const next = { ...props.drafts };
    for (const larkAppId of selectedBots) delete next[larkAppId];
    props.onChange(next);
  }, [selectedBots, props.drafts, props.onChange]);

  /** Toggle a single skill across all selected bots. */
  const toggleSkillForSelected = useCallback((skillName: string) => {
    if (!catalog) return;
    const next = { ...props.drafts };
    for (const larkAppId of selectedBots) {
      const status = botStatusOf(larkAppId);
      if (!status.ok) continue;
      const draft = next[larkAppId];
      const base = draft ?? botPolicyOf(larkAppId);
      const { skills, packs } = selectionFromPolicy(base);
      const nextSkills = new Set(skills);
      if (nextSkills.has(skillName)) nextSkills.delete(skillName); else nextSkills.add(skillName);
      const policy = policyFromSelection(nextSkills, packs);
      if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
      else delete next[larkAppId];
    }
    props.onChange(next);
  }, [catalog, selectedBots, props.drafts, props.onChange, botStatusOf, botPolicyOf]);

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
          {/* ── Layer 1: Lineup ── */}
          <section className="loadout-lineup" aria-label={tr('sessions.create.loadoutLineup')}>
            <div className="loadout-lineup-head">
              <span>
                <strong>{tr('sessions.create.loadoutLineup')}</strong>
                <small>{tr('sessions.create.loadoutLineupHint')}</small>
              </span>
              <span className="loadout-lineup-actions">
                <button type="button" className="btn btn-sm" onClick={selectAll} disabled={props.disabled}>
                  {tr('sessions.create.loadoutSelectAll')}
                </button>
                <button type="button" className="btn btn-sm" onClick={clearSelection} disabled={props.disabled || selectedBots.size === 0}>
                  {tr('sessions.create.loadoutClear')}
                </button>
                <span className="loadout-selected-count" data-selected-count={selectedBots.size}>
                  {tr('sessions.create.loadoutSelectedCount', { count: selectedBots.size, total: props.targets.length })}
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
                const selected = selectedBots.has(target.larkAppId);
                return (
                  <button
                    key={target.larkAppId}
                    type="button"
                    className={`loadout-bot-card${selected ? ' is-selected' : ''}${customised ? ' is-customised' : ''}${!status.ok ? ' is-unavailable' : ''}`}
                    data-loadout-bot={target.larkAppId}
                    aria-pressed={selected}
                    disabled={props.disabled}
                    onClick={() => toggleBot(target.larkAppId)}
                  >
                    <span className="loadout-bot-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                    <span className="loadout-bot-name">
                      <strong>{target.botName}</strong>
                      <small data-loadout-state={customised ? 'custom' : 'inherit'}>
                        {customised ? tr('sessions.create.loadoutCustomLabel') : tr('sessions.create.loadoutDefaultLabel')}
                      </small>
                    </span>
                    <span className="loadout-bot-count" data-loadout-final-count={finalCount}>
                      {tr('sessions.create.loadoutFinalCount', { count: finalCount })}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Layer 2: Loadouts (Packs / Builds) ── */}
          <section className="loadout-builds" aria-label={tr('sessions.create.loadoutBuilds')}>
            <div className="loadout-builds-head">
              <span>
                <strong>{tr('sessions.create.loadoutBuilds')}</strong>
                <small>{tr('sessions.create.loadoutBuildsHint', { count: selectedBots.size })}</small>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowCustom(v => !v)}
                disabled={props.disabled || selectedBots.size === 0}
                aria-expanded={showCustom}
              >
                {showCustom ? tr('sessions.create.loadoutHideCustom') : tr('sessions.create.loadoutCustomFine')}
              </button>
            </div>

            {selectedBots.size === 0 && (
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
                    draggable={!props.disabled && selectedBots.size > 0}
                    onDragStart={() => setDragPackId(pack.id)}
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
                      className="btn btn-primary btn-sm loadout-build-apply"
                      data-action="apply-pack"
                      data-pack-id={pack.id}
                      disabled={props.disabled || selectedBots.size === 0}
                      onClick={() => applyPackToSelected(pack.id)}
                    >
                      {tr('sessions.create.loadoutApplyBuild', { count: selectedBots.size })}
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

          {/* ── Layer 3: Custom fine-tune drawer ── */}
          {showCustom && selectedBots.size > 0 && (
            <section className="loadout-custom" aria-label={tr('sessions.create.loadoutCustomFine')}>
              <div className="loadout-custom-head">
                <strong>{tr('sessions.create.loadoutCustomFine')}</strong>
                <small>{tr('sessions.create.loadoutCustomHint', { count: selectedBots.size })}</small>
              </div>
              {selectedBots.size > 1 && (
                <p className="hint-warn loadout-custom-multi">
                  {tr('sessions.create.loadoutMultiWarning')}
                </p>
              )}
              {(() => {
                // Use the first selected bot's effective selection as the shared
                // starting point; toggles apply to all selected bots.
                const firstId = [...selectedBots][0];
                const firstPolicy = props.drafts[firstId] ?? botPolicyOf(firstId);
                const sel = selectionFromPolicy(firstPolicy);
                const unavailable = new Set(
                  [...sel.skills].filter(n => !installedNames.has(n)),
                );
                return (
                  <SkillLoadoutPicker
                    skills={catalog.skills}
                    packs={catalog.packs}
                    selectedSkills={sel.skills}
                    selectedPacks={sel.packs}
                    unavailableSkills={unavailable}
                    disabled={props.disabled}
                    idPrefix="team-builder"
                    onToggleSkill={toggleSkillForSelected}
                    onTogglePack={applyPackToSelected}
                  />
                );
              })()}
            </section>
          )}

          {/* ── Diff preview ── */}
          {preview && preview.rows.length > 0 && (
            <section className="loadout-preview" aria-label={tr('sessions.create.loadoutPreview')}>
              <div className="loadout-preview-head">
                <strong>{tr('sessions.create.loadoutPreview')}</strong>
                <small>{tr('sessions.create.loadoutPreviewHint')}</small>
              </div>
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
                  className="btn btn-sm"
                  data-action="restore-selected-defaults"
                  disabled={props.disabled || selectedBots.size === 0}
                  onClick={restoreSelectedDefaults}
                >
                  {tr('sessions.create.loadoutRestoreSelected', { count: selectedBots.size })}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

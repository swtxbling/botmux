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

/** Per-session Skill loadout, one collapsed row per bot that will actually
 *  spawn. Deliberately lazy and deliberately quiet:
 *
 *   • the parent mounts this component only after Advanced Settings opens, so
 *     the normal create-session path pays nothing;
 *   • once mounted, the catalog loads immediately so each still-collapsed row
 *     can honestly show the bot's existing packs/skills instead of the vague
 *     phrase "inherit default";
 *   • the full workbench stays collapsed until that particular row is opened.
 */
export function SessionLoadoutAccordion(props: {
  /** Bots that will actually spawn — already narrowed by loadoutTargetBots. */
  targets: Array<{ larkAppId: string; botName: string }>;
  drafts: LoadoutDrafts;
  onChange: (drafts: LoadoutDrafts) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Rows that have been opened at least once stay mounted, so collapsing can
   *  animate instead of the content vanishing on the first frame. */
  const [everOpened, setEverOpened] = useState<Set<string>>(() => new Set());
  const [catalog, setCatalog] = useState<LoadoutCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  /** Mirrors `catalog` / in-flight state for the guards below. A retry runs in
   *  the same tick as the click that requested it, long before React re-renders
   *  with the cleared state, so guards read from closure state would still see
   *  the stale values and silently no-op — which is exactly how the retry
   *  button ended up clearing the error card without issuing a single request. */
  const catalogRef = useRef<LoadoutCatalog | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadCatalog = useCallback(async (opts?: { force?: boolean }) => {
    if (inFlightRef.current) return;
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
      // Both of these must SUCCEED. Treating a failure as "empty" is the
      // dangerous reading: an errored /api/bots would look like "this bot has
      // no policy", and the first checkbox the user ticks would then submit a
      // loadout that silently replaces the real default.
      if (!skillsRes.ok) throw new Error(skillsBody?.error ?? `skills HTTP ${skillsRes.status}`);
      if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
      // Packs are optional ONLY on an explicit 404 (older daemon without the
      // pack API). A 5xx or a network error is a real failure: rendering an
      // empty pack list would invite the user to "fix" a loadout whose packs
      // merely failed to load.
      let packs: LoadoutPackOption[] = [];
      if (packsRes?.ok && Array.isArray(packsBody.packs)) {
        packs = packsBody.packs.map((pack: any) => ({ id: pack.id, name: pack.name, include: pack.include ?? [] }));
      } else if (packsRes && packsRes.status !== 404) {
        throw new Error(packsBody?.error ?? `packs HTTP ${packsRes.status}`);
      } else if (!packsRes) {
        throw new Error('packs_network_error');
      }
      // Shape check only. Per-target health is derived at RENDER time instead
      // (see botStatusOf): validating here would be bypassed the moment a new
      // target is checked after the catalog is already cached, since
      // loadCatalog() returns early — and that bot would get an editable
      // picker built on a policy we never read.
      if (!Array.isArray(botsBody.bots)) throw new Error('bots_malformed_response');
      const botRows: BotRow[] = botsBody.bots;
      if (!mountedRef.current) return;
      const next: LoadoutCatalog = {
        skills: Array.isArray(skillsBody.skills) ? skillsBody.skills : [],
        packs,
        bots: botRows,
      };
      catalogRef.current = next;
      setCatalog(next);
    } catch (err: any) {
      // A failed RETRY deliberately keeps the previous catalog: dropping it
      // would blank out rows that are perfectly healthy just because the
      // refresh happened to fail. The error card is shown either way.
      if (mountedRef.current) setLoadError(err?.message ?? String(err));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.targets.length > 0) void loadCatalog();
  }, [loadCatalog, props.targets.length]);

  const installedNames = useMemo(
    () => new Set((catalog?.skills ?? []).map(skill => skill.name)),
    [catalog],
  );

  /** Per-row health, derived from whatever catalog we currently hold. A 200
   *  from /api/bots does not mean a given bot is usable: the aggregator returns
   *  one row per bot, and an unreachable daemon yields `{ larkAppId, error }`
   *  with no `skills` — indistinguishable from "this bot has no policy" unless
   *  checked. Deriving it here (rather than at fetch time) means a target
   *  checked AFTER the catalog was cached is validated too. */
  const botStatusOf = useCallback((larkAppId: string): { ok: true; row: BotRow } | { ok: false; reason: string } => {
    if (!catalog) return { ok: false, reason: 'catalog_unavailable' };
    const row = catalog.bots.find(bot => bot.larkAppId === larkAppId);
    if (!row) return { ok: false, reason: `bot_missing:${larkAppId}` };
    if (row.error) return { ok: false, reason: `bot_unavailable:${larkAppId}:${row.error}` };
    return { ok: true, row };
  }, [catalog]);

  /** Actually refetches. `force` is what makes it bypass the cached-catalog
   *  short-circuit — the whole point of the button. */
  const reloadCatalog = useCallback(() => { void loadCatalog({ force: true }); }, [loadCatalog]);

  // The bot policy arrives as plain JSON from /api/bots, so it is read through
  // the loose shape and its selectors are filtered where they are used.
  const botPolicyOf = useCallback(
    (larkAppId: string): { include?: readonly string[] } | undefined =>
      catalog?.bots.find(bot => bot.larkAppId === larkAppId)?.skills ?? undefined,
    [catalog],
  );

  /** Skills a loadout names that are not installed — surfaced so the user can
   *  see, and remove, an entry that would resolve to nothing at spawn time. */
  const unavailableOf = useCallback((policy: { include?: readonly string[] } | undefined): Set<string> => {
    const { skills } = selectionFromPolicy(policy);
    return new Set([...skills].filter(name => !installedNames.has(name)));
  }, [installedNames]);

  const toggleRow = async (larkAppId: string) => {
    const next = expanded === larkAppId ? null : larkAppId;
    setExpanded(next);
    if (next) {
      setEverOpened(prev => prev.has(next) ? prev : new Set(prev).add(next));
      await loadCatalog();
    }
  };

  const setDraft = (larkAppId: string, policy: BotSkillPolicy) => {
    // Structural guard, independent of what the UI happens to render: without a
    // readable default we cannot tell a real customisation from an accidental
    // overwrite, so refuse to record one at all.
    if (!botStatusOf(larkAppId).ok) return;
    const next = { ...props.drafts };
    // Editing back to exactly the bot's own policy is the same intent as
    // pressing "restore default": drop the key so the request omits the field
    // and the daemon inherits. Keeping an equivalent draft would submit a
    // session override while the summary reads "inherit default" — the UI and
    // the wire would disagree.
    if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
    else delete next[larkAppId];
    props.onChange(next);
  };

  const restoreDefault = (larkAppId: string) => {
    // Delete the key rather than storing the bot policy: absent is what makes
    // the request omit the field, which is what makes the daemon inherit.
    const next = { ...props.drafts };
    delete next[larkAppId];
    props.onChange(next);
  };

  /** Both failure modes — the catalog never loaded, and this particular bot is
   *  unusable — are dead ends the user can only leave by retrying, so both get
   *  the same card. An error with no way out reads like a permanent verdict. */
  const errorCard = (message: string, marker: Record<string, string>) => (
    <div className="session-loadout-blocked" {...marker}>
      <p className="hint-warn">{message}</p>
      <button
        type="button"
        data-action="retry-loadout-catalog"
        disabled={props.disabled || loading}
        onClick={reloadCatalog}
      >{tr('skills.refresh')}</button>
    </div>
  );

  if (props.targets.length === 0) return null;

  return (
    <div className="session-loadout" data-session-loadout>
      <div className="session-loadout-head">
        <strong>{tr('sessions.create.loadoutTitle')}</strong>
        <small>{tr('sessions.create.loadoutHint')}</small>
      </div>

      {props.targets.map(target => {
        const draft = props.drafts[target.larkAppId];
        const botPolicy = botPolicyOf(target.larkAppId);
        const customised = isLoadoutCustomised(draft, botPolicy);
        const isOpen = expanded === target.larkAppId;
        const panelId = `session-loadout-panel-${target.larkAppId}`;
        // Draft wins; otherwise show what the bot would use anyway. Both are
        // read through the loose shape, since only the draft is our own type.
        const effective: { include?: readonly string[] } | undefined = draft ?? botPolicy;
        const selection = selectionFromPolicy(effective);
        const status = botStatusOf(target.larkAppId);
        const bot = status.ok ? status.row : undefined;
        const summaryItems = catalog ? [
          ...[...selection.packs].map(id => {
            const pack = catalog.packs.find(candidate => candidate.id === id);
            return { type: 'pack' as const, id, label: pack?.name ?? id, missing: !pack };
          }),
          ...[...selection.skills].map(name => ({
            type: 'skill' as const,
            id: name,
            label: name,
            missing: !installedNames.has(name),
          })),
        ] : [];
        const summaryMode = !catalog
          ? (loadError ? 'unavailable' : 'loading')
          : !status.ok
            ? 'unavailable'
            : summaryItems.length === 0 ? 'empty' : 'ready';
        const finalSkillCount = catalog
          ? resolveLoadoutPreview(selection.skills, selection.packs, catalog.packs).length
          : 0;
        // `skillInjectionSupport` only says the CLI *can* share a global skills
        // dir; whether it actually does is the resolved mode (per-bot override
        // falling back to the machine default). Warning on capability alone
        // would cry wolf for every bot on such a CLI running in prompt mode.
        const effectiveInjection = bot?.skillInjection ?? bot?.skillInjectionDefault;
        // Both must hold: the CLI has to actually share a global skills dir,
        // AND the resolved mode has to be `global`. Checking the mode alone
        // would false-positive on a dynamic CLI carrying a stale/legacy value.
        const globalInjection = bot?.skillInjectionSupport === 'global' && effectiveInjection === 'global';

        return (
          <div
            key={target.larkAppId}
            className={`session-loadout-row${isOpen ? ' is-open' : ''}${customised ? ' is-customised' : ''}`}
            data-loadout-row={target.larkAppId}
          >
            <button
              type="button"
              className="session-loadout-summary"
              data-action="toggle-loadout"
              aria-expanded={isOpen}
              aria-controls={panelId}
              disabled={props.disabled}
              onClick={() => { void toggleRow(target.larkAppId); }}
            >
              <span className="session-loadout-bot">
                <strong>{target.botName}</strong>
                <small data-loadout-state={customised ? 'custom' : 'inherit'}>
                  {customised
                    ? tr('sessions.create.loadoutCustomLabel')
                    : tr('sessions.create.loadoutDefaultLabel')}
                </small>
              </span>
              <span className="session-loadout-default-summary" data-loadout-default={summaryMode}>
                {summaryMode === 'loading' && <em>{tr('sessions.create.loadoutDefaultLoading')}</em>}
                {summaryMode === 'unavailable' && <em>{tr('sessions.create.loadoutDefaultUnavailable')}</em>}
                {summaryMode === 'empty' && <em>{tr('sessions.create.loadoutDefaultEmpty')}</em>}
                {summaryMode === 'ready' && (
                  <>
                    <span className="session-loadout-default-items">
                      {summaryItems.slice(0, 3).map(item => (
                        <span
                          key={`${item.type}:${item.id}`}
                          className={`session-loadout-default-chip${item.missing ? ' is-missing' : ''}`}
                          data-loadout-default-selector={`${item.type}:${item.id}`}
                          title={item.label}
                        >
                          <b aria-hidden="true">{item.type === 'pack' ? 'P' : 'S'}</b>
                          {item.label}
                        </span>
                      ))}
                      {summaryItems.length > 3 && (
                        <span className="session-loadout-default-more">
                          {tr('sessions.create.loadoutMore', { count: summaryItems.length - 3 })}
                        </span>
                      )}
                    </span>
                    <span className="session-loadout-final-count" data-loadout-final-count={finalSkillCount}>
                      {tr('sessions.create.loadoutFinalCount', { count: finalSkillCount })}
                    </span>
                  </>
                )}
              </span>
              <span className="session-loadout-chevron" aria-hidden="true">›</span>
            </button>

            {/* grid-template-rows 0fr→1fr expands without measuring height.
                The DOM stays mounted so collapsing can animate, so a closed
                panel must be removed from the a11y tree and the tab order
                explicitly — 0fr + overflow:hidden only hides it visually, and
                its checkboxes would still be reachable with Tab. */}
            <div
              className="session-loadout-panel"
              id={panelId}
              role="region"
              aria-label={target.botName}
              data-loadout-panel={isOpen ? 'open' : 'closed'}
              aria-hidden={!isOpen || undefined}
              inert={!isOpen || undefined}
            >
              <div className="session-loadout-panel-inner">
                {everOpened.has(target.larkAppId) && (
                  loading ? <small className="muted">{tr('common.loading')}</small>
                    : loadError ? errorCard(loadError, { 'data-loadout-load-error': target.larkAppId })
                      : !catalog ? null
                      : !status.ok ? errorCard(
                        tr('sessions.create.loadoutBotUnavailable', { reason: status.reason }),
                        { 'data-loadout-blocked': target.larkAppId },
                      ) : (
                        <>
                          {globalInjection && (
                            <p className="hint-warn session-loadout-degraded" data-loadout-degraded>
                              {tr('sessions.create.loadoutGlobalInjection')}
                            </p>
                          )}
                          <SkillLoadoutPicker
                            skills={catalog.skills}
                            packs={catalog.packs}
                            selectedSkills={selection.skills}
                            selectedPacks={selection.packs}
                            unavailableSkills={unavailableOf(effective)}
                            disabled={props.disabled}
                            idPrefix={`session-${target.larkAppId}`}
                            onToggleSkill={name => {
                              const next = new Set(selection.skills);
                              if (next.has(name)) next.delete(name); else next.add(name);
                              setDraft(target.larkAppId, policyFromSelection(next, selection.packs));
                            }}
                            onTogglePack={id => {
                              const next = new Set(selection.packs);
                              if (next.has(id)) next.delete(id); else next.add(id);
                              setDraft(target.larkAppId, policyFromSelection(selection.skills, next));
                            }}
                          />
                          <div className="session-loadout-actions">
                            <button
                              type="button"
                              data-action="restore-loadout-default"
                              disabled={props.disabled || !draft}
                              onClick={() => restoreDefault(target.larkAppId)}
                            >{tr('sessions.create.loadoutRestore')}</button>
                          </div>
                        </>
                      )
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

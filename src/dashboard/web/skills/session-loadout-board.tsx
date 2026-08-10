import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import {
  isLoadoutCustomised,
  policyFromSelection,
  selectionFromPolicy,
  type LoadoutDrafts,
} from '../create-session-loadout.js';
import { useT } from '../react-hooks.js';
import { resolveLoadoutPreview } from './skill-loadout-picker.js';
import type { BotRow, SkillPackRow } from './types.js';
import { useSkillsData } from './use-skills-data.js';

type CatalogTab = 'packs' | 'skills';
type DragItem = { kind: 'pack' | 'skill'; id: string };

interface BotStatusOk {
  ok: true;
  row: BotRow;
}

interface BotStatusError {
  ok: false;
  reason: string;
}

type BotStatus = BotStatusOk | BotStatusError;

/**
 * Session-level Skill equipment board.
 *
 * The interaction follows one physical direction: choose an item from the
 * armory at the top, then drop it onto one Bot slot below. Bot cards always
 * expose their current direct selectors (Packs + individual Skills), so the
 * user can understand and undo a session override without opening another
 * editor. Selecting Bot cards is optional and only powers the touch/keyboard
 * batch fallback.
 */
export function SessionLoadoutBoard(props: {
  targets: Array<{ larkAppId: string; botName: string }>;
  drafts: LoadoutDrafts;
  onChange: (drafts: LoadoutDrafts) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const {
    skills,
    bots,
    packs,
    loading,
    loadError,
    packsError,
    packsKnown,
    refresh,
  } = useSkillsData({ apiUnavailableText: tr('skills.apiUnavailable') });
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('packs');
  const [selectedBots, setSelectedBots] = useState<Set<string>>(() => new Set());
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const tabRefs = useRef<Record<CatalogTab, HTMLButtonElement | null>>({ packs: null, skills: null });

  useEffect(() => {
    setSelectedBots(previous => {
      const currentIds = new Set(props.targets.map(target => target.larkAppId));
      const next = new Set([...previous].filter(id => currentIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [props.targets]);

  const firstPackLoadFailed = !packsKnown && Boolean(packsError);
  const catalogBlocked = Boolean(loadError) || firstPackLoadFailed;

  const botStatusOf = useCallback((larkAppId: string): BotStatus => {
    if (catalogBlocked) return { ok: false, reason: loadError ?? packsError ?? 'catalog_unavailable' };
    const row = bots.find(bot => bot.larkAppId === larkAppId);
    if (!row) return { ok: false, reason: `bot_missing:${larkAppId}` };
    if (row.error) return { ok: false, reason: `bot_unavailable:${larkAppId}:${row.error}` };
    return { ok: true, row };
  }, [bots, catalogBlocked, loadError, packsError]);

  const botPolicyOf = useCallback(
    (larkAppId: string) => bots.find(bot => bot.larkAppId === larkAppId)?.skills ?? undefined,
    [bots],
  );

  const commitSelection = useCallback((
    larkAppId: string,
    directSkills: ReadonlySet<string>,
    packIds: ReadonlySet<string>,
  ): boolean => {
    if (!botStatusOf(larkAppId).ok) return false;
    const nextPolicy = policyFromSelection(directSkills, packIds);
    const defaultPolicy = botPolicyOf(larkAppId);
    const currentPolicy = props.drafts[larkAppId];
    const next = { ...props.drafts };
    if (isLoadoutCustomised(nextPolicy, defaultPolicy)) next[larkAppId] = nextPolicy;
    else delete next[larkAppId];
    const before = JSON.stringify(currentPolicy);
    const after = JSON.stringify(next[larkAppId]);
    if (before === after) return false;
    props.onChange(next);
    return true;
  }, [botPolicyOf, botStatusOf, props.drafts, props.onChange]);

  const addItemToBot = useCallback((larkAppId: string, item: DragItem): boolean => {
    const status = botStatusOf(larkAppId);
    if (!status.ok) return false;
    const current = selectionFromPolicy(props.drafts[larkAppId] ?? botPolicyOf(larkAppId));
    if (item.kind === 'pack') {
      if (current.packs.has(item.id)) return false;
      const nextPacks = new Set(current.packs);
      nextPacks.add(item.id);
      return commitSelection(larkAppId, current.skills, nextPacks);
    }
    const effective = resolveLoadoutPreview(current.skills, current.packs, packs);
    if (effective.some(skill => skill.name === item.id)) return false;
    const nextSkills = new Set(current.skills);
    nextSkills.add(item.id);
    return commitSelection(larkAppId, nextSkills, current.packs);
  }, [botPolicyOf, botStatusOf, commitSelection, packs, props.drafts]);

  const removeItemFromBot = useCallback((larkAppId: string, item: DragItem) => {
    const status = botStatusOf(larkAppId);
    if (!status.ok) return;
    const current = selectionFromPolicy(props.drafts[larkAppId] ?? botPolicyOf(larkAppId));
    if (item.kind === 'pack') {
      if (!current.packs.has(item.id)) return;
      const nextPacks = new Set(current.packs);
      nextPacks.delete(item.id);
      commitSelection(larkAppId, current.skills, nextPacks);
      return;
    }
    if (!current.skills.has(item.id)) return;
    const nextSkills = new Set(current.skills);
    nextSkills.delete(item.id);
    commitSelection(larkAppId, nextSkills, current.packs);
  }, [botPolicyOf, botStatusOf, commitSelection, props.drafts]);

  const restoreBotDefault = useCallback((larkAppId: string) => {
    if (!(larkAppId in props.drafts)) return;
    const next = { ...props.drafts };
    delete next[larkAppId];
    props.onChange(next);
  }, [props.drafts, props.onChange]);

  const editableSelected = useMemo(
    () => props.targets
      .filter(target => selectedBots.has(target.larkAppId))
      .filter(target => botStatusOf(target.larkAppId).ok)
      .map(target => target.larkAppId),
    [botStatusOf, props.targets, selectedBots],
  );

  const applyItemToSelected = useCallback((item: DragItem) => {
    let next = props.drafts;
    let changed = false;
    for (const larkAppId of editableSelected) {
      const current = selectionFromPolicy(next[larkAppId] ?? botPolicyOf(larkAppId));
      if (item.kind === 'pack') {
        if (current.packs.has(item.id)) continue;
        const nextPacks = new Set(current.packs);
        nextPacks.add(item.id);
        const policy = policyFromSelection(current.skills, nextPacks);
        if (next === props.drafts) next = { ...props.drafts };
        if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
        else delete next[larkAppId];
        changed = true;
        continue;
      }
      const effective = resolveLoadoutPreview(current.skills, current.packs, packs);
      if (effective.some(skill => skill.name === item.id)) continue;
      const nextSkills = new Set(current.skills);
      nextSkills.add(item.id);
      const policy = policyFromSelection(nextSkills, current.packs);
      if (next === props.drafts) next = { ...props.drafts };
      if (isLoadoutCustomised(policy, botPolicyOf(larkAppId))) next[larkAppId] = policy;
      else delete next[larkAppId];
      changed = true;
    }
    if (changed) props.onChange(next);
  }, [botPolicyOf, editableSelected, packs, props.drafts, props.onChange]);

  const restoreSelectedDefaults = useCallback(() => {
    const next = { ...props.drafts };
    let changed = false;
    for (const larkAppId of editableSelected) {
      if (larkAppId in next) {
        delete next[larkAppId];
        changed = true;
      }
    }
    if (changed) props.onChange(next);
  }, [editableSelected, props.drafts, props.onChange]);

  const startDrag = useCallback((event: DragEvent<HTMLElement>, item: DragItem) => {
    setDragItem(item);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
  }, []);

  const clearDrag = useCallback(() => {
    setDragItem(null);
    setRejectTarget(null);
  }, []);

  const onBotDragOver = useCallback((event: DragEvent<HTMLElement>, larkAppId: string, editable: boolean) => {
    if (!dragItem) return;
    if (!editable) {
      event.dataTransfer.dropEffect = 'none';
      setRejectTarget(larkAppId);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, [dragItem]);

  const onBotDrop = useCallback((event: DragEvent<HTMLElement>, larkAppId: string, editable: boolean) => {
    if (!dragItem) return;
    if (!editable) {
      clearDrag();
      return;
    }
    event.preventDefault();
    addItemToBot(larkAppId, dragItem);
    clearDrag();
  }, [addItemToBot, clearDrag, dragItem]);

  const switchCatalogByKey = useCallback((event: KeyboardEvent<HTMLButtonElement>, tab: CatalogTab) => {
    const order: CatalogTab[] = ['packs', 'skills'];
    const index = order.indexOf(tab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % order.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + order.length) % order.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = order.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = order[nextIndex];
    setCatalogTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }, []);

  if (props.targets.length === 0) return null;

  if (loading && bots.length === 0) {
    return <small className="muted" data-loadout-loading>{tr('common.loading')}</small>;
  }

  if (catalogBlocked) {
    return (
      <div className="session-loadout-blocked" data-loadout-blocked>
        <p className="hint-warn">{loadError ?? packsError}</p>
        <button type="button" data-action="retry-loadout-catalog" disabled={props.disabled || loading} onClick={() => void refresh()}>
          {tr('skills.refresh')}
        </button>
      </div>
    );
  }

  return (
    <div className="session-loadout session-loadout-board" data-session-loadout>
      <header className="session-loadout-head">
        <strong>{tr('sessions.create.loadoutTitle')}</strong>
        <small>{tr('sessions.create.loadoutHint')}</small>
      </header>

      {packsKnown && packsError && (
        <p className="hint-warn loadout-stale-warning">{packsError}</p>
      )}

      <section className="loadout-armory" aria-labelledby="loadout-armory-title">
        <header className="loadout-armory-head">
          <span>
            <strong id="loadout-armory-title">{tr('sessions.create.loadoutArmory')}</strong>
            <small>{tr('sessions.create.loadoutArmoryHint')}</small>
          </span>
          <span className="loadout-selected-count" data-selected-count={editableSelected.length}>
            {tr('sessions.create.loadoutSelectedCount', { count: editableSelected.length, total: props.targets.length })}
          </span>
        </header>

        <div className="loadout-catalog-tabs" role="tablist" aria-label={tr('sessions.create.loadoutCatalogTabs')}>
          {(['packs', 'skills'] as const).map(tab => {
            const active = catalogTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`loadout-catalog-tab-${tab}`}
                aria-selected={active}
                aria-controls={`loadout-catalog-panel-${tab}`}
                tabIndex={active ? 0 : -1}
                className={`loadout-catalog-tab${active ? ' is-active' : ''}`}
                data-catalog-tab={tab}
                ref={element => { tabRefs.current[tab] = element; }}
                onClick={() => setCatalogTab(tab)}
                onKeyDown={event => switchCatalogByKey(event, tab)}
              >
                <span aria-hidden="true">{tab === 'packs' ? '▦' : '◇'}</span>
                {tab === 'packs' ? tr('sessions.create.loadoutBuilds') : tr('sessions.create.loadoutSkillCatalog')}
                <em>{tab === 'packs' ? packs.length : skills.length}</em>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id="loadout-catalog-panel-packs"
          aria-labelledby="loadout-catalog-tab-packs"
          className="loadout-catalog-panel"
          data-catalog-panel="packs"
          hidden={catalogTab !== 'packs'}
        >
          <div className="loadout-build-grid">
            {packs.map(pack => (
              <CatalogPackCard
                key={pack.id}
                pack={pack}
                appliedCount={countPackAssignments(pack.id, props.targets, props.drafts, botPolicyOf)}
                selectedCount={editableSelected.length}
                disabled={props.disabled}
                tr={tr}
                onDragStart={event => startDrag(event, { kind: 'pack', id: pack.id })}
                onDragEnd={clearDrag}
                onApply={() => applyItemToSelected({ kind: 'pack', id: pack.id })}
              />
            ))}
            {packs.length === 0 && <small className="muted">{tr('skills.packsEmpty')}</small>}
          </div>
        </div>

        <div
          role="tabpanel"
          id="loadout-catalog-panel-skills"
          aria-labelledby="loadout-catalog-tab-skills"
          className="loadout-catalog-panel"
          data-catalog-panel="skills"
          hidden={catalogTab !== 'skills'}
        >
          <div className="loadout-skill-catalog-list" data-loadout-skill-catalog>
            {skills.map(skill => (
              <div
                key={skill.name}
                className="loadout-skill-card"
                data-loadout-skill={skill.name}
                draggable={!props.disabled}
                onDragStart={event => startDrag(event, { kind: 'skill', id: skill.name })}
                onDragEnd={clearDrag}
              >
                <span className="loadout-drag-grip" aria-hidden="true">⠿</span>
                <span className="loadout-skill-card-name">
                  <strong>{skill.displayName || skill.name}</strong>
                  {skill.description && <small>{skill.description}</small>}
                </span>
                <button
                  type="button"
                  className="bd-button small loadout-skill-apply"
                  data-action="apply-skill"
                  data-skill-name={skill.name}
                  disabled={props.disabled || editableSelected.length === 0}
                  aria-describedby={editableSelected.length === 0 ? 'loadout-batch-hint' : undefined}
                  onClick={() => applyItemToSelected({ kind: 'skill', id: skill.name })}
                >
                  {tr('sessions.create.loadoutEquipSelected')}
                </button>
              </div>
            ))}
            {skills.length === 0 && <small className="muted">{tr('skills.emptyTitle')}</small>}
          </div>
        </div>
      </section>

      <section className="loadout-bot-deck" aria-labelledby="loadout-bot-deck-title">
        <header className="loadout-bot-deck-head">
          <span>
            <strong id="loadout-bot-deck-title">{tr('sessions.create.loadoutBotSlots')}</strong>
            <small>{tr('sessions.create.loadoutBotSlotsHint')}</small>
          </span>
          <span className="loadout-bot-deck-actions">
            <small id="loadout-batch-hint">{tr('sessions.create.loadoutBatchHint')}</small>
            <button type="button" className="bd-button small" disabled={props.disabled} onClick={() => {
              const editable = props.targets.filter(target => botStatusOf(target.larkAppId).ok).map(target => target.larkAppId);
              setSelectedBots(new Set(editable));
            }}>
              {tr('sessions.create.loadoutSelectAll')}
            </button>
            <button type="button" className="bd-button small" disabled={props.disabled || selectedBots.size === 0} onClick={() => setSelectedBots(new Set())}>
              {tr('sessions.create.loadoutClear')}
            </button>
            <button type="button" className="bd-button small" data-action="restore-selected-defaults" disabled={props.disabled || editableSelected.length === 0} onClick={restoreSelectedDefaults}>
              {tr('sessions.create.loadoutRestoreSelected', { count: editableSelected.length })}
            </button>
          </span>
        </header>

        <div className="loadout-bot-grid" data-loadout-lineup>
          {props.targets.map(target => {
            const status = botStatusOf(target.larkAppId);
            const botPolicy = botPolicyOf(target.larkAppId);
            const draft = props.drafts[target.larkAppId];
            const customised = isLoadoutCustomised(draft, botPolicy);
            const inherited = selectionFromPolicy(botPolicy);
            const current = selectionFromPolicy(draft ?? botPolicy);
            const inheritedFinal = resolveLoadoutPreview(inherited.skills, inherited.packs, packs);
            const currentFinal = resolveLoadoutPreview(current.skills, current.packs, packs);
            const inheritedNames = new Set(inheritedFinal.map(skill => skill.name));
            const currentNames = new Set(currentFinal.map(skill => skill.name));
            const added = [...currentNames].filter(name => !inheritedNames.has(name));
            const removed = [...inheritedNames].filter(name => !currentNames.has(name));
            const emptyDefault = status.ok && !customised && inherited.packs.size === 0 && inherited.skills.size === 0;
            const selected = selectedBots.has(target.larkAppId);
            const editable = status.ok && !props.disabled;
            const rejected = rejectTarget === target.larkAppId;
            const state = !status.ok ? 'unavailable' : customised ? 'custom' : emptyDefault ? 'empty' : 'inherit';
            const stateLabel = !status.ok
              ? tr('sessions.create.loadoutDefaultUnavailable')
              : customised
                ? tr('sessions.create.loadoutCustomLabel')
                : emptyDefault
                  ? tr('sessions.create.loadoutDefaultEmpty')
                  : tr('sessions.create.loadoutDefaultLabel');

            return (
              <article
                key={target.larkAppId}
                className={`loadout-bot-slot${dragItem && editable ? ' is-drop-target' : ''}${rejected ? ' is-drop-rejected' : ''}${customised ? ' is-customised' : ''}`}
                data-loadout-bot-slot={target.larkAppId}
                data-drop-disabled={!editable ? 'true' : undefined}
                data-drop-rejected={rejected ? 'true' : undefined}
                onDragOver={event => onBotDragOver(event, target.larkAppId, editable)}
                onDragLeave={() => setRejectTarget(previous => previous === target.larkAppId ? null : previous)}
                onDrop={event => onBotDrop(event, target.larkAppId, editable)}
              >
                <button
                  type="button"
                  className={`loadout-bot-card${selected ? ' is-selected' : ''}${customised ? ' is-customised' : ''}${!status.ok ? ' is-unavailable' : ''}`}
                  data-loadout-bot={target.larkAppId}
                  data-loadout-bot-editable={status.ok ? 'true' : 'false'}
                  aria-pressed={selected}
                  disabled={!editable}
                  title={status.ok ? target.botName : tr('sessions.create.loadoutBotUnavailable', { reason: status.reason })}
                  onClick={() => setSelectedBots(previous => {
                    const next = new Set(previous);
                    if (next.has(target.larkAppId)) next.delete(target.larkAppId);
                    else next.add(target.larkAppId);
                    return next;
                  })}
                >
                  <span className="loadout-bot-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                  <span className="loadout-bot-name"><strong>{target.botName}</strong></span>
                  <span className="loadout-bot-meta">
                    <small data-loadout-state={state}>{stateLabel}</small>
                    {status.ok && (
                      <span className="loadout-bot-default" data-loadout-default-summary>
                        <span className="loadout-bot-default-text">
                          {tr('sessions.create.loadoutDefaultSummary', {
                            packs: inherited.packs.size,
                            skills: inherited.skills.size,
                            final: inheritedFinal.length,
                          })}
                        </span>
                      </span>
                    )}
                    {status.ok && (
                      <span className="loadout-bot-current" data-loadout-final-count={currentFinal.length}>
                        {tr('sessions.create.loadoutCurrentFinal', { count: currentFinal.length })}
                      </span>
                    )}
                  </span>
                </button>

                {status.ok && (
                  <div className="loadout-equipped" data-loadout-equipped={target.larkAppId}>
                    {status.row.skillInjectionSupport === 'global'
                      && (status.row.skillInjection ?? status.row.skillInjectionDefault) === 'global' && (
                      <p className="hint-warn loadout-slot-degraded" data-loadout-degraded>
                        {tr('sessions.create.loadoutGlobalInjection')}
                      </p>
                    )}
                    <header className="loadout-equipped-head">
                      <strong>{tr('sessions.create.loadoutEquipped')}</strong>
                      {customised && (
                        <button type="button" className="loadout-restore-one" data-action="restore-bot-default" disabled={props.disabled} onClick={() => restoreBotDefault(target.larkAppId)}>
                          {tr('sessions.create.loadoutRestore')}
                        </button>
                      )}
                    </header>
                    <div className="loadout-equipped-list">
                      {[...current.packs].map(packId => {
                        const pack = packs.find(option => option.id === packId);
                        return (
                          <button
                            key={`pack:${packId}`}
                            type="button"
                            className={`loadout-equipped-chip is-pack${inherited.packs.has(packId) ? ' is-inherited' : ' is-session'}`}
                            data-equipped-pack={packId}
                            disabled={props.disabled}
                            aria-label={tr('sessions.create.loadoutRemovePack', { name: pack?.name ?? packId, bot: target.botName })}
                            onClick={() => removeItemFromBot(target.larkAppId, { kind: 'pack', id: packId })}
                          >
                            <span aria-hidden="true">▦</span>{pack?.name ?? packId}<em aria-hidden="true">×</em>
                          </button>
                        );
                      })}
                      {[...current.skills].map(skillName => (
                        <button
                          key={`skill:${skillName}`}
                          type="button"
                          className={`loadout-equipped-chip is-skill${inherited.skills.has(skillName) ? ' is-inherited' : ' is-session'}`}
                          data-equipped-skill={skillName}
                          disabled={props.disabled}
                          aria-label={tr('sessions.create.loadoutRemoveSkill', { name: skillName, bot: target.botName })}
                          onClick={() => removeItemFromBot(target.larkAppId, { kind: 'skill', id: skillName })}
                        >
                          <span aria-hidden="true">◇</span>{skillName}<em aria-hidden="true">×</em>
                        </button>
                      ))}
                      {current.packs.size === 0 && current.skills.size === 0 && (
                        <small className="loadout-equipped-empty">{tr('sessions.create.loadoutEquippedEmpty')}</small>
                      )}
                    </div>
                    <footer className="loadout-bot-diff" data-preview-bot={target.larkAppId}>
                      {added.length > 0 && <span className="is-add">+{added.join(', ')}</span>}
                      {removed.length > 0 && <span className="is-remove">−{removed.join(', ')}</span>}
                      {added.length === 0 && removed.length === 0 && <span className="is-same">{tr('sessions.create.loadoutPreviewSame')}</span>}
                    </footer>
                  </div>
                )}
                {!status.ok && (
                  <div className="loadout-slot-error" data-loadout-slot-error={target.larkAppId}>
                    <p>{tr('sessions.create.loadoutBotUnavailable', { reason: status.reason })}</p>
                    <button type="button" className="bd-button small" disabled={props.disabled || loading} onClick={() => void refresh()}>
                      {tr('skills.refresh')}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function CatalogPackCard(props: {
  pack: SkillPackRow;
  appliedCount: number;
  selectedCount: number;
  disabled?: boolean;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onApply: () => void;
}) {
  return (
    <div
      className="loadout-build-card"
      data-loadout-pack={props.pack.id}
      draggable={!props.disabled}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
    >
      <header className="loadout-build-card-head">
        <span className="loadout-drag-grip" aria-hidden="true">⠿</span>
        <strong>{props.pack.name}</strong>
        <span className="loadout-build-count">{props.tr('skills.skillCount', { count: props.pack.include.length })}</span>
      </header>
      <div className="loadout-build-card-skills">
        {props.pack.include.slice(0, 5).map(selector => (
          <span key={selector} className="loadout-build-skill">{selector.replace('skill:', '')}</span>
        ))}
        {props.pack.include.length > 5 && <span className="loadout-build-more">+{props.pack.include.length - 5}</span>}
      </div>
      <footer>
        <small data-pack-applied={props.appliedCount}>{props.tr('sessions.create.loadoutAppliedTo', { count: props.appliedCount })}</small>
        <button type="button" className="bd-button small loadout-build-apply" data-action="apply-pack" data-pack-id={props.pack.id} disabled={props.disabled || props.selectedCount === 0} onClick={props.onApply}>
          {props.tr('sessions.create.loadoutEquipSelected')}
        </button>
      </footer>
    </div>
  );
}

function countPackAssignments(
  packId: string,
  targets: Array<{ larkAppId: string }>,
  drafts: LoadoutDrafts,
  botPolicyOf: (larkAppId: string) => { include?: readonly string[] } | null | undefined,
): number {
  return targets.filter(target => {
    const selection = selectionFromPolicy(drafts[target.larkAppId] ?? botPolicyOf(target.larkAppId));
    return selection.packs.has(packId);
  }).length;
}

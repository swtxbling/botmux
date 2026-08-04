import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../react-hooks.js';
import { SkillLoadoutPicker, type LoadoutPackOption } from './skill-loadout-picker.js';
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
 *   • the create-session dialog is a lightweight entry point, so the catalog is
 *     fetched on the FIRST expand rather than on dialog open — a user who never
 *     touches loadouts pays nothing;
 *   • rows stay collapsed and summarised ("inherit (3)"), because inheriting
 *     the bot's own policy is the overwhelmingly common case and must not look
 *     like a decision the user has to make.
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
  const [catalog, setCatalog] = useState<LoadoutCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadCatalog = useCallback(async () => {
    if (catalog || loading) return;
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
      if (!skillsRes.ok) throw new Error(skillsBody?.error ?? `HTTP ${skillsRes.status}`);
      if (!mountedRef.current) return;
      setCatalog({
        skills: Array.isArray(skillsBody.skills) ? skillsBody.skills : [],
        // Older daemons have no pack API; an absent pack list is not an error.
        packs: packsRes?.ok && Array.isArray(packsBody.packs)
          ? packsBody.packs.map((pack: any) => ({ id: pack.id, name: pack.name, include: pack.include ?? [] }))
          : [],
        bots: Array.isArray(botsBody.bots) ? botsBody.bots : [],
      });
    } catch (err: any) {
      if (mountedRef.current) setLoadError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [catalog, loading]);

  const installedNames = useMemo(
    () => new Set((catalog?.skills ?? []).map(skill => skill.name)),
    [catalog],
  );

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
    if (next) await loadCatalog();
  };

  const setDraft = (larkAppId: string, policy: BotSkillPolicy) => {
    props.onChange({ ...props.drafts, [larkAppId]: policy });
  };

  const restoreDefault = (larkAppId: string) => {
    // Delete the key rather than storing the bot policy: absent is what makes
    // the request omit the field, which is what makes the daemon inherit.
    const next = { ...props.drafts };
    delete next[larkAppId];
    props.onChange(next);
  };

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
        // Draft wins; otherwise show what the bot would use anyway. Both are
        // read through the loose shape, since only the draft is our own type.
        const effective: { include?: readonly string[] } | undefined = draft ?? botPolicy;
        const selection = selectionFromPolicy(effective);
        const bot = catalog?.bots.find(row => row.larkAppId === target.larkAppId);
        const globalInjection = bot?.skillInjectionSupport === 'global';

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
              disabled={props.disabled}
              onClick={() => { void toggleRow(target.larkAppId); }}
            >
              <span className="session-loadout-bot">{target.botName}</span>
              <span className="session-loadout-state" data-loadout-state={customised ? 'custom' : 'inherit'}>
                {customised
                  ? tr('sessions.create.loadoutCustom', { count: selection.skills.size + selection.packs.size })
                  : tr('sessions.create.loadoutInherit')}
              </span>
              <span className="session-loadout-chevron" aria-hidden="true">›</span>
            </button>

            {/* grid-template-rows 0fr→1fr expands without measuring height. */}
            <div className="session-loadout-panel" data-loadout-panel={isOpen ? 'open' : 'closed'}>
              <div className="session-loadout-panel-inner">
                {isOpen && (
                  loading ? <small className="muted">{tr('common.loading')}</small>
                    : loadError ? <p className="hint-warn">{loadError}</p>
                      : catalog ? (
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
                      ) : null
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useMemo } from 'react';
import { useT } from '../react-hooks.js';
import type { SkillRow } from './types.js';

export interface LoadoutPackOption {
  id: string;
  name: string;
  include: string[];
}

/** The deduplicated set a selection actually resolves to, with provenance.
 *  Mirrors the backend precedence: a directly selected skill shadows the same
 *  skill pulled in through a pack. */
export interface ResolvedLoadoutEntry {
  name: string;
  source: 'direct' | string;
}

export function resolveLoadoutPreview(
  skillNames: Iterable<string>,
  packIdList: Iterable<string>,
  packs: readonly LoadoutPackOption[],
): ResolvedLoadoutEntry[] {
  const seen = new Map<string, string>();
  for (const name of skillNames) seen.set(name, 'direct');
  for (const id of packIdList) {
    const pack = packs.find(candidate => candidate.id === id);
    if (!pack) continue;
    for (const selector of pack.include) {
      if (!selector.startsWith('skill:')) continue;
      const name = selector.slice('skill:'.length);
      if (!seen.has(name)) seen.set(name, `pack:${pack.name}`);
    }
  }
  return [...seen.entries()].map(([name, source]) => ({ name, source }));
}

/** One controlled skill/pack selector, shared by the Bot assignment editor and
 *  the per-session loadout picker so the two never drift into different pick
 *  affordances. Deliberately controlled (no internal draft state): both callers
 *  own their own draft, and the session loadout in particular must submit a
 *  complete final set — the backend treats a loadout as a wholesale REPLACEMENT
 *  of the bot policy, so any "extend/merge" done here would contradict it. */
export function SkillLoadoutPicker(props: {
  skills: SkillRow[];
  packs: LoadoutPackOption[];
  selectedSkills: ReadonlySet<string>;
  selectedPacks: ReadonlySet<string>;
  onToggleSkill: (name: string) => void;
  onTogglePack: (id: string) => void;
  /** Marks skills the target bot cannot actually load (not installed). */
  unavailableSkills?: ReadonlySet<string>;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const tr = useT();
  const resolved = useMemo(
    () => resolveLoadoutPreview(props.selectedSkills, props.selectedPacks, props.packs),
    [props.selectedSkills, props.selectedPacks, props.packs],
  );
  const prefix = props.idPrefix ?? 'loadout';

  // A saved loadout can name things that no longer exist (skill uninstalled,
  // pack deleted). They must still get a checkbox, otherwise the selection is
  // visible but un-removable and the user can never clean it up.
  const orphanPacks = useMemo(
    () => [...props.selectedPacks].filter(id => !props.packs.some(pack => pack.id === id)),
    [props.selectedPacks, props.packs],
  );
  const orphanSkills = useMemo(
    () => [...props.selectedSkills].filter(name => !props.skills.some(skill => skill.name === name)),
    [props.selectedSkills, props.skills],
  );

  return (
    <div className="skills-loadout-picker" data-loadout-picker={prefix}>
      <div className="skills-control-block">
        <label>{tr('skills.packChips')}</label>
        <div className="skills-pack-skill-list">
          {props.packs.map(pack => (
            <label key={pack.id} className="skills-pack-skill-item">
              <input
                type="checkbox"
                data-loadout-pack={pack.id}
                checked={props.selectedPacks.has(pack.id)}
                disabled={props.disabled}
                onChange={() => props.onTogglePack(pack.id)}
              />
              <span>{pack.name}</span>
              <small>{tr('skills.skillCount', { count: pack.include.length })}</small>
            </label>
          ))}
          {orphanPacks.map(id => (
            <label key={id} className="skills-pack-skill-item skills-loadout-orphan">
              <input
                type="checkbox"
                data-loadout-pack={id}
                data-loadout-orphan="pack"
                checked
                disabled={props.disabled}
                onChange={() => props.onTogglePack(id)}
              />
              <span>{id}</span>
              <small className="skills-loadout-orphan-tag">{tr('skills.healthPackMissing')}</small>
            </label>
          ))}
          {props.packs.length === 0 && orphanPacks.length === 0 && (
            <small className="muted">{tr('skills.packsEmpty')}</small>
          )}
        </div>
      </div>

      <div className="skills-control-block">
        <label>{tr('skills.individualSkills')}</label>
        <div className="skills-pack-skill-list">
          {props.skills.map(skill => (
            <label key={skill.name} className="skills-pack-skill-item">
              <input
                type="checkbox"
                data-loadout-skill={skill.name}
                checked={props.selectedSkills.has(skill.name)}
                disabled={props.disabled}
                onChange={() => props.onToggleSkill(skill.name)}
              />
              <span>{skill.name}</span>
              {skill.description && <small className="skills-pack-skill-desc">{skill.description}</small>}
            </label>
          ))}
          {orphanSkills.map(name => (
            <label key={name} className="skills-pack-skill-item skills-loadout-orphan">
              <input
                type="checkbox"
                data-loadout-skill={name}
                data-loadout-orphan="skill"
                checked
                disabled={props.disabled}
                onChange={() => props.onToggleSkill(name)}
              />
              <span>{name}</span>
              <small className="skills-loadout-orphan-tag">{tr('skills.dangling')}</small>
            </label>
          ))}
          {props.skills.length === 0 && orphanSkills.length === 0 && (
            <small className="muted">{tr('skills.emptyTitle')}</small>
          )}
        </div>
      </div>

      <div className="skills-control-block">
        <label>{tr('skills.resolvedPreview')} ({resolved.length})</label>
        <div className="skills-resolved-preview" data-loadout-resolved>
          {resolved.length === 0
            ? <small className="muted">{tr('skills.loadoutEmpty')}</small>
            : resolved.map(({ name, source }) => (
              <div
                key={name}
                className={`skills-resolved-item${props.unavailableSkills?.has(name) ? ' skills-resolved-missing' : ''}`}
                data-resolved-skill={name}
              >
                <span>{name}</span>
                <small className="muted">
                  {props.unavailableSkills?.has(name) ? tr('skills.dangling') : source}
                </small>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
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

type LoadoutDragItem = {
  type: 'skill' | 'pack';
  id: string;
  origin: 'catalog' | 'loadout';
};

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
  const [dragItem, setDragItem] = useState<LoadoutDragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<'catalog' | 'loadout' | null>(null);
  const resolved = useMemo(
    () => resolveLoadoutPreview(props.selectedSkills, props.selectedPacks, props.packs),
    [props.selectedSkills, props.selectedPacks, props.packs],
  );
  const prefix = props.idPrefix ?? 'loadout';

  // A saved loadout can name things that no longer exist (skill uninstalled,
  // pack deleted). They must still get a removable card, otherwise the selection is
  // visible but un-removable and the user can never clean it up.
  const orphanPacks = useMemo(
    () => [...props.selectedPacks].filter(id => !props.packs.some(pack => pack.id === id)),
    [props.selectedPacks, props.packs],
  );
  const orphanSkills = useMemo(
    () => [...props.selectedSkills].filter(name => !props.skills.some(skill => skill.name === name)),
    [props.selectedSkills, props.skills],
  );

  const startDrag = (event: DragEvent<HTMLElement>, item: LoadoutDragItem) => {
    setDragItem(item);
    event.dataTransfer.effectAllowed = item.origin === 'catalog' ? 'copy' : 'move';
    // Firefox refuses to begin native DnD unless at least one payload is set.
    event.dataTransfer.setData('text/plain', `${item.type}:${item.id}`);
  };

  const clearDrag = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  const isSelected = (item: Pick<LoadoutDragItem, 'type' | 'id'>) => (
    item.type === 'skill' ? props.selectedSkills.has(item.id) : props.selectedPacks.has(item.id)
  );

  const toggle = (item: Pick<LoadoutDragItem, 'type' | 'id'>) => {
    if (item.type === 'skill') props.onToggleSkill(item.id);
    else props.onTogglePack(item.id);
  };

  const acceptDrop = (event: DragEvent<HTMLElement>, target: 'catalog' | 'loadout') => {
    if (!dragItem) return;
    const valid = target === 'loadout'
      ? dragItem.origin === 'catalog' && !isSelected(dragItem)
      : dragItem.origin === 'loadout' && isSelected(dragItem);
    if (!valid) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = target === 'loadout' ? 'copy' : 'move';
    setDropTarget(target);
  };

  const finishDrop = (event: DragEvent<HTMLElement>, target: 'catalog' | 'loadout') => {
    if (!dragItem) return;
    const valid = target === 'loadout'
      ? dragItem.origin === 'catalog' && !isSelected(dragItem)
      : dragItem.origin === 'loadout' && isSelected(dragItem);
    if (!valid) return;
    event.preventDefault();
    toggle(dragItem);
    clearDrag();
  };

  const leaveDropTarget = (event: DragEvent<HTMLElement>, target: 'catalog' | 'loadout') => {
    const relatedTarget = event.relatedTarget as Node | null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) return;
    setDropTarget(current => current === target ? null : current);
  };

  const catalogItem = (
    item: LoadoutDragItem,
    label: string,
    detail: string | undefined,
    marker: Record<string, string>,
  ) => {
    const selected = isSelected(item);
    return (
      <button
        key={`${item.type}:${item.id}`}
        type="button"
        className={`skills-loadout-catalog-item${selected ? ' is-equipped' : ''}`}
        draggable={!props.disabled}
        aria-pressed={selected}
        aria-label={tr(selected ? 'skills.loadoutRemove' : 'skills.loadoutAdd', { item: label })}
        disabled={props.disabled}
        title={detail || label}
        {...marker}
        onClick={() => toggle(item)}
        onDragStart={event => startDrag(event, item)}
        onDragEnd={clearDrag}
      >
        <span className={`skills-loadout-kind skills-loadout-kind-${item.type}`} aria-hidden="true">
          {item.type === 'pack' ? 'P' : 'S'}
        </span>
        <span className="skills-loadout-catalog-copy">
          <strong>{label}</strong>
          {detail && <small>{detail}</small>}
        </span>
        <span className="skills-loadout-catalog-action" aria-hidden="true">
          {selected ? '✓' : '+'}
        </span>
      </button>
    );
  };

  const equippedItem = (
    item: LoadoutDragItem,
    label: string,
    detail: string,
    orphan?: 'skill' | 'pack',
  ) => (
    <div
      key={`${item.type}:${item.id}`}
      className={`skills-loadout-equipped-item${orphan ? ' skills-loadout-orphan' : ''}`}
      draggable={!props.disabled}
      data-equipped-type={item.type}
      data-equipped-id={item.id}
      {...(orphan ? { 'data-loadout-orphan': orphan } : {})}
      onDragStart={event => startDrag(event, item)}
      onDragEnd={clearDrag}
    >
      <span className={`skills-loadout-kind skills-loadout-kind-${item.type}`} aria-hidden="true">
        {item.type === 'pack' ? 'P' : 'S'}
      </span>
      <span className="skills-loadout-equipped-copy">
        <strong>{label}</strong>
        <small className={orphan ? 'skills-loadout-orphan-tag' : undefined}>{detail}</small>
      </span>
      <button
        type="button"
        className="skills-loadout-remove"
        disabled={props.disabled}
        aria-label={tr('skills.loadoutRemove', { item: label })}
        onClick={() => toggle(item)}
      >×</button>
    </div>
  );

  const equippedPacks = [
    ...props.packs
      .filter(pack => props.selectedPacks.has(pack.id))
      .map(pack => equippedItem(
        { type: 'pack', id: pack.id, origin: 'loadout' },
        pack.name,
        tr('skills.skillCount', { count: pack.include.length }),
      )),
    ...orphanPacks.map(id => equippedItem(
      { type: 'pack', id, origin: 'loadout' },
      id,
      tr('skills.healthPackMissing'),
      'pack',
    )),
  ];
  const equippedSkills = [
    ...props.skills
      .filter(skill => props.selectedSkills.has(skill.name))
      .map(skill => equippedItem(
        { type: 'skill', id: skill.name, origin: 'loadout' },
        skill.name,
        tr('skills.loadoutDirect'),
      )),
    ...orphanSkills.map(name => equippedItem(
      { type: 'skill', id: name, origin: 'loadout' },
      name,
      tr('skills.dangling'),
      'skill',
    )),
  ];

  return (
    <div className="skills-loadout-picker" data-loadout-picker={prefix}>
      <div className="skills-loadout-workbench">
        <section
          className={`skills-loadout-zone skills-loadout-library${dropTarget === 'catalog' ? ' is-drop-target' : ''}`}
          data-loadout-library
          onDragOver={event => acceptDrop(event, 'catalog')}
          onDragLeave={event => leaveDropTarget(event, 'catalog')}
          onDrop={event => finishDrop(event, 'catalog')}
        >
          <header className="skills-loadout-zone-head">
            <span>
              <strong>{tr('skills.loadoutCatalog')}</strong>
              <small>{dragItem?.origin === 'loadout' ? tr('skills.loadoutDragBack') : tr('skills.loadoutDragHint')}</small>
            </span>
            <span className="skills-loadout-count">{props.packs.length + props.skills.length}</span>
          </header>

          <div className="skills-loadout-library-scroll">
            <div className="skills-loadout-catalog-group">
              <span className="skills-loadout-group-label">{tr('skills.packChips')}</span>
              <div className="skills-loadout-catalog-list">
                {props.packs.map(pack => catalogItem(
                  { type: 'pack', id: pack.id, origin: 'catalog' },
                  pack.name,
                  tr('skills.skillCount', { count: pack.include.length }),
                  { 'data-loadout-pack': pack.id },
                ))}
                {props.packs.length === 0 && <small className="muted">{tr('skills.packsEmpty')}</small>}
              </div>
            </div>

            <div className="skills-loadout-catalog-group">
              <span className="skills-loadout-group-label">{tr('skills.individualSkills')}</span>
              <div className="skills-loadout-catalog-list">
                {props.skills.map(skill => catalogItem(
                  { type: 'skill', id: skill.name, origin: 'catalog' },
                  skill.name,
                  skill.description,
                  { 'data-loadout-skill': skill.name },
                ))}
                {props.skills.length === 0 && <small className="muted">{tr('skills.emptyTitle')}</small>}
              </div>
            </div>
          </div>
        </section>

        <section
          className={`skills-loadout-zone skills-loadout-tray${dropTarget === 'loadout' ? ' is-drop-target' : ''}`}
          data-loadout-tray
          onDragOver={event => acceptDrop(event, 'loadout')}
          onDragLeave={event => leaveDropTarget(event, 'loadout')}
          onDrop={event => finishDrop(event, 'loadout')}
        >
          <header className="skills-loadout-zone-head">
            <span>
              <strong>{tr('skills.loadoutEquipped')}</strong>
              <small>{tr('skills.loadoutEquippedHint')}</small>
            </span>
            <span className="skills-loadout-count is-accent">{props.selectedPacks.size + props.selectedSkills.size}</span>
          </header>

          <div className="skills-loadout-equipped-list">
            {equippedPacks}
            {equippedSkills}
            {equippedPacks.length === 0 && equippedSkills.length === 0 && (
              <div className="skills-loadout-empty-slot">
                <span aria-hidden="true">＋</span>
                <strong>{tr('skills.loadoutDropHere')}</strong>
                <small>{tr('skills.loadoutEmpty')}</small>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="skills-loadout-resolved" data-loadout-resolved>
        <div className="skills-loadout-resolved-head">
          <strong>{tr('skills.resolvedPreview')}</strong>
          <span>{resolved.length}</span>
        </div>
        <div className="skills-loadout-resolved-chips">
          {resolved.length === 0
            ? <small className="muted">{tr('skills.loadoutEmpty')}</small>
            : resolved.map(({ name, source }) => (
              <span
                key={name}
                className={`skills-loadout-resolved-chip${props.unavailableSkills?.has(name) ? ' skills-resolved-missing' : ''}`}
                data-resolved-skill={name}
                title={props.unavailableSkills?.has(name) ? tr('skills.dangling') : source}
              >
                {name}
                <small>{props.unavailableSkills?.has(name) ? '!' : source === 'direct' ? 'S' : 'P'}</small>
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

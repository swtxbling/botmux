import type { BotSkillPolicy } from '../../core/skills/types.js';

/** Per-bot loadout drafts held by the create-session dialog. A bot appears here
 *  ONLY once the user has actually touched its loadout; "restore default"
 *  deletes the key rather than storing an empty policy. That mirrors the
 *  backend contract exactly — absent means "inherit the bot policy", while
 *  `{ include: [] }` means "explicitly no skills" — so the dialog can never
 *  accidentally strip a bot's skills just by being opened. */
export type LoadoutDrafts = Record<string, BotSkillPolicy>;

/** The Lead the request will actually carry.
 *
 *  The dialog's Lead <select> is empty until the user touches it, but submit
 *  falls back to the first checked bot — so reading the raw state would make
 *  the loadout rows disagree with the bots that really spawn. Both call sites
 *  go through here so they cannot drift apart. */
export function effectiveLeadLarkAppId(lead: string, checkedIds: readonly string[]): string {
  return lead || checkedIds[0] || '';
}

/** Which bots should get a loadout row, given the current mode.
 *
 *  Mirrors the server's selectCreateSessionTargets: in Lead mode only the Lead
 *  actually spawns, so showing rows for the subs would offer configuration the
 *  user believes is active while nothing ever applies it. */
export function loadoutTargetBots(
  mode: 'lead' | 'all',
  checkedIds: readonly string[],
  leadLarkAppId: string,
): string[] {
  if (mode === 'lead') {
    return leadLarkAppId && checkedIds.includes(leadLarkAppId) ? [leadLarkAppId] : [];
  }
  return [...checkedIds];
}

/** Build the `skillLoadouts` map for the create-session request.
 *
 *  Only bots the user actually customised are included, and only if they are
 *  still a target — unchecking a bot, or switching back to Lead mode, must not
 *  leave a stale entry behind for a bot that will not spawn. */
export function buildLoadoutSubmission(
  drafts: LoadoutDrafts,
  targets: readonly string[],
): Record<string, BotSkillPolicy> | undefined {
  const out: Record<string, BotSkillPolicy> = {};
  for (const larkAppId of targets) {
    const draft = drafts[larkAppId];
    if (draft) out[larkAppId] = draft;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Turn a picker selection into the wire policy. The selection IS the complete
 *  final set: the dialog pre-fills it from the bot's own policy and the user
 *  edits from there, so the frontend never merges or extends — that would
 *  contradict the backend's wholesale-replacement semantics. */
export function policyFromSelection(
  skillNames: Iterable<string>,
  packIds: Iterable<string>,
): BotSkillPolicy {
  const include = [
    ...[...new Set(skillNames)].map(name => `skill:${name}` as const),
    ...[...new Set(packIds)].map(id => `pack:${id}` as const),
  ];
  return { include };
}

/** Split a policy back into picker selections.
 *
 *  Accepts the loose `{ include?: string[] }` shape too: a policy read back
 *  from /api/bots is plain JSON, and unknown selector kinds are ignored rather
 *  than trusted. */
export function selectionFromPolicy(policy: { include?: readonly string[] } | undefined): {
  skills: Set<string>;
  packs: Set<string>;
} {
  const skills = new Set<string>();
  const packs = new Set<string>();
  for (const selector of policy?.include ?? []) {
    if (selector.startsWith('skill:')) skills.add(selector.slice('skill:'.length));
    else if (selector.startsWith('pack:')) packs.add(selector.slice('pack:'.length));
  }
  return { skills, packs };
}

/** Whether a draft actually differs from what the bot would use anyway. Used to
 *  label a row as customised, and to let "restore default" be a no-op rather
 *  than submitting a loadout identical to the inherited policy. */
export function isLoadoutCustomised(
  draft: BotSkillPolicy | undefined,
  botPolicy: { include?: readonly string[] } | undefined,
): boolean {
  if (!draft) return false;
  const normalize = (policy: { include?: readonly string[] } | undefined) => [...(policy?.include ?? [])].sort().join(' ');
  return normalize(draft) !== normalize(botPolicy);
}

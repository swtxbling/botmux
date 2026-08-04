import { describe, expect, it } from 'vitest';
import { resolveSessionSkillManifest } from '../src/core/skills/session-resolver.js';
import type { BotSkillPolicy, SkillPack, SkillPackage } from '../src/core/skills/types.js';

/** Per-session Skill loadout ("confirm your loadout before entering the
 *  dungeon"). The daemon picks `session.skillLoadout ?? botCfg.skills` when it
 *  builds the worker init message, so everything downstream — policy
 *  resolution, pack expansion, delivery, prompt catalog — stays on one code
 *  path. These tests pin the two properties that matter:
 *
 *   1. no loadout  → byte-identical to the bot policy (the safety floor, since
 *      every automatic spawn path leaves the field undefined);
 *   2. a loadout   → fully replaces the bot policy, packs included.
 */

function skill(name: string): SkillPackage {
  return {
    id: name,
    name,
    tags: [],
    rootDir: `/skills/${name}`,
    entrypoint: 'SKILL.md',
    source: { type: 'user', root: `/skills/${name}` },
  };
}

const registrySkills = [skill('deploy'), skill('review'), skill('release')];

const packs: Record<string, SkillPack> = {
  ops: {
    id: 'ops',
    name: 'Ops',
    include: ['skill:deploy', 'skill:release'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

function resolve(policy: BotSkillPolicy | undefined) {
  return resolveSessionSkillManifest({
    sessionId: 's1',
    cliId: 'claude-code',
    workingDir: '/tmp/work',
    botPolicy: policy,
    registrySkills,
    projectSkills: [],
    packs,
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

/** What worker-pool does when composing the init message. */
function effectivePolicy(
  botPolicy: BotSkillPolicy | undefined,
  skillLoadout: BotSkillPolicy | null | undefined,
): BotSkillPolicy | undefined {
  return skillLoadout ?? botPolicy;
}

describe('session skill loadout', () => {
  const botPolicy: BotSkillPolicy = { include: ['skill:deploy'] };

  describe('safety floor: no loadout changes nothing', () => {
    it('undefined loadout resolves exactly like the bot policy alone', () => {
      const inherited = resolve(effectivePolicy(botPolicy, undefined));
      const baseline = resolve(botPolicy);
      expect(inherited).toEqual(baseline);
      expect(inherited?.prioritySkills.map(s => s.name)).toEqual(['deploy']);
    });

    it('a bot with no policy still resolves to nothing', () => {
      expect(resolve(effectivePolicy(undefined, undefined))).toBeNull();
    });
  });

  describe('loadout replaces the bot policy for this session only', () => {
    it('swaps in a different skill set', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['skill:review'] }));
      expect(manifest?.prioritySkills.map(s => s.name)).toEqual(['review']);
      // The bot's own policy is untouched — resolving it again is unchanged.
      expect(resolve(botPolicy)?.prioritySkills.map(s => s.name)).toEqual(['deploy']);
    });

    it('expands pack: selectors just like a bot policy would', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['pack:ops'] }));
      expect(manifest?.prioritySkills.map(s => s.name).sort()).toEqual(['deploy', 'release']);
    });

    it('keeps direct-skill precedence over pack members', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['skill:release', 'pack:ops'] }));
      const names = manifest?.prioritySkills.map(s => s.name) ?? [];
      expect(names[0]).toBe('release');
      expect(names.filter(n => n === 'release')).toHaveLength(1);
    });

    it('an empty loadout is an explicit "no skills", not an inherit', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: [] }));
      expect(manifest?.prioritySkills ?? []).toHaveLength(0);
      expect(manifest?.prioritySkills.map(s => s.name)).not.toContain('deploy');
    });
  });

  describe('referenced-but-missing skills degrade, never throw', () => {
    it('names the missing skill instead of dropping it silently', () => {
      // Before per-session loadouts this was silent unless the whole set came
      // out empty: a hand-picked skill that was not installed simply vanished,
      // so the session looked correctly equipped when it was not. `skill:` is
      // an exact-name match, so "matched nothing" is unambiguously "missing".
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['skill:ghost', 'skill:review'] }));
      expect(manifest?.prioritySkills.map(s => s.name)).toEqual(['review']);
      expect(manifest?.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warn', code: 'skill_not_found', skillName: 'ghost' }),
      );
    });

    it('does not cry wolf when everything resolves', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['skill:deploy', 'pack:ops'] }));
      expect(manifest?.diagnostics.filter(d => d.code === 'skill_not_found')).toHaveLength(0);
    });

    it('a loadout naming a deleted pack still resolves the rest', () => {
      const manifest = resolve(effectivePolicy(botPolicy, { include: ['pack:gone', 'skill:review'] }));
      expect(manifest?.prioritySkills.map(s => s.name)).toEqual(['review']);
    });
  });

  describe('null is treated as inherit, matching the ?? in worker-pool', () => {
    it('null loadout falls back to the bot policy', () => {
      expect(effectivePolicy(botPolicy, null)).toEqual(botPolicy);
      expect(resolve(effectivePolicy(botPolicy, null))?.prioritySkills.map(s => s.name)).toEqual(['deploy']);
    });
  });
});

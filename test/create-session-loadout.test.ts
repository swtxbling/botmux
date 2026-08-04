import { describe, expect, it } from 'vitest';
import {
  buildLoadoutSubmission,
  isLoadoutCustomised,
  loadoutTargetBots,
  policyFromSelection,
  selectionFromPolicy,
} from '../src/dashboard/web/create-session-loadout.js';
import { parseSessionLoadouts, selectCreateSessionTargets } from '../src/core/session-create.js';

describe('create-session loadout drafts', () => {
  describe('loadoutTargetBots mirrors the server target rule', () => {
    it('Lead mode offers a row only for the Lead', () => {
      expect(loadoutTargetBots('lead', ['lead', 'sub-a'], 'lead')).toEqual(['lead']);
    });

    it('all mode offers a row per checked bot', () => {
      expect(loadoutTargetBots('all', ['lead', 'sub-a'], 'lead')).toEqual(['lead', 'sub-a']);
    });

    it('offers nothing when the Lead is not among the checked bots', () => {
      expect(loadoutTargetBots('lead', ['sub-a'], 'lead')).toEqual([]);
    });

    it('agrees with selectCreateSessionTargets for the same inputs', () => {
      // The dialog must not offer configuration the server would discard.
      for (const mode of ['lead', 'all'] as const) {
        expect(loadoutTargetBots(mode, ['lead', 'sub-a'], 'lead'))
          .toEqual(selectCreateSessionTargets(mode, ['lead', 'sub-a'], 'lead'));
      }
    });
  });

  describe('buildLoadoutSubmission only submits what the user customised', () => {
    it('omits untouched bots so they inherit their own policy', () => {
      const drafts = { lead: { include: ['skill:review'] } };
      expect(buildLoadoutSubmission(drafts, ['lead', 'sub-a'])).toEqual({ lead: { include: ['skill:review'] } });
    });

    it('returns undefined when nothing was customised', () => {
      expect(buildLoadoutSubmission({}, ['lead', 'sub-a'])).toBeUndefined();
    });

    it('drops a draft for a bot that is no longer a target', () => {
      // Unchecking a bot, or switching back to Lead mode, must not leave a
      // stale entry for a bot that will never spawn.
      const drafts = { lead: { include: ['skill:a'] }, 'sub-a': { include: ['skill:b'] } };
      expect(buildLoadoutSubmission(drafts, ['lead'])).toEqual({ lead: { include: ['skill:a'] } });
    });

    it('passes an explicitly empty policy through as a real customisation', () => {
      expect(buildLoadoutSubmission({ lead: { include: [] } }, ['lead']))
        .toEqual({ lead: { include: [] } });
    });

    it('produces a payload the server accepts unchanged', () => {
      const targets = selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead');
      const submission = buildLoadoutSubmission({ lead: { include: ['skill:review', 'pack:ops'] } }, targets);
      expect(parseSessionLoadouts(submission, targets)).toEqual({
        ok: true,
        value: { lead: { include: ['skill:review', 'pack:ops'] } },
      });
    });
  });

  describe('selection ↔ policy round-trip', () => {
    it('builds a policy from the complete final selection', () => {
      expect(policyFromSelection(['a', 'b'], ['ops']))
        .toEqual({ include: ['skill:a', 'skill:b', 'pack:ops'] });
    });

    it('an empty selection is an explicit empty policy, not undefined', () => {
      expect(policyFromSelection([], [])).toEqual({ include: [] });
    });

    it('round-trips back into picker selections', () => {
      const policy = policyFromSelection(['a'], ['ops']);
      const selection = selectionFromPolicy(policy);
      expect([...selection.skills]).toEqual(['a']);
      expect([...selection.packs]).toEqual(['ops']);
    });

    it('ignores unknown selector kinds when splitting an existing policy', () => {
      const selection = selectionFromPolicy({ include: ['skill:a', 'workflow:x'] });
      expect([...selection.skills]).toEqual(['a']);
      expect([...selection.packs]).toEqual([]);
    });

    it('dedupes so the same skill picked twice yields one selector', () => {
      expect(policyFromSelection(['a', 'a'], [])).toEqual({ include: ['skill:a'] });
    });
  });

  describe('isLoadoutCustomised', () => {
    const botPolicy = { include: ['skill:a', 'pack:ops'] };

    it('an absent draft is never customised', () => {
      expect(isLoadoutCustomised(undefined, botPolicy)).toBe(false);
    });

    it('a draft equal to the bot policy is not customised, regardless of order', () => {
      expect(isLoadoutCustomised({ include: ['pack:ops', 'skill:a'] }, botPolicy)).toBe(false);
    });

    it('any real difference counts, including clearing everything', () => {
      expect(isLoadoutCustomised({ include: ['skill:a'] }, botPolicy)).toBe(true);
      expect(isLoadoutCustomised({ include: [] }, botPolicy)).toBe(true);
    });

    it('a non-empty draft against a bot with no policy is customised', () => {
      expect(isLoadoutCustomised({ include: ['skill:a'] }, undefined)).toBe(true);
      expect(isLoadoutCustomised({ include: [] }, undefined)).toBe(false);
    });
  });
});

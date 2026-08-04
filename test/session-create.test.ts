import { describe, it, expect } from 'vitest';
import {
  normalizeCreateMode,
  normalizeCreateColumn,
  deriveSessionTitleFromContent,
  deriveCreateGroupName,
  selectCreateSessionTargets,
  buildSessionSpawnRequests,
  parseSessionLoadout,
  parseSessionLoadouts,
  parseSpawnRequest,
  composeSpawnCodexAppContext,
  composeSpawnUserContent,
  applyQueuedCodexAppLegacyFallback,
  mergeQueuedCodexAppTurn,
  buildLeadDispatchPreamble,
  buildCollabNote,
} from '../src/core/session-create.js';

describe('normalizeCreateMode / normalizeCreateColumn', () => {
  it('accepts only the valid literals', () => {
    expect(normalizeCreateMode('all')).toBe('all');
    expect(normalizeCreateMode('lead')).toBe('lead');
    expect(normalizeCreateMode('solo')).toBeNull();
    expect(normalizeCreateMode(123)).toBeNull();
    expect(normalizeCreateColumn('in_progress')).toBe('in_progress');
    expect(normalizeCreateColumn('backlog')).toBe('backlog');
    expect(normalizeCreateColumn('todo')).toBeNull();
    expect(normalizeCreateColumn(undefined)).toBeNull();
  });
});

describe('deriveSessionTitleFromContent', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(deriveSessionTitleFromContent('  \n\n  修复登录 bug  \n更多细节')).toBe('修复登录 bug');
  });
  it('caps very long first lines with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const title = deriveSessionTitleFromContent(long);
    expect(title.length).toBe(51); // 50 chars + …
    expect(title.endsWith('…')).toBe(true);
  });
  it('falls back to a placeholder for blank content', () => {
    expect(deriveSessionTitleFromContent('   \n  ')).toBeTruthy();
  });
});

describe('deriveCreateGroupName', () => {
  it('uses the explicit trimmed name when present', () => {
    expect(deriveCreateGroupName('  自定义群名  ', '内容首行')).toBe('自定义群名');
  });
  it('falls back to the first non-empty content line when blank', () => {
    expect(deriveCreateGroupName('   ', '\n  修复创建会话  \n详情')).toBe('修复创建会话');
  });
});

describe('selectCreateSessionTargets', () => {
  const joined = ['lead', 'sub-a', 'sub-b'];
  it('Lead mode starts only the Lead even when task content may mention subs', () => {
    expect(selectCreateSessionTargets('lead', joined, 'lead')).toEqual(['lead']);
  });
  it('all mode starts every joined bot', () => {
    expect(selectCreateSessionTargets('all', joined, 'lead')).toEqual(joined);
  });
  it('does not start a Lead that failed to join', () => {
    expect(selectCreateSessionTargets('lead', ['sub-a'], 'lead')).toEqual([]);
  });
});

describe('session Skill loadout validation (fail-closed)', () => {
  // A loadout REPLACES the bot's own policy for the spawned session, so the
  // three outcomes must stay distinguishable. Filtering unknown selectors used
  // to turn `['workflow:evil']` into `{ include: [] }` — bad input silently
  // became the single most destructive VALID meaning ("carry no skills at
  // all"), and a mixed list applied only partially. Both are now errors.
  const allTargets = selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead');
  const leadTargets = selectCreateSessionTargets('lead', ['lead', 'sub-a'], 'lead');

  describe('parseSessionLoadout: the three states', () => {
    it('only an ABSENT field means inherit', () => {
      expect(parseSessionLoadout(undefined)).toEqual({ ok: true, value: undefined });
    });

    it('explicit null is rejected, not treated as inherit', () => {
      // null is a value the caller chose to send, not a missing key. Accepting
      // it as inherit would give a second, silent way to say something the
      // contract requires stating with a real policy object.
      expect(parseSessionLoadout(null)).toEqual({ ok: false, error: 'bad_skill_loadout' });
      expect(parseSessionLoadouts({ lead: null }, ['lead'])).toEqual({ ok: false, error: 'bad_skill_loadout' });
    });

    it('valid is kept verbatim, including an explicit empty policy', () => {
      expect(parseSessionLoadout({ include: ['skill:a', 'pack:ops'] }))
        .toEqual({ ok: true, value: { include: ['skill:a', 'pack:ops'] } });
      expect(parseSessionLoadout({ include: [] })).toEqual({ ok: true, value: { include: [] } });
    });

    it('rejects unknown selector kinds instead of filtering them away', () => {
      expect(parseSessionLoadout({ include: ['workflow:evil'] })).toEqual({ ok: false, error: 'bad_skill_loadout' });
    });

    it('rejects a mixed list rather than applying it partially', () => {
      expect(parseSessionLoadout({ include: ['skill:ok', 'workflow:evil'] }))
        .toEqual({ ok: false, error: 'bad_skill_loadout' });
    });

    it('rejects malformed selectors and non-strings', () => {
      for (const bad of [['skill:'], ['pack:'], [''], ['nocolon'], [42], [null]]) {
        expect(parseSessionLoadout({ include: bad })).toEqual({ ok: false, error: 'bad_skill_loadout' });
      }
    });

    it('rejects structurally invalid payloads instead of falling back to inherit', () => {
      for (const bad of ['nope', 42, [], { include: 'x' }, {}, null]) {
        expect(parseSessionLoadout(bad)).toEqual({ ok: false, error: 'bad_skill_loadout' });
      }
    });

    it('dedupes, which is not filtering: duplicates carry no distinct intent', () => {
      expect(parseSessionLoadout({ include: ['skill:a', 'skill:a'] }))
        .toEqual({ ok: true, value: { include: ['skill:a'] } });
    });
  });

  describe('parseSessionLoadouts: per-bot map', () => {
    it('Lead mode keeps only the Lead; a sub-bot entry would never take effect', () => {
      const r = parseSessionLoadouts({
        lead: { include: ['skill:deploy'] },
        'sub-a': { include: ['skill:review'] },
      }, leadTargets);
      expect(r).toEqual({ ok: true, value: { lead: { include: ['skill:deploy'] } } });
    });

    it('all mode keeps one entry per target bot', () => {
      const r = parseSessionLoadouts({
        lead: { include: ['skill:deploy'] },
        'sub-a': { include: ['pack:ops'] },
      }, allTargets);
      expect(r.ok && r.value).toEqual({
        lead: { include: ['skill:deploy'] },
        'sub-a': { include: ['pack:ops'] },
      });
    });

    it('drops non-target keys without failing the request', () => {
      // A bot that failed to join is not the submitter's mistake, and an
      // ignored key cannot clear anyone's skills.
      const r = parseSessionLoadouts({ stranger: { include: ['skill:a'] } }, allTargets);
      expect(r).toEqual({ ok: true, value: undefined });
    });

    it('fails the whole request when a TARGET bot has a malformed entry', () => {
      expect(parseSessionLoadouts({ lead: { include: ['workflow:evil'] } }, allTargets))
        .toEqual({ ok: false, error: 'bad_skill_loadout' });
    });

    it('ignores a malformed entry belonging to a non-target bot', () => {
      expect(parseSessionLoadouts({ stranger: 'garbage' }, allTargets)).toEqual({ ok: true, value: undefined });
    });

    it('omits bots with no entry so they inherit, rather than inventing an empty policy', () => {
      const r = parseSessionLoadouts({ lead: { include: ['skill:deploy'] } }, allTargets);
      expect(Object.keys((r.ok && r.value) || {})).toEqual(['lead']);
    });

    it('passes an explicitly empty loadout through untouched', () => {
      expect(parseSessionLoadouts({ lead: { include: [] } }, allTargets).ok
        && parseSessionLoadouts({ lead: { include: [] } }, allTargets).value)
        .toEqual({ lead: { include: [] } });
    });

    it('absent map means no per-session loadouts at all', () => {
      expect(parseSessionLoadouts(undefined, allTargets)).toEqual({ ok: true, value: undefined });
    });
  });

  describe('validation must not depend on side-effects having happened', () => {
    // The route validates against EXPECTED targets (lead id / all selected ids)
    // before /api/groups/create runs, then re-narrows to the bots that actually
    // joined. Validating only after group creation meant an invalid payload
    // returned 400 with an orphaned Lark group already created — and a user
    // retrying would mint one on every attempt.
    it('expected targets are computable from the request alone, before any group exists', () => {
      expect(selectCreateSessionTargets('lead', ['lead', 'sub-a'], 'lead')).toEqual(['lead']);
      expect(selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead')).toEqual(['lead', 'sub-a']);
    });

    it('an invalid payload is rejectable against expected targets', () => {
      const expected = selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead');
      expect(parseSessionLoadouts({ lead: { include: ['workflow:evil'] } }, expected))
        .toEqual({ ok: false, error: 'bad_skill_loadout' });
    });

    it('re-narrowing a pre-validated map to actually-joined bots can only drop, never fail', () => {
      const expected = selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead');
      const preflight = parseSessionLoadouts({
        lead: { include: ['skill:a'] },
        'sub-a': { include: ['skill:b'] },
      }, expected);
      expect(preflight.ok).toBe(true);

      // sub-a failed to join, so the real targets are narrower.
      const joinedTargets = ['lead'];
      const narrowed = Object.fromEntries(
        Object.entries((preflight.ok && preflight.value) || {}).filter(([id]) => joinedTargets.includes(id)),
      );
      expect(Object.keys(narrowed)).toEqual(['lead']);
      expect(narrowed.lead).toEqual({ include: ['skill:a'] });
    });
  });

  describe('end to end via the production request builder', () => {
    // buildSessionSpawnRequests is the SAME function /api/sessions/create uses.
    // Re-deriving this mapping inside the test would only prove the test's own
    // arithmetic — which is how "group created, then 400" went unnoticed.
    const nameOf = (id: string) => `name-${id}`;

    it('Lead mode sends a spawn request only to the Lead, carrying its loadout', () => {
      const targets = selectCreateSessionTargets('lead', ['lead', 'sub-a'], 'lead');
      const map = parseSessionLoadouts({
        lead: { include: ['skill:review'] },
        'sub-a': { include: ['skill:never-applies'] },
      }, targets);
      expect(map.ok).toBe(true);

      const requests = buildSessionSpawnRequests({
        chatId: 'oc_x', content: 'go', column: 'in_progress', mode: 'lead',
        targets, joinedIds: ['lead', 'sub-a'], creatorLarkAppId: 'lead', nameOf,
        loadouts: map.ok ? map.value : undefined,
      });

      expect(requests.map(r => r.larkAppId)).toEqual(['lead']);
      expect(requests[0].body.skillLoadout).toEqual({ include: ['skill:review'] });
      expect(requests[0].body.role).toBe('lead');
      expect(requests[0].body.postBanner).toBe(true);
      // The spawn endpoint accepts what the route actually sends.
      const spawn = parseSpawnRequest(requests[0].body);
      expect(spawn.ok && spawn.value.skillLoadout).toEqual({ include: ['skill:review'] });
    });

    it('all mode gives each bot only its own entry and OMITS the key when unconfigured', () => {
      const targets = selectCreateSessionTargets('all', ['lead', 'sub-a'], 'lead');
      const map = parseSessionLoadouts({ lead: { include: ['skill:review'] } }, targets);
      const requests = buildSessionSpawnRequests({
        chatId: 'oc_x', content: 'go', column: 'in_progress', mode: 'all',
        targets, joinedIds: targets, creatorLarkAppId: 'lead', nameOf,
        loadouts: map.ok ? map.value : undefined,
      });

      const byBot = Object.fromEntries(requests.map(r => [r.larkAppId, r.body]));
      expect(byBot.lead.skillLoadout).toEqual({ include: ['skill:review'] });
      // Absent key, not `undefined` value: JSON.stringify must not emit it.
      expect('skillLoadout' in byBot['sub-a']).toBe(false);
      expect(JSON.stringify(byBot['sub-a'])).not.toContain('skillLoadout');
      expect(parseSpawnRequest(byBot['sub-a']).ok
        && parseSpawnRequest(byBot['sub-a']).value.skillLoadout).toBeUndefined();
    });

    it('passes an explicitly empty loadout through the real builder untouched', () => {
      const targets = selectCreateSessionTargets('all', ['lead'], 'lead');
      const map = parseSessionLoadouts({ lead: { include: [] } }, targets);
      const requests = buildSessionSpawnRequests({
        chatId: 'oc_x', content: 'go', column: 'in_progress', mode: 'all',
        targets, joinedIds: targets, creatorLarkAppId: 'lead', nameOf,
        loadouts: map.ok ? map.value : undefined,
      });
      expect(requests[0].body.skillLoadout).toEqual({ include: [] });
      const spawn = parseSpawnRequest(requests[0].body);
      expect(spawn.ok && spawn.value.skillLoadout).toEqual({ include: [] });
    });

    it('never leaks another bot\'s loadout into a request', () => {
      const targets = selectCreateSessionTargets('all', ['a', 'b'], 'a');
      const map = parseSessionLoadouts({
        a: { include: ['skill:for-a'] },
        b: { include: ['skill:for-b'] },
      }, targets);
      const requests = buildSessionSpawnRequests({
        chatId: 'oc_x', content: 'go', column: 'in_progress', mode: 'all',
        targets, joinedIds: targets, creatorLarkAppId: 'a', nameOf,
        loadouts: map.ok ? map.value : undefined,
      });
      for (const request of requests) {
        const serialized = JSON.stringify(request.body);
        const otherSkill = request.larkAppId === 'a' ? 'skill:for-b' : 'skill:for-a';
        expect(serialized).not.toContain(otherSkill);
      }
    });

    it('the spawn endpoint re-validates rather than trusting the aggregator', () => {
      expect(parseSpawnRequest({
        chatId: 'oc_x', content: 'go', column: 'in_progress', role: 'solo',
        skillLoadout: { include: ['skill:ok', 'workflow:evil'] },
      })).toEqual({ ok: false, error: 'bad_skill_loadout' });
    });
  });
});

describe('parseSpawnRequest', () => {
  const base = { chatId: 'oc_abc', content: '做点事', column: 'in_progress', role: 'solo' };

  it('accepts a well-formed request and trims trailing whitespace from content', () => {
    const r = parseSpawnRequest({ ...base, content: 'hello\n\n  ', coworkers: [{ name: 'Bob', openId: 'ou_b' }, { name: '' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toBe('hello');
      expect(r.value.chatId).toBe('oc_abc');
      expect(r.value.column).toBe('in_progress');
      expect(r.value.role).toBe('solo');
      // empty-name coworker dropped; valid one kept
      expect(r.value.coworkers).toEqual([{ name: 'Bob', openId: 'ou_b' }]);
    }
  });

  it('rejects a non-oc_ chatId', () => {
    expect(parseSpawnRequest({ ...base, chatId: 'om_msg' })).toMatchObject({ ok: false, error: 'bad_chat_id' });
    expect(parseSpawnRequest({ ...base, chatId: '' })).toMatchObject({ ok: false, error: 'bad_chat_id' });
  });

  it('rejects empty / whitespace-only content', () => {
    expect(parseSpawnRequest({ ...base, content: '   ' })).toMatchObject({ ok: false, error: 'empty_content' });
    expect(parseSpawnRequest({ ...base, content: '' })).toMatchObject({ ok: false, error: 'empty_content' });
  });

  it('accepts very long content (no size cap — owner-authed input)', () => {
    const huge = 'a'.repeat(50000);
    const r = parseSpawnRequest({ ...base, content: huge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content.length).toBe(50000);
  });

  it('rejects bad column / role', () => {
    expect(parseSpawnRequest({ ...base, column: 'todo' })).toMatchObject({ ok: false, error: 'bad_column' });
    expect(parseSpawnRequest({ ...base, role: 'boss' })).toMatchObject({ ok: false, error: 'bad_role' });
  });

  it('rejects a non-object body', () => {
    expect(parseSpawnRequest(null)).toMatchObject({ ok: false, error: 'bad_request' });
    expect(parseSpawnRequest('nope')).toMatchObject({ ok: false, error: 'bad_request' });
  });
});

describe('composeSpawnUserContent', () => {
  it('solo returns the content untouched', () => {
    expect(composeSpawnUserContent({ content: 'do X', role: 'solo' })).toBe('do X');
  });

  it('lead prepends an orchestration preamble listing the sub-bots', () => {
    const out = composeSpawnUserContent({
      content: 'split the work',
      role: 'lead',
      coworkers: [{ name: 'Coder', openId: 'ou_c' }, { name: 'Reviewer' }],
    });
    expect(out).toContain('<botmux_lead_dispatch>');
    expect(out).toContain('Coder');
    expect(out).toContain('ou_c');
    expect(out).toContain('Reviewer'); // open_id-less coworker still listed by name
    expect(out.endsWith('split the work')).toBe(true);
  });

  it('lead with no sub-bots still wraps but notes there are none', () => {
    const out = composeSpawnUserContent({ content: 'go', role: 'lead', coworkers: [] });
    expect(out).toContain('<botmux_lead_dispatch>');
    expect(out.endsWith('go')).toBe(true);
  });

  it('collab prepends a coordination note naming the peers', () => {
    const out = composeSpawnUserContent({
      content: 'build it',
      role: 'collab',
      coworkers: [{ name: 'A' }, { name: 'B' }],
    });
    expect(out).toContain('<botmux_collab>');
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('collab with no peers degrades to plain content (no note)', () => {
    expect(composeSpawnUserContent({ content: 'solo work', role: 'collab', coworkers: [] })).toBe('solo work');
  });
});

describe('Codex App dashboard input composition', () => {
  it('keeps role metadata separate from the raw dashboard task', () => {
    const context = composeSpawnCodexAppContext({
      role: 'lead', coworkers: [{ name: 'Coder', openId: 'ou_c' }],
    });
    expect(context).toContain('<botmux_lead_dispatch>');
    expect(context).toContain('Coder');
    expect(context).not.toContain('用户原始任务');
    expect(composeSpawnCodexAppContext({ role: 'solo' })).toBeUndefined();
  });

  it('same-process activation merges queued and current raw text without leaking wrappers', () => {
    const merged = mergeQueuedCodexAppTurn({
      queued: true,
      queuedText: '最初 dashboard 任务',
      queuedMessageContext: '<botmux_lead_dispatch>协调信息</botmux_lead_dispatch>',
      currentText: '群里的第一条补充',
      currentMessageContext: '<sender>晓雪</sender>',
    });
    expect(merged.text).toBe('最初 dashboard 任务\n\n群里的第一条补充');
    expect(merged.text).not.toContain('botmux_lead_dispatch');
    expect(merged.messageContext).toBe(
      '<botmux_lead_dispatch>协调信息</botmux_lead_dispatch>\n\n<sender>晓雪</sender>',
    );
  });

  it('drops an incomplete sidecar only for a legacy queued snapshot', () => {
    const structured = {
      content: '<user_message>最初任务\n\n开始吧</user_message>',
      codexAppInput: { text: '开始吧' },
    };
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: undefined,
    })).toEqual({ content: structured.content });
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: 42,
    })).toEqual({ content: structured.content });

    // Presence, not truthiness, identifies the new persisted schema.
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: '',
    })).toBe(structured);
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: false,
      queuedText: undefined,
    })).toBe(structured);

    const legacyOnly = { content: structured.content };
    expect(applyQueuedCodexAppLegacyFallback(legacyOnly, {
      queued: true,
      queuedText: undefined,
    })).toBe(legacyOnly);
  });

  it('non-queued turns keep the current clean input unchanged', () => {
    expect(mergeQueuedCodexAppTurn({
      queued: false,
      queuedText: '不应出现',
      currentText: '本轮消息',
      currentMessageContext: '<sender>A</sender>',
    })).toEqual({ text: '本轮消息', messageContext: '<sender>A</sender>' });
  });
});

describe('buildLeadDispatchPreamble / buildCollabNote', () => {
  it('preamble lists each coworker on its own line', () => {
    const p = buildLeadDispatchPreamble([{ name: 'X', openId: 'ou_x' }, { name: 'Y' }]);
    expect(p).toContain('- X (open_id: ou_x)');
    expect(p).toContain('- Y');
  });
  it('collab note is empty when there are no peers', () => {
    expect(buildCollabNote([])).toBe('');
  });
});

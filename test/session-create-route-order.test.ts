import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Guards an ORDERING invariant in the /api/sessions/create route that no unit
 *  test of the pure helpers can see.
 *
 *  The route used to validate the Skill loadout only after /api/groups/create
 *  had already run, so an invalid payload returned 400 with a Lark group
 *  already created — and a user retrying minted one on every attempt. Request
 *  validity must not depend on a side-effect having happened.
 *
 *  Building a full route harness would mean mocking the registry, group
 *  creation and daemon proxying; this asserts the invariant directly against
 *  the source instead, in the same spirit as the CSS-layout assertions in
 *  dashboard-skills-ui.test.ts. It is deliberately narrow: it only checks the
 *  relative position of two anchors inside the create-session handler. */
describe('/api/sessions/create ordering: validate before any side-effect', () => {
  const source = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
  const handlerStart = source.indexOf("url.pathname === '/api/sessions/create'");
  const handler = source.slice(handlerStart, handlerStart + 12_000);

  it('locates the create-session handler', () => {
    expect(handlerStart).toBeGreaterThan(0);
  });

  it('validates the loadout before proxying /api/groups/create', () => {
    const validateAt = handler.indexOf('parseSessionLoadouts(');
    const createGroupAt = handler.indexOf("'/api/groups/create'");

    expect(validateAt).toBeGreaterThan(-1);
    expect(createGroupAt).toBeGreaterThan(-1);
    // Compare positions, not the instances themselves, so a failure prints two
    // small numbers rather than a diff of the whole handler.
    expect(validateAt < createGroupAt).toBe(true);
  });

  it('returns 400 on an invalid loadout before the group call', () => {
    const rejectAt = handler.indexOf('error: preflightLoadouts.error');
    const createGroupAt = handler.indexOf("'/api/groups/create'");
    expect(rejectAt).toBeGreaterThan(-1);
    expect(rejectAt < createGroupAt).toBe(true);
  });

  it('derives the pre-flight targets from the request, not from join results', () => {
    // Expected targets must be computable before the group exists: the Lead in
    // lead mode, every selected bot in all mode.
    const preflightTargets = handler.indexOf('const expectedTargets = selectCreateSessionTargets(mode, selectedIds');
    const createGroupAt = handler.indexOf("'/api/groups/create'");
    expect(preflightTargets).toBeGreaterThan(-1);
    expect(preflightTargets < createGroupAt).toBe(true);
  });

  it('narrows the pre-validated map after the group exists, without re-failing', () => {
    // Post-creation narrowing may only DROP entries; a second parse there would
    // reintroduce the ability to fail after the side-effect.
    const createGroupAt = handler.indexOf("'/api/groups/create'");
    const afterGroup = handler.slice(createGroupAt);
    expect(afterGroup).toContain('preflightLoadouts.value');
    expect(afterGroup).not.toContain('parseSessionLoadouts(');
  });

  it('routes spawn payloads through the shared builder rather than an inline map', () => {
    expect(handler).toContain('buildSessionSpawnRequests(');
  });
});

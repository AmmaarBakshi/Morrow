import { afterEach, describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, PreconditionError, UnauthorizedError } from '@morrow/core';
import type { WorkspaceContext } from '../src/context';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

/** A second, unrelated workspace owned by someone else. */
async function otherWorkspace(harness: Harness): Promise<WorkspaceContext> {
  const user = await harness.engine.auth.createUser({ email: 'rival@elsewhere.dev', name: 'Rival', password: 'another long passphrase' });
  const ws = await harness.engine.workspaces.create(user, { name: 'Elsewhere' });
  return { workspaceId: ws.id, role: 'owner', actor: { type: 'user', id: user.id, label: user.name } };
}

describe('workspace isolation', () => {
  it('never reads or writes another workspace’s records', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const mine = await h.contact({ firstName: 'Private', email: 'private@example.com', tags: ['vip'] });
    const tplId = await h.templateId('Newsletter');
    const other = await otherWorkspace(h);

    await expect(engine.contacts.get(other, mine)).rejects.toBeInstanceOf(NotFoundError);
    await expect(engine.contacts.update(other, mine, { firstName: 'Hijacked' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(engine.contacts.archive(other, mine)).rejects.toBeInstanceOf(NotFoundError);
    await expect(engine.templates.get(other, tplId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await engine.contacts.list(other)).items).toHaveLength(0);
    expect((await engine.contacts.list(other, { q: 'private' })).items).toHaveLength(0);

    // Segments compiled in another workspace cannot see our contacts either.
    const seg = await engine.segments.create(other, { name: 'VIPs', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'vip' }] } });
    expect((await engine.segments.preview(other, seg.criteria)).count).toBe(0);
    expect((await engine.segments.preview(ctx, seg.criteria)).count).toBe(1);

    // The same e-mail address may exist independently in both workspaces.
    const theirs = await engine.contacts.create(other, { firstName: 'Their copy', email: 'private@example.com' });
    expect(theirs.id).not.toBe(mine);
    expect((await engine.contacts.get(ctx, mine)).firstName).toBe('Private');
  });

  it('cannot switch a session into a workspace the user does not belong to', async () => {
    h = await createHarness();
    const { engine } = h;
    const other = await otherWorkspace(h);
    const { token } = await engine.auth.login('owner@cyphen.dev', 'correct horse battery staple');
    const session = (await engine.auth.resolveSession(token))!;
    await expect(engine.auth.switchWorkspace(session.session.id, session.user.id, other.workspaceId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await engine.auth.roleIn(session.user.id, other.workspaceId)).toBeNull();
  });
});

describe('sessions and passwords', () => {
  it('rejects bad credentials without revealing which part was wrong', async () => {
    h = await createHarness();
    const { engine } = h;
    const wrongPassword = engine.auth.login('owner@cyphen.dev', 'nope').catch((e: Error) => e);
    const unknownUser = engine.auth.login('nobody@cyphen.dev', 'correct horse battery staple').catch((e: Error) => e);
    const [a, b] = await Promise.all([wrongPassword, unknownUser]);
    expect(a).toBeInstanceOf(UnauthorizedError);
    expect(b).toBeInstanceOf(UnauthorizedError);
    expect((a as Error).message).toBe((b as Error).message);
  });

  it('stores only token hashes and expires sessions', async () => {
    h = await createHarness({ config: { sessionTtlDays: 7 } });
    const { engine } = h;
    const { token } = await engine.auth.login('OWNER@cyphen.dev', 'correct horse battery staple');
    const rows = await engine.db.selectFrom('sessions').select(['token_hash', 'csrf_token']).execute();
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.every((r) => r.csrf_token.length >= 24)).toBe(true);
    const info = await engine.auth.sessionInfo((await engine.auth.resolveSession(token))!);
    expect(info.workspace?.name).toBe('Cyphen');
    expect(info.permissions).toContain('workspace:delete');
    h.clock.advanceDays(8);
    expect(await engine.auth.resolveSession(token)).toBeNull();
    expect(await engine.auth.resolveSession('not-a-real-token-but-long-enough')).toBeNull();
  });

  it('signs out other sessions when the password changes', async () => {
    h = await createHarness();
    const { engine, userId } = h;
    const first = await engine.auth.login('owner@cyphen.dev', 'correct horse battery staple');
    const second = await engine.auth.login('owner@cyphen.dev', 'correct horse battery staple');
    const keep = (await engine.auth.resolveSession(first.token))!;
    await expect(engine.auth.changePassword(userId, 'wrong', 'a brand new passphrase')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(engine.auth.changePassword(userId, 'correct horse battery staple', 'short')).rejects.toThrow();
    await engine.auth.changePassword(userId, 'correct horse battery staple', 'a brand new passphrase', keep.session.id);
    expect(await engine.auth.resolveSession(first.token)).not.toBeNull();
    expect(await engine.auth.resolveSession(second.token)).toBeNull();
    await expect(engine.auth.login('owner@cyphen.dev', 'correct horse battery staple')).rejects.toBeInstanceOf(UnauthorizedError);
    await engine.auth.logout(first.token);
    expect(await engine.auth.resolveSession(first.token)).toBeNull();
  });

  it('closes public sign-up once the first account exists', async () => {
    h = await createHarness({ config: { allowPublicSignup: false } });
    await expect(
      h.engine.auth.signup({ email: 'second@cyphen.dev', name: 'Second', password: 'long enough password', workspaceName: 'Second' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('API keys', () => {
  it('authenticates, never exceeds the creator’s role and stops working when revoked', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const created = await engine.workspaces.createApiKey(ctx, { name: 'CLI', role: 'manager' });
    expect(created.key).toMatch(/^mrw_[a-z0-9]+_/i);
    const stored = await engine.db.selectFrom('api_keys').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    expect(stored.key_hash).not.toContain(created.key);
    expect((await engine.workspaces.apiKeys(ctx))[0]).not.toHaveProperty('key');

    const resolved = await engine.auth.resolveApiKey(created.key);
    expect(resolved).toMatchObject({ role: 'manager', workspaceId: h.workspaceId });
    expect(await engine.auth.resolveApiKey(created.key.slice(0, -1) + 'x')).toBeNull();
    expect(await engine.auth.resolveApiKey('Bearer nonsense')).toBeNull();

    // An admin asking for an owner key gets an admin key.
    const admin = { ...ctx, role: 'admin' as const };
    const capped = await engine.workspaces.createApiKey(admin, { name: 'Too powerful', role: 'owner' });
    expect(capped.role).toBe('admin');
    // Managers cannot create keys at all, and keys cannot create keys.
    await expect(engine.workspaces.createApiKey(h.as('manager'), { name: 'x', role: 'analyst' })).rejects.toBeInstanceOf(ForbiddenError);
    const keyCtx: WorkspaceContext = { workspaceId: h.workspaceId, role: 'owner', actor: { type: 'api_key', id: created.id, label: 'CLI' } };
    await expect(engine.workspaces.createApiKey(keyCtx, { name: 'x', role: 'analyst' })).rejects.toBeInstanceOf(ForbiddenError);

    await engine.workspaces.revokeApiKey(ctx, created.id);
    expect(await engine.auth.resolveApiKey(created.key)).toBeNull();
    const audit = await engine.audit.list(ctx, { action: 'api_key.' });
    expect(audit.map((a) => a.action).sort()).toEqual(['api_key.created', 'api_key.created', 'api_key.revoked']);
  });

  it('expires keys created with a lifetime', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const created = await engine.workspaces.createApiKey(ctx, { name: 'Temporary', role: 'analyst', expiresInDays: 1 });
    expect(await engine.auth.resolveApiKey(created.key)).not.toBeNull();
    h.clock.advanceDays(2);
    expect(await engine.auth.resolveApiKey(created.key)).toBeNull();
  });
});

describe('invitations and roles', () => {
  it('invites, accepts once and respects the role hierarchy', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    await expect(engine.workspaces.invite(h.as('manager'), 'new@cyphen.dev', 'analyst')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(engine.workspaces.invite(h.as('admin'), 'new@cyphen.dev', 'owner')).rejects.toThrow(/cannot invite/);
    const inv = await engine.workspaces.invite(ctx, 'New.Person@Cyphen.dev', 'manager');
    expect(inv.email).toBe('new.person@cyphen.dev');
    const token = inv.acceptUrl!.split('/invite/')[1]!;
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['new.person@cyphen.dev']);
    expect(h.provider.outbox[0]!.text).toContain(inv.acceptUrl);

    expect(await engine.workspaces.inspectInvitation(token)).toMatchObject({ workspaceName: 'Cyphen', role: 'manager', userExists: false });
    const joined = await engine.workspaces.acceptInvitation(token, { name: 'New Person', password: 'a long enough password' });
    expect(joined.workspaceId).toBe(h.workspaceId);
    expect(await engine.auth.roleIn(joined.userId, h.workspaceId)).toBe('manager');
    await expect(engine.workspaces.acceptInvitation(token, { name: 'Again', password: 'a long enough password' })).rejects.toBeInstanceOf(PreconditionError);
    expect((await engine.workspaces.members(ctx)).map((m) => m.role).sort()).toEqual(['manager', 'owner']);
  });

  it('only lets the invited address accept, and honours revocation', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const stranger = await engine.auth.createUser({ email: 'stranger@example.com', name: 'Stranger', password: 'stranger passphrase' });
    const inv = await engine.workspaces.invite(ctx, 'intended@example.com', 'analyst');
    const token = inv.acceptUrl!.split('/invite/')[1]!;
    await expect(engine.workspaces.acceptInvitation(token, { userId: stranger.id })).rejects.toThrow(/sent to intended@example.com/);
    await engine.workspaces.revokeInvitation(ctx, inv.id);
    expect(await engine.workspaces.inspectInvitation(token)).toBeNull();
  });

  it('enforces the permission matrix in the services themselves', async () => {
    h = await createHarness();
    const { engine } = h;
    const analyst = h.as('analyst');
    const id = await h.contact({ firstName: 'Readable', email: 'readable@example.com' });
    await expect(engine.contacts.get(analyst, id)).resolves.toMatchObject({ firstName: 'Readable' });
    await expect(engine.contacts.create(analyst, { firstName: 'Nope' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(engine.contacts.erase(h.as('manager'), id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(engine.workspaces.update(h.as('manager'), { name: 'Renamed' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(engine.workspaces.delete(h.as('admin'), 'cyphen')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(engine.audit.list(h.as('manager'))).rejects.toBeInstanceOf(ForbiddenError);
    const automation = await h.automationId('Birthday greetings');
    await expect(engine.automations.activate(h.as('manager'), automation, { deliveryMode: 'auto' })).rejects.toThrow(/automations:approve_auto/);
    await expect(engine.automations.activate(h.as('manager'), automation, { deliveryMode: 'review' })).resolves.toMatchObject({ status: 'active' });
  });

  it('keeps at least one owner', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const [owner] = await engine.workspaces.members(ctx);
    await expect(engine.workspaces.updateMemberRole(ctx, owner!.id, 'admin')).rejects.toThrow(/owner/i);
    await expect(engine.workspaces.removeMember(ctx, owner!.id)).rejects.toThrow(/owner/i);
  });
});

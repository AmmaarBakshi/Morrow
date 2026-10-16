import {
  canManageRole,
  ConflictError,
  ForbiddenError,
  isRole,
  isValidTimeZone,
  minRole,
  newId,
  NotFoundError,
  normalizeEmail,
  parseWorkspaceSettings,
  PreconditionError,
  randomToken,
  ValidationError,
  workspaceSettingsSchema,
  type ApiKeyDTO,
  type CreatedApiKeyDTO,
  type InvitationDTO,
  type MemberDTO,
  type Role,
  type WorkspaceDTO,
  type WorkspaceSettings,
  type WorkspaceSummaryDTO,
} from '@morrow/core';
import { fromJson, toJson, type Row } from '@morrow/db';
import { actorUserId, authorize, requireUser, type WorkspaceContext } from '../context';
import { sha256 } from '../crypto';
import type { Engine } from '../engine';
import { generateApiKey } from './auth';

const INVITATION_TTL_DAYS = 7;

export function toWorkspaceDTO(w: Row<'workspaces'>): WorkspaceDTO {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    timezone: w.timezone,
    settings: parseWorkspaceSettings(fromJson(w.settings, {})),
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

function toApiKeyDTO(k: Row<'api_keys'>): ApiKeyDTO {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    role: (isRole(k.role) ? k.role : 'analyst') as Role,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
    revokedAt: k.revoked_at,
  };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036F]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) && k !== 'variables') {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

const SETTINGS_TTL_MS = 5_000;

export class WorkspaceService {
  private readonly settingsCache = new Map<string, { at: number; value: { workspace: Row<'workspaces'>; settings: WorkspaceSettings } }>();

  constructor(private readonly e: Engine) {}

  async create(user: Row<'users'>, input: { name: string; timezone?: string; companyName?: string }): Promise<Row<'workspaces'>> {
    const name = (input.name ?? '').trim().slice(0, 80);
    if (!name) throw new ValidationError('Name your workspace.', [{ path: 'workspaceName', message: 'Required.' }]);
    const timezone = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
    let slug = slugify(name);
    for (let i = 2; await this.e.db.selectFrom('workspaces').select('id').where('slug', '=', slug).executeTakeFirst(); i++) {
      slug = `${slugify(name).slice(0, 36)}-${i}`;
    }
    const now = this.e.nowIso();
    const settings = workspaceSettingsSchema.parse({ companyName: input.companyName ?? name });
    const row: Row<'workspaces'> = { id: newId('wsp'), name, slug, timezone, settings: toJson(settings), created_at: now, updated_at: now };
    await this.e.db.transaction().execute(async (trx) => {
      await trx.insertInto('workspaces').values(row).execute();
      await trx.insertInto('memberships').values({ id: newId('mem'), workspace_id: row.id, user_id: user.id, role: 'owner', created_at: now }).execute();
    });
    const ctx: WorkspaceContext = { workspaceId: row.id, role: 'owner', actor: { type: 'user', id: user.id, label: user.name } };
    await this.e.starter.seed(ctx);
    await this.e.audit.record(ctx, 'workspace.created', { type: 'workspace', id: row.id }, { name });
    return row;
  }

  async listForUser(userId: string): Promise<WorkspaceSummaryDTO[]> {
    const rows = await this.e.db
      .selectFrom('memberships')
      .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
      .select(['workspaces.id', 'workspaces.name', 'workspaces.slug', 'memberships.role', 'memberships.created_at'])
      .where('memberships.user_id', '=', userId)
      .orderBy('memberships.created_at', 'asc')
      .execute();
    return rows.filter((r) => isRole(r.role)).map((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role as Role }));
  }

  async row(workspaceId: string): Promise<Row<'workspaces'>> {
    const ws = await this.e.db.selectFrom('workspaces').selectAll().where('id', '=', workspaceId).executeTakeFirst();
    if (!ws) throw new NotFoundError('Workspace');
    return ws;
  }

  async get(ctx: WorkspaceContext): Promise<WorkspaceDTO> {
    authorize(ctx, 'workspace:read');
    return toWorkspaceDTO(await this.row(ctx.workspaceId));
  }

  /** Parsed settings for internal use (no permission check), cached for a few seconds. */
  async settings(workspaceId: string): Promise<{ workspace: Row<'workspaces'>; settings: WorkspaceSettings }> {
    const hit = this.settingsCache.get(workspaceId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const workspace = await this.row(workspaceId);
    const value = { workspace, settings: parseWorkspaceSettings(fromJson(workspace.settings, {})) };
    this.settingsCache.set(workspaceId, { at: Date.now(), value });
    return value;
  }

  invalidate(workspaceId: string): void {
    this.settingsCache.delete(workspaceId);
  }

  async update(ctx: WorkspaceContext, input: { name?: string; timezone?: string; settings?: Record<string, unknown> }): Promise<WorkspaceDTO> {
    authorize(ctx, 'workspace:manage');
    const current = await this.row(ctx.workspaceId);
    const patch: Partial<Row<'workspaces'>> = { updated_at: this.e.nowIso() };
    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 80);
      if (!name) throw new ValidationError('Workspace name is required.', [{ path: 'name', message: 'Required.' }]);
      patch.name = name;
    }
    if (input.timezone !== undefined) {
      if (!isValidTimeZone(input.timezone)) throw new ValidationError('Unknown time zone.', [{ path: 'timezone', message: 'Use an IANA zone such as Asia/Kolkata.' }]);
      patch.timezone = input.timezone;
    }
    const changedKeys: string[] = [];
    if (input.settings) {
      const merged = deepMerge(parseWorkspaceSettings(fromJson(current.settings, {})) as unknown as Record<string, unknown>, input.settings);
      const parsed = workspaceSettingsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new ValidationError(
          'Some settings are invalid.',
          parsed.error.issues.map((i) => ({ path: `settings.${i.path.join('.')}`, message: i.message })),
        );
      }
      patch.settings = toJson(parsed.data);
      changedKeys.push(...Object.keys(input.settings));
    }
    await this.e.db.updateTable('workspaces').set(patch).where('id', '=', ctx.workspaceId).execute();
    this.invalidate(ctx.workspaceId);
    await this.e.audit.record(ctx, 'workspace.updated', { type: 'workspace', id: ctx.workspaceId }, {
      fields: [...Object.keys(input).filter((k) => k !== 'settings'), ...changedKeys.map((k) => `settings.${k}`)],
    });
    return this.get(ctx);
  }

  async delete(ctx: WorkspaceContext, confirmSlug: string): Promise<void> {
    authorize(ctx, 'workspace:delete');
    const ws = await this.row(ctx.workspaceId);
    if (confirmSlug !== ws.slug) throw new PreconditionError(`Type the workspace slug "${ws.slug}" to confirm deletion.`);
    await this.e.db.deleteFrom('workspaces').where('id', '=', ws.id).execute();
    this.e.log.warn('workspace deleted', { workspaceId: ws.id, actor: ctx.actor.id });
  }

  // ---------------------------------------------------------------- members

  async members(ctx: WorkspaceContext): Promise<MemberDTO[]> {
    authorize(ctx, 'workspace:read');
    const rows = await this.e.db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select(['memberships.id', 'memberships.user_id', 'memberships.role', 'memberships.created_at', 'users.email', 'users.name', 'users.last_login_at'])
      .where('memberships.workspace_id', '=', ctx.workspaceId)
      .orderBy('memberships.created_at', 'asc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: r.email,
      name: r.name,
      role: (isRole(r.role) ? r.role : 'analyst') as Role,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    }));
  }

  private async ownerCount(workspaceId: string): Promise<number> {
    const r = await this.e.db
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('role', '=', 'owner')
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  async updateMemberRole(ctx: WorkspaceContext, membershipId: string, role: Role): Promise<void> {
    authorize(ctx, 'members:manage');
    if (!isRole(role)) throw new ValidationError('Unknown role.');
    const m = await this.e.db.selectFrom('memberships').selectAll().where('id', '=', membershipId).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!m || !isRole(m.role)) throw new NotFoundError('Member');
    if (!canManageRole(ctx.role, m.role) || !canManageRole(ctx.role, role)) throw new ForbiddenError('You cannot change this member to or from that role.');
    if (m.role === 'owner' && role !== 'owner' && (await this.ownerCount(ctx.workspaceId)) <= 1) {
      throw new PreconditionError('A workspace needs at least one owner. Make someone else an owner first.');
    }
    await this.e.db.updateTable('memberships').set({ role }).where('id', '=', m.id).execute();
    await this.e.audit.record(ctx, 'member.role_changed', { type: 'membership', id: m.id }, { from: m.role, to: role, userId: m.user_id });
  }

  async removeMember(ctx: WorkspaceContext, membershipId: string): Promise<void> {
    authorize(ctx, 'members:manage');
    const m = await this.e.db.selectFrom('memberships').selectAll().where('id', '=', membershipId).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!m || !isRole(m.role)) throw new NotFoundError('Member');
    if (!canManageRole(ctx.role, m.role)) throw new ForbiddenError('You cannot remove this member.');
    if (m.role === 'owner' && (await this.ownerCount(ctx.workspaceId)) <= 1) throw new PreconditionError('You cannot remove the last owner.');
    await this.e.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('memberships').where('id', '=', m.id).execute();
      await trx.updateTable('sessions').set({ workspace_id: null }).where('user_id', '=', m.user_id).where('workspace_id', '=', ctx.workspaceId).execute();
      await trx.updateTable('api_keys').set({ revoked_at: this.e.nowIso() }).where('created_by', '=', m.user_id).where('workspace_id', '=', ctx.workspaceId).where('revoked_at', 'is', null).execute();
    });
    await this.e.audit.record(ctx, 'member.removed', { type: 'membership', id: m.id }, { userId: m.user_id, role: m.role });
  }

  // ---------------------------------------------------------------- invitations

  async invite(ctx: WorkspaceContext, emailInput: string, role: Role): Promise<InvitationDTO> {
    authorize(ctx, 'members:manage');
    const email = normalizeEmail(emailInput);
    if (!email) throw new ValidationError('Enter a valid e-mail address.', [{ path: 'email', message: 'Invalid e-mail address.' }]);
    if (!isRole(role) || !canManageRole(ctx.role, role)) throw new ForbiddenError('You cannot invite someone with that role.');
    const existingMember = await this.e.db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select('memberships.id')
      .where('memberships.workspace_id', '=', ctx.workspaceId)
      .where('users.email', '=', email)
      .executeTakeFirst();
    if (existingMember) throw new ConflictError('That person is already a member of this workspace.');
    const token = randomToken(32);
    const now = this.e.now();
    const row: Row<'invitations'> = {
      id: newId('inv'),
      workspace_id: ctx.workspaceId,
      email,
      role,
      token_hash: sha256(token),
      invited_by: actorUserId(ctx),
      expires_at: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000).toISOString(),
      accepted_at: null,
      revoked_at: null,
      created_at: now.toISOString(),
    };
    await this.e.db.insertInto('invitations').values(row).execute();
    const acceptUrl = `${this.e.config.appUrl}/invite/${token}`;
    await this.e.audit.record(ctx, 'member.invited', { type: 'invitation', id: row.id }, { role });
    const ws = await this.row(ctx.workspaceId);
    await this.e.system
      .sendSystemEmail(ctx.workspaceId, {
        to: email,
        subject: `You're invited to ${ws.name} on Morrow`,
        text: `${ctx.actor.label} invited you to join ${ws.name} on Morrow as ${role}.\n\nAccept the invitation: ${acceptUrl}\n\nThis link expires in ${INVITATION_TTL_DAYS} days.`,
        idempotencyKey: `invite:${row.id}`,
      })
      .catch((err) => this.e.log.warn('invitation e-mail not sent', { error: err as Error }));
    return { id: row.id, email, role, expiresAt: row.expires_at, createdAt: row.created_at, acceptedAt: null, acceptUrl };
  }

  async invitations(ctx: WorkspaceContext): Promise<InvitationDTO[]> {
    authorize(ctx, 'members:manage');
    const rows = await this.e.db
      .selectFrom('invitations')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', this.e.nowIso())
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({ id: r.id, email: r.email, role: r.role as Role, expiresAt: r.expires_at, createdAt: r.created_at, acceptedAt: r.accepted_at }));
  }

  async revokeInvitation(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'members:manage');
    await this.e.db.updateTable('invitations').set({ revoked_at: this.e.nowIso() }).where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).execute();
    await this.e.audit.record(ctx, 'member.invitation_revoked', { type: 'invitation', id });
  }

  async inspectInvitation(token: string): Promise<{ workspaceName: string; email: string; role: Role; userExists: boolean } | null> {
    const inv = await this.findInvitation(token);
    if (!inv) return null;
    const ws = await this.row(inv.workspace_id);
    const user = await this.e.db.selectFrom('users').select('id').where('email', '=', inv.email).executeTakeFirst();
    return { workspaceName: ws.name, email: inv.email, role: inv.role as Role, userExists: Boolean(user) };
  }

  private async findInvitation(token: string): Promise<Row<'invitations'> | null> {
    if (!token || token.length > 200) return null;
    const inv = await this.e.db.selectFrom('invitations').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirst();
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= this.e.nowIso() || !isRole(inv.role)) return null;
    return inv;
  }

  /**
   * Accept an invitation, either as an existing signed-in user (whose e-mail
   * must match) or by creating a new account.
   */
  async acceptInvitation(
    token: string,
    who: { userId: string } | { name: string; password: string },
  ): Promise<{ userId: string; workspaceId: string }> {
    const inv = await this.findInvitation(token);
    if (!inv) throw new PreconditionError('This invitation is invalid or has expired.');
    let userId: string;
    if ('userId' in who) {
      const user = await this.e.db.selectFrom('users').selectAll().where('id', '=', who.userId).executeTakeFirstOrThrow();
      if (user.email !== inv.email) throw new ForbiddenError(`This invitation was sent to ${inv.email}. Sign in with that account.`);
      userId = user.id;
    } else {
      const user = await this.e.auth.createUser({ email: inv.email, name: who.name, password: who.password });
      userId = user.id;
    }
    const now = this.e.nowIso();
    await this.e.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('memberships')
        .values({ id: newId('mem'), workspace_id: inv.workspace_id, user_id: userId, role: inv.role, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx.updateTable('invitations').set({ accepted_at: now }).where('id', '=', inv.id).execute();
    });
    const user = await this.e.db.selectFrom('users').select(['id', 'name']).where('id', '=', userId).executeTakeFirstOrThrow();
    await this.e.audit.record(
      { workspaceId: inv.workspace_id, role: inv.role as Role, actor: { type: 'user', id: user.id, label: user.name } },
      'member.joined',
      { type: 'invitation', id: inv.id },
      { role: inv.role },
    );
    return { userId, workspaceId: inv.workspace_id };
  }

  // ---------------------------------------------------------------- API keys

  async apiKeys(ctx: WorkspaceContext): Promise<ApiKeyDTO[]> {
    authorize(ctx, 'api_keys:manage');
    const rows = await this.e.db.selectFrom('api_keys').selectAll().where('workspace_id', '=', ctx.workspaceId).orderBy('created_at', 'desc').execute();
    return rows.map(toApiKeyDTO);
  }

  async createApiKey(ctx: WorkspaceContext, input: { name: string; role: Role; expiresInDays?: number | null }): Promise<CreatedApiKeyDTO> {
    authorize(ctx, 'api_keys:manage');
    const userId = requireUser(ctx);
    const name = (input.name ?? '').trim().slice(0, 80);
    if (!name) throw new ValidationError('Name the API key.', [{ path: 'name', message: 'Required.' }]);
    if (!isRole(input.role)) throw new ValidationError('Unknown role.', [{ path: 'role', message: 'Unknown role.' }]);
    // A key can never have more power than the person creating it.
    const role = minRole(input.role, ctx.role);
    const { key, prefix, hash } = generateApiKey();
    const now = this.e.now();
    const row: Row<'api_keys'> = {
      id: newId('key'),
      workspace_id: ctx.workspaceId,
      name,
      prefix,
      key_hash: hash,
      role,
      created_by: userId,
      last_used_at: null,
      expires_at: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString() : null,
      revoked_at: null,
      created_at: now.toISOString(),
    };
    await this.e.db.insertInto('api_keys').values(row).execute();
    await this.e.audit.record(ctx, 'api_key.created', { type: 'api_key', id: row.id }, { name, role });
    return { ...toApiKeyDTO(row), key };
  }

  async revokeApiKey(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'api_keys:manage');
    const res = await this.e.db
      .updateTable('api_keys')
      .set({ revoked_at: this.e.nowIso() })
      .where('id', '=', id)
      .where('workspace_id', '=', ctx.workspaceId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) === 0) throw new NotFoundError('API key', id);
    await this.e.audit.record(ctx, 'api_key.revoked', { type: 'api_key', id });
  }
}

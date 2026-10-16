import {
  ConflictError,
  ForbiddenError,
  isRole,
  isValidEmail,
  newId,
  normalizeEmail,
  NotFoundError,
  permissionsFor,
  randomToken,
  UnauthorizedError,
  ValidationError,
  type Role,
  type SessionInfoDTO,
  type UserDTO,
  type WorkspaceSummaryDTO,
} from '@morrow/core';
import type { Row } from '@morrow/db';
import { hashPassword, sha256, verifyPassword } from '../crypto';
import type { Engine } from '../engine';
import { toWorkspaceDTO } from './workspaces';

export const MIN_PASSWORD_LENGTH = 10;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
// Used to keep login timing similar whether or not the account exists.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface ResolvedSession {
  session: Row<'sessions'>;
  user: Row<'users'>;
}

export interface ResolvedApiKey {
  key: Row<'api_keys'>;
  role: Role;
  workspaceId: string;
}

export function toUserDTO(u: Row<'users'>): UserDTO {
  return { id: u.id, email: u.email, name: u.name, createdAt: u.created_at };
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`, [
      { path: 'password', message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
    ]);
  }
  if (password.length > 200) throw new ValidationError('Password is too long.', [{ path: 'password', message: 'Too long.' }]);
  return password;
}

/** API keys look like `mrw_<8-char prefix>_<secret>`; only the SHA-256 is stored. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const key = `mrw_${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: sha256(key) };
}

export class AuthService {
  constructor(private readonly e: Engine) {}

  async userCount(): Promise<number> {
    const r = await this.e.db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  async signupAllowed(): Promise<boolean> {
    return this.e.config.allowPublicSignup || (await this.userCount()) === 0;
  }

  async createUser(input: { email: string; name: string; password: string }): Promise<Row<'users'>> {
    const email = normalizeEmail(input.email);
    if (!email) throw new ValidationError('Enter a valid e-mail address.', [{ path: 'email', message: 'Invalid e-mail address.' }]);
    const name = (input.name ?? '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Enter your name.', [{ path: 'name', message: 'Required.' }]);
    validatePassword(input.password);
    const existing = await this.e.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) throw new ConflictError('An account with this e-mail already exists. Sign in instead.');
    const now = this.e.nowIso();
    const row = {
      id: newId('usr'),
      email,
      name,
      password_hash: await hashPassword(input.password),
      created_at: now,
      updated_at: now,
      last_login_at: now,
    };
    await this.e.db.insertInto('users').values(row).execute();
    return row;
  }

  /** Create an account plus its first workspace (the user becomes owner). */
  async signup(
    input: { email: string; name: string; password: string; workspaceName: string; timezone?: string },
    meta: SessionMeta = {},
  ): Promise<{ token: string; user: Row<'users'>; workspaceId: string }> {
    if (!(await this.signupAllowed())) {
      throw new ForbiddenError('Sign-up is closed on this Morrow installation. Ask an administrator for an invitation.');
    }
    const user = await this.createUser(input);
    const ws = await this.e.workspaces.create(user, { name: input.workspaceName, timezone: input.timezone });
    const token = await this.createSession(user.id, ws.id, meta);
    return { token, user, workspaceId: ws.id };
  }

  async login(emailInput: string, password: string, meta: SessionMeta = {}): Promise<{ token: string; user: Row<'users'> }> {
    const email = normalizeEmail(emailInput) ?? '';
    const user = email ? await this.e.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst() : undefined;
    const ok = await verifyPassword(password ?? '', user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedError('Incorrect e-mail or password.');
    const membership = await this.e.db
      .selectFrom('memberships')
      .select('workspace_id')
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    const now = this.e.nowIso();
    await this.e.db.updateTable('users').set({ last_login_at: now }).where('id', '=', user.id).execute();
    const token = await this.createSession(user.id, membership?.workspace_id ?? null, meta);
    return { token, user };
  }

  async createSession(userId: string, workspaceId: string | null, meta: SessionMeta = {}): Promise<string> {
    const token = randomToken(32);
    const now = this.e.now();
    await this.e.db
      .insertInto('sessions')
      .values({
        id: newId('ses'),
        user_id: userId,
        token_hash: sha256(token),
        csrf_token: randomToken(24),
        workspace_id: workspaceId,
        ip: meta.ip ?? null,
        user_agent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.e.config.sessionTtlDays * 86_400_000).toISOString(),
      })
      .execute();
    return token;
  }

  async resolveSession(token: string | null | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const session = await this.e.db.selectFrom('sessions').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirst();
    if (!session) return null;
    const now = this.e.now();
    if (session.expires_at <= now.toISOString()) {
      await this.e.db.deleteFrom('sessions').where('id', '=', session.id).execute();
      return null;
    }
    const user = await this.e.db.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirst();
    if (!user) return null;
    if (now.getTime() - Date.parse(session.last_seen_at) > SESSION_TOUCH_INTERVAL_MS) {
      // Sliding expiry, throttled to avoid a write on every request.
      const expires = new Date(now.getTime() + this.e.config.sessionTtlDays * 86_400_000).toISOString();
      await this.e.db.updateTable('sessions').set({ last_seen_at: now.toISOString(), expires_at: expires }).where('id', '=', session.id).execute();
    }
    return { session, user };
  }

  async logout(token: string): Promise<void> {
    await this.e.db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute();
  }

  /** Role of a user in a workspace, or null when not a member. */
  async roleIn(userId: string, workspaceId: string): Promise<Role | null> {
    const m = await this.e.db
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', userId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return m && isRole(m.role) ? m.role : null;
  }

  async switchWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<void> {
    if (!(await this.roleIn(userId, workspaceId))) throw new ForbiddenError('You are not a member of that workspace.');
    await this.e.db.updateTable('sessions').set({ workspace_id: workspaceId }).where('id', '=', sessionId).execute();
  }

  async sessionInfo(resolved: ResolvedSession): Promise<SessionInfoDTO> {
    const { session, user } = resolved;
    const workspaces = await this.e.workspaces.listForUser(user.id);
    let current: WorkspaceSummaryDTO | null = workspaces.find((w) => w.id === session.workspace_id) ?? workspaces[0] ?? null;
    if (current && current.id !== session.workspace_id) {
      await this.e.db.updateTable('sessions').set({ workspace_id: current.id }).where('id', '=', session.id).execute();
    }
    const ws = current ? await this.e.db.selectFrom('workspaces').selectAll().where('id', '=', current.id).executeTakeFirst() : undefined;
    if (!ws) current = null;
    return {
      user: toUserDTO(user),
      workspace: ws ? toWorkspaceDTO(ws) : null,
      workspaces,
      role: current?.role ?? null,
      permissions: current ? permissionsFor(current.role) : [],
      csrfToken: session.csrf_token,
    };
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string, keepSessionId?: string): Promise<void> {
    const user = await this.e.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(currentPassword, user.password_hash))) throw new UnauthorizedError('Your current password is incorrect.');
    validatePassword(nextPassword);
    await this.e.db
      .updateTable('users')
      .set({ password_hash: await hashPassword(nextPassword), updated_at: this.e.nowIso() })
      .where('id', '=', userId)
      .execute();
    let del = this.e.db.deleteFrom('sessions').where('user_id', '=', userId);
    if (keepSessionId) del = del.where('id', '!=', keepSessionId);
    await del.execute();
  }

  /** Operator reset from the CLI (no current password): set a new one and end every session. */
  async adminResetPassword(emailInput: string, nextPassword: string): Promise<Row<'users'>> {
    const email = normalizeEmail(emailInput) ?? '';
    const user = email ? await this.e.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst() : undefined;
    if (!user) throw new NotFoundError('User', emailInput);
    validatePassword(nextPassword);
    await this.e.db.updateTable('users').set({ password_hash: await hashPassword(nextPassword), updated_at: this.e.nowIso() }).where('id', '=', user.id).execute();
    await this.e.db.deleteFrom('sessions').where('user_id', '=', user.id).execute();
    return user;
  }

  /** Resolve a raw API key to its workspace and role (null when invalid, revoked or expired). */
  async resolveApiKey(raw: string | null | undefined): Promise<ResolvedApiKey | null> {
    if (!raw || !raw.startsWith('mrw_') || raw.length > 200) return null;
    const key = await this.e.db.selectFrom('api_keys').selectAll().where('key_hash', '=', sha256(raw)).executeTakeFirst();
    if (!key || key.revoked_at) return null;
    const now = this.e.now();
    if (key.expires_at && key.expires_at <= now.toISOString()) return null;
    if (!isRole(key.role)) return null;
    if (!key.last_used_at || now.getTime() - Date.parse(key.last_used_at) > SESSION_TOUCH_INTERVAL_MS) {
      await this.e.db.updateTable('api_keys').set({ last_used_at: now.toISOString() }).where('id', '=', key.id).execute();
    }
    return { key, role: key.role, workspaceId: key.workspace_id };
  }

  async pruneSessions(): Promise<number> {
    const res = await this.e.db.deleteFrom('sessions').where('expires_at', '<=', this.e.nowIso()).executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }

  isValidEmail(email: string): boolean {
    return isValidEmail(email);
  }
}

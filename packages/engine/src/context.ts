import { assertCan, ForbiddenError, type Permission, type Role } from '@morrow/core';

export type ActorType = 'user' | 'api_key' | 'system';

export interface Actor {
  type: ActorType;
  id: string | null;
  label: string;
}

/**
 * Everything a service call needs to know about *who* is acting and *where*.
 * Every query is scoped by `workspaceId`; every mutation is permission-checked
 * against `role`.
 */
export interface WorkspaceContext {
  workspaceId: string;
  role: Role;
  actor: Actor;
  ip?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'Morrow' };

/** Context used by background jobs. System actors act with owner rights inside one workspace. */
export function systemContext(workspaceId: string, label = 'Morrow'): WorkspaceContext {
  return { workspaceId, role: 'owner', actor: { type: 'system', id: null, label } };
}

export function authorize(ctx: WorkspaceContext, permission: Permission): void {
  assertCan(ctx.role, permission);
}

export function requireUser(ctx: WorkspaceContext): string {
  if (ctx.actor.type !== 'user' || !ctx.actor.id) throw new ForbiddenError('This action must be performed by a signed-in user.');
  return ctx.actor.id;
}

export function actorUserId(ctx: WorkspaceContext): string | null {
  return ctx.actor.type === 'user' ? ctx.actor.id : null;
}

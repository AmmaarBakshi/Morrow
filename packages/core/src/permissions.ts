/**
 * Role-based access control. Permissions are checked in the service layer so
 * the web app, the API, the CLI and background jobs share the same rules.
 */
import { ForbiddenError } from './errors';

export const ROLES = ['owner', 'admin', 'manager', 'analyst'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  manager: 'Campaign manager',
  analyst: 'Read-only analyst',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full control, including members, billing-level settings and deleting the workspace.',
  admin: 'Manage settings, integrations, members, approvals and automatic delivery.',
  manager: 'Manage contacts, templates, segments, automations and campaigns.',
  analyst: 'Read-only access to contacts, content and analytics. Cannot export or send.',
};

export const PERMISSIONS = [
  'workspace:read',
  'workspace:manage',
  'workspace:delete',
  'members:manage',
  'integrations:manage',
  'api_keys:manage',
  'audit:read',
  'contacts:read',
  'contacts:write',
  'contacts:import',
  'contacts:export',
  'contacts:erase',
  'segments:read',
  'segments:write',
  'templates:read',
  'templates:write',
  'templates:publish',
  'automations:read',
  'automations:write',
  'automations:activate',
  'automations:approve_auto',
  'campaigns:read',
  'campaigns:write',
  'campaigns:launch',
  'campaigns:approve',
  'messages:read',
  'messages:approve',
  'messages:test',
  'analytics:read',
  'suppressions:read',
  'suppressions:manage',
  'tasks:read',
  'tasks:write',
  'ai:use',
  'system:read',
  'system:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = [
  'workspace:read',
  'contacts:read',
  'segments:read',
  'templates:read',
  'automations:read',
  'campaigns:read',
  'messages:read',
  'analytics:read',
  'suppressions:read',
  'tasks:read',
  'system:read',
];

const MANAGER: Permission[] = [
  ...READ,
  'contacts:write',
  'contacts:import',
  'contacts:export',
  'segments:write',
  'templates:write',
  'templates:publish',
  'automations:write',
  'automations:activate',
  'campaigns:write',
  'campaigns:launch',
  'messages:approve',
  'messages:test',
  'suppressions:manage',
  'tasks:write',
  'ai:use',
];

const ADMIN: Permission[] = [
  ...MANAGER,
  'workspace:manage',
  'members:manage',
  'integrations:manage',
  'api_keys:manage',
  'audit:read',
  'contacts:erase',
  'automations:approve_auto',
  'campaigns:approve',
  'system:manage',
];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([...ADMIN, 'workspace:delete']),
  admin: new Set(ADMIN),
  manager: new Set(MANAGER),
  analyst: new Set(READ),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(`Your role (${ROLE_LABELS[role]}) cannot perform "${permission}".`);
  }
}

const RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, analyst: 1 };

/** True when `actor` may assign or remove `target` (no one can manage a higher role). */
export function canManageRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'members:manage')) return false;
  if (target === 'owner') return actor === 'owner';
  return RANK[actor] >= RANK[target];
}

/** The lower of two roles — API keys can never exceed their creator. */
export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}

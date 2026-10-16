import { describe, expect, it } from 'vitest';
import { assertCan, can, canManageRole, minRole, PERMISSIONS, ROLES } from '../src/permissions';
import { ForbiddenError } from '../src/errors';

describe('permissions', () => {
  it('gives owners every permission', () => {
    for (const p of PERMISSIONS) expect(can('owner', p), p).toBe(true);
  });

  it('keeps analysts read-only', () => {
    expect(can('analyst', 'contacts:read')).toBe(true);
    expect(can('analyst', 'analytics:read')).toBe(true);
    for (const p of PERMISSIONS.filter((x) => !x.endsWith(':read'))) expect(can('analyst', p), p).toBe(false);
  });

  it('lets campaign managers work but not change security-sensitive settings', () => {
    expect(can('manager', 'campaigns:launch')).toBe(true);
    expect(can('manager', 'contacts:import')).toBe(true);
    expect(can('manager', 'automations:activate')).toBe(true);
    expect(can('manager', 'automations:approve_auto')).toBe(false);
    expect(can('manager', 'integrations:manage')).toBe(false);
    expect(can('manager', 'members:manage')).toBe(false);
    expect(can('manager', 'contacts:erase')).toBe(false);
    expect(can('manager', 'audit:read')).toBe(false);
  });

  it('only allows owners to delete the workspace', () => {
    expect(ROLES.filter((r) => can(r, 'workspace:delete'))).toEqual(['owner']);
  });

  it('throws a ForbiddenError with a helpful message', () => {
    expect(() => assertCan('analyst', 'contacts:write')).toThrow(ForbiddenError);
    expect(() => assertCan('analyst', 'contacts:write')).toThrow(/Read-only analyst/);
    expect(() => assertCan('admin', 'contacts:write')).not.toThrow();
  });

  it('prevents managing higher roles', () => {
    expect(canManageRole('owner', 'owner')).toBe(true);
    expect(canManageRole('admin', 'owner')).toBe(false);
    expect(canManageRole('admin', 'admin')).toBe(true);
    expect(canManageRole('manager', 'analyst')).toBe(false);
    expect(minRole('admin', 'analyst')).toBe('analyst');
    expect(minRole('owner', 'manager')).toBe('manager');
  });
});

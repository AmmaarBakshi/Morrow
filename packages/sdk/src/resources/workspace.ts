import type { ApiKeyDTO, AuditLogDTO, CreatedApiKeyDTO, DashboardDTO, InvitationDTO, MemberDTO, Role, WorkspaceDTO, WorkspaceSettingsInput } from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, Range } from '../types';

export class WorkspaceApi {
  constructor(private readonly t: Transport) {}

  get(): Promise<WorkspaceDTO> {
    return this.t.json('GET', '/workspace');
  }

  update(input: { name?: string; timezone?: string; settings?: Partial<WorkspaceSettingsInput> }): Promise<WorkspaceDTO> {
    return this.t.json('PATCH', '/workspace', { body: input });
  }

  /** Permanently delete the workspace. Requires the slug as confirmation. */
  delete(confirmSlug: string): Promise<Ok> {
    return this.t.json('DELETE', '/workspace', { body: { confirmSlug } });
  }

  dashboard(range: Range = {}): Promise<DashboardDTO> {
    return this.t.json('GET', '/dashboard', { query: { ...range } });
  }

  members(): Promise<Items<MemberDTO>> {
    return this.t.json('GET', '/members');
  }

  updateMember(id: string, role: Role): Promise<Ok> {
    return this.t.json('PATCH', `/members/${id}`, { body: { role } });
  }

  removeMember(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/members/${id}`);
  }

  invitations(): Promise<Items<InvitationDTO>> {
    return this.t.json('GET', '/invitations');
  }

  invite(email: string, role: Role): Promise<InvitationDTO> {
    return this.t.json('POST', '/invitations', { body: { email, role } });
  }

  revokeInvitation(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/invitations/${id}`);
  }

  apiKeys(): Promise<Items<ApiKeyDTO>> {
    return this.t.json('GET', '/api-keys');
  }

  /** The full key is only returned here, once. */
  createApiKey(input: { name: string; role: Role; expiresInDays?: number | null }): Promise<CreatedApiKeyDTO> {
    return this.t.json('POST', '/api-keys', { body: input });
  }

  revokeApiKey(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/api-keys/${id}`);
  }

  audit(filter: { entityType?: string; entityId?: string; action?: string; before?: string; limit?: number } = {}): Promise<Items<AuditLogDTO>> {
    return this.t.json('GET', '/audit', { query: filter });
  }
}

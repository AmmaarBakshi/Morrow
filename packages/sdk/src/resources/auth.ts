import type { AuthResultDTO, Role, SessionInfoDTO, SetupStatusDTO, WhoAmIDTO } from '@morrow/core';
import type { Transport } from '../http';

export interface InvitationInfo {
  workspaceName: string;
  email: string;
  role: Role;
  userExists: boolean;
}

export class AuthApi {
  constructor(private readonly t: Transport) {}

  setup(): Promise<SetupStatusDTO> {
    return this.t.json('GET', '/auth/setup');
  }

  /** Sign in. With `issueToken`, the session token is returned (and no cookie is set). */
  login(input: { email: string; password: string; issueToken?: boolean }): Promise<AuthResultDTO> {
    return this.t.json('POST', '/auth/login', { body: input });
  }

  signup(input: { email: string; name: string; password: string; workspaceName: string; timezone?: string; issueToken?: boolean }): Promise<AuthResultDTO> {
    return this.t.json('POST', '/auth/signup', { body: input });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.t.json('POST', '/auth/logout');
  }

  session(): Promise<SessionInfoDTO> {
    return this.t.json('GET', '/auth/session');
  }

  /** Works for sessions and API keys alike. */
  whoami(): Promise<WhoAmIDTO> {
    return this.t.json('GET', '/auth/whoami');
  }

  switchWorkspace(workspaceId: string): Promise<SessionInfoDTO> {
    return this.t.json('POST', '/auth/switch-workspace', { body: { workspaceId } });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.t.json('POST', '/auth/password', { body: { currentPassword, newPassword } });
  }

  createWorkspace(input: { name: string; timezone?: string; companyName?: string }): Promise<SessionInfoDTO> {
    return this.t.json('POST', '/auth/workspaces', { body: input });
  }

  invitation(token: string): Promise<InvitationInfo> {
    return this.t.json('GET', `/auth/invitations/${encodeURIComponent(token)}`);
  }

  acceptInvitation(token: string, input: { name?: string; password?: string; issueToken?: boolean } = {}): Promise<AuthResultDTO> {
    return this.t.json('POST', `/auth/invitations/${encodeURIComponent(token)}/accept`, { body: input });
  }
}

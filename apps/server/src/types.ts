import type { Engine, WorkspaceContext } from '@morrow/engine';
import type { RateLimiter } from './http/rate-limit';

/** Who is calling: a signed-in person (cookie or bearer session) or an API key. */
export type Principal =
  | {
      kind: 'session';
      via: 'cookie' | 'bearer';
      token: string;
      sessionId: string;
      userId: string;
      userName: string;
      workspaceId: string | null;
      csrfToken: string;
    }
  | {
      kind: 'api_key';
      keyId: string;
      keyName: string;
      workspaceId: string;
      role: WorkspaceContext['role'];
    };

export type AppEnv = {
  Variables: {
    requestId: string;
    ip: string | null;
    principal: Principal | null;
    /** Set for routes scoped to a workspace. */
    ctx: WorkspaceContext;
  };
};

export interface ServerOptions {
  engine: Engine;
  /** Directory with the built web app (index.html + assets). Omit to serve the API only. */
  webDist?: string | null;
  /** Honour X-Forwarded-For / X-Real-IP (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Bearer token required for /metrics. Without it, /metrics is only served outside production. */
  metricsToken?: string | null;
  limiter?: RateLimiter;
  /** Reads the socket address (provided by the Node adapter). */
  socketIp?: (raw: Request, env: unknown) => string | null;
}

export const SESSION_COOKIE = 'morrow_session';
export const CSRF_HEADER = 'x-csrf-token';
export const WORKSPACE_HEADER = 'x-morrow-workspace';

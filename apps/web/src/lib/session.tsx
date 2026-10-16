import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Permission, SessionInfoDTO } from '@morrow/sdk';
import { api, isApiError, setCsrfToken } from './api';

interface SessionState {
  session: SessionInfoDTO | null;
  loading: boolean;
  can(permission: Permission): boolean;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
  switchWorkspace(id: string): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        const s = await api.auth.session();
        setCsrfToken(s.csrfToken);
        return s;
      } catch (err) {
        if (isApiError(err, 401) || isApiError(err, 412)) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const value = useMemo<SessionState>(() => {
    const session = query.data ?? null;
    const permissions = new Set(session?.permissions ?? []);
    return {
      session,
      loading: query.isLoading,
      can: (p) => permissions.has(p),
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ['session'] });
      },
      signOut: async () => {
        await api.auth.logout().catch(() => undefined);
        setCsrfToken(null);
        qc.clear();
        qc.setQueryData(['session'], null);
      },
      switchWorkspace: async (id) => {
        const s = await api.auth.switchWorkspace(id);
        setCsrfToken(s.csrfToken);
        qc.clear();
        qc.setQueryData(['session'], s);
      },
    };
  }, [query.data, query.isLoading, qc]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** The signed-in workspace session (only used under the authenticated layout). */
export function useWorkspace() {
  const { session } = useSession();
  if (!session?.workspace) throw new Error('No workspace in session');
  return { workspace: session.workspace, user: session.user, role: session.role! };
}

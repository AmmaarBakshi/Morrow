import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { Loading } from './components/ui/display';
import { useSession } from './lib/session';

const page = (load: () => Promise<{ default: React.ComponentType }>) => {
  const C = lazy(load);
  return <C />;
};

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <Loading label="Opening Morrow…" />;
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!session.workspace) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

function Standalone({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  { path: '/login', element: <Standalone>{page(() => import('./pages/auth/LoginPage'))}</Standalone> },
  { path: '/setup', element: <Standalone>{page(() => import('./pages/auth/SetupPage'))}</Standalone> },
  { path: '/invite/:token', element: <Standalone>{page(() => import('./pages/auth/InvitePage'))}</Standalone> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: page(() => import('./pages/OverviewPage')) },
      { path: 'contacts', element: page(() => import('./pages/contacts/ContactsPage')) },
      { path: 'contacts/import', element: page(() => import('./pages/contacts/ImportPage')) },
      { path: 'contacts/:id', element: page(() => import('./pages/contacts/ContactDetailPage')) },
      { path: 'segments', element: page(() => import('./pages/segments/SegmentsPage')) },
      { path: 'segments/:id', element: page(() => import('./pages/segments/SegmentEditorPage')) },
      { path: 'templates', element: page(() => import('./pages/templates/TemplatesPage')) },
      { path: 'templates/:id', element: page(() => import('./pages/templates/TemplateEditorPage')) },
      { path: 'automations', element: page(() => import('./pages/automations/AutomationsPage')) },
      { path: 'automations/:id', element: page(() => import('./pages/automations/AutomationBuilderPage')) },
      { path: 'campaigns', element: page(() => import('./pages/campaigns/CampaignsPage')) },
      { path: 'campaigns/:id', element: page(() => import('./pages/campaigns/CampaignPage')) },
      { path: 'calendar', element: page(() => import('./pages/CalendarPage')) },
      { path: 'analytics', element: page(() => import('./pages/AnalyticsPage')) },
      { path: 'approvals', element: page(() => import('./pages/ApprovalsPage')) },
      { path: 'tasks', element: page(() => import('./pages/TasksPage')) },
      { path: 'settings', element: <Navigate to="/settings/workspace" replace /> },
      { path: 'settings/:section', element: page(() => import('./pages/settings/SettingsPage')) },
      { path: '*', element: page(() => import('./pages/NotFoundPage')) },
    ],
  },
]);

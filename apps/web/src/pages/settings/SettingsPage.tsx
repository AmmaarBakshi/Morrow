import clsx from 'clsx';
import type { ReactNode } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { PageHeader } from '../../components/ui/display';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { SendingSettings } from './SendingSettings';
import { AccountSettings, AiSettings, AuditSettings, SystemSettings } from './SystemSettings';
import { ApiKeySettings, TeamSettings } from './TeamSettings';
import { WorkspaceSettings } from './WorkspaceSettings';

const SECTIONS: Array<{ key: string; label: string; render: () => ReactNode; adminOnly?: boolean }> = [
  { key: 'workspace', label: 'Workspace', render: () => <WorkspaceSettings /> },
  { key: 'sending', label: 'Sending', render: () => <SendingSettings /> },
  { key: 'team', label: 'Team', render: () => <TeamSettings /> },
  { key: 'api-keys', label: 'API keys', render: () => <ApiKeySettings />, adminOnly: true },
  { key: 'ai', label: 'AI', render: () => <AiSettings /> },
  { key: 'audit', label: 'Audit log', render: () => <AuditSettings />, adminOnly: true },
  { key: 'system', label: 'System', render: () => <SystemSettings /> },
  { key: 'account', label: 'Account', render: () => <AccountSettings /> },
];

export default function SettingsPage() {
  const { section = 'workspace' } = useParams();
  const { can } = useSession();
  const current = SECTIONS.find((s) => s.key === section);
  useDocumentTitle(`Settings · ${current?.label ?? ''}`);
  if (!current) return <Navigate to="/settings/workspace" replace />;
  const admin = can('workspace:manage');
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[180px_1fr]">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.filter((s) => !s.adminOnly || admin).map((s) => (
            <NavLink key={s.key} to={`/settings/${s.key}`} className={({ isActive }) => clsx('whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-accent-soft text-accent-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">{current.render()}</div>
      </div>
    </>
  );
}

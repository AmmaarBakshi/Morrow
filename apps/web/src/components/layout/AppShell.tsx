import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart3,
  Bell,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  FileText,
  Filter,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Monitor,
  Moon,
  Settings,
  Sun,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { useSession, useWorkspace } from '../../lib/session';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { Avatar, Loading } from '../ui/display';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight text-ink">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <path d="M8 22V10l8 7 8-7v12" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Morrow
    </Link>
  );
}

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const order: ThemePreference[] = ['system', 'light', 'dark'];
  const icon = { system: <Monitor className="size-4" />, light: <Sun className="size-4" />, dark: <Moon className="size-4" /> }[preference];
  return (
    <button
      onClick={() => setPreference(order[(order.indexOf(preference) + 1) % order.length]!)}
      className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
      aria-label={`Theme: ${preference}. Click to change.`}
      title={`Theme: ${preference}`}
    >
      {icon}
    </button>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications.list({ limit: 20 }), refetchInterval: 60_000 });
  const unread = q.data?.unread ?? 0;
  const markAll = async () => {
    await api.notifications.markRead('all');
    await q.refetch();
  };
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
        <Bell className="size-4" />
        {unread ? <span className="absolute right-1 top-1 size-2 rounded-full bg-bad" /> : null}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <p className="text-sm font-semibold">Notifications</p>
              {unread ? (
                <button onClick={markAll} className="text-xs text-accent-text hover:underline">
                  Mark all read
                </button>
              ) : null}
            </div>
            <ul className="max-h-96 overflow-y-auto">
              {q.data?.items.length ? (
                q.data.items.map((n) => (
                  <li key={n.id} className={clsx('border-b border-line px-4 py-3 last:border-0', !n.readAt && 'bg-accent-soft/40')}>
                    {n.link ? (
                      <Link to={n.link} onClick={() => setOpen(false)} className="block text-sm font-medium text-ink hover:underline">
                        {n.title}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium text-ink">{n.title}</p>
                    )}
                    {n.body ? <p className="mt-0.5 text-xs text-ink-2">{n.body}</p> : null}
                    <p className="mt-1 text-[11px] text-muted">{formatRelative(n.createdAt)}</p>
                  </li>
                ))
              ) : (
                <li className="px-4 py-8 text-center text-sm text-muted">You're all caught up.</li>
              )}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}

function WorkspaceSwitcher() {
  const { session, switchWorkspace } = useSession();
  const navigate = useNavigate();
  if (!session || session.workspaces.length < 2) return <p className="truncate px-2 text-[13px] font-medium text-ink">{session?.workspace?.name}</p>;
  return (
    <select
      value={session.workspace?.id}
      onChange={async (e) => {
        await switchWorkspace(e.target.value);
        navigate('/');
      }}
      className="w-full truncate rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] font-medium text-ink"
      aria-label="Workspace"
    >
      {session.workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

export function AppShell() {
  const { signOut, can } = useSession();
  const { user, workspace } = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const approvals = useQuery({ queryKey: ['approvals', 'count'], queryFn: () => api.approvals.list({ pageSize: 1 }), refetchInterval: 60_000, enabled: can('messages:read') });

  const groups: Array<{ label?: string; items: NavItem[] }> = [
    {
      items: [
        { to: '/', label: 'Overview', icon: <LayoutDashboard className="size-4" /> },
        { to: '/contacts', label: 'Contacts', icon: <Users className="size-4" /> },
        { to: '/segments', label: 'Segments', icon: <Filter className="size-4" /> },
        { to: '/calendar', label: 'Calendar', icon: <CalendarDays className="size-4" /> },
      ],
    },
    {
      label: 'Engage',
      items: [
        { to: '/automations', label: 'Automations', icon: <Workflow className="size-4" /> },
        { to: '/campaigns', label: 'Campaigns', icon: <Megaphone className="size-4" /> },
        { to: '/templates', label: 'Templates', icon: <FileText className="size-4" /> },
        { to: '/approvals', label: 'Approvals', icon: <ClipboardCheck className="size-4" />, badge: approvals.data?.total },
      ],
    },
    {
      label: 'Insight',
      items: [
        { to: '/analytics', label: 'Analytics', icon: <BarChart3 className="size-4" /> },
        { to: '/tasks', label: 'Tasks', icon: <CheckSquare className="size-4" /> },
        { to: '/settings', label: 'Settings', icon: <Settings className="size-4" /> },
      ],
    },
  ];

  const sidebar = (
    <nav className="flex h-full flex-col gap-5 px-3 py-4" aria-label="Main">
      <div className="flex items-center justify-between">
        <Logo />
        <button className="text-muted lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>
      <WorkspaceSwitcher />
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {groups.map((g, i) => (
          <div key={i}>
            {g.label ? <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.label}</p> : null}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.to === '/'}
                    className={({ isActive }) =>
                      clsx('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition-colors', isActive ? 'bg-accent-soft text-accent-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
                    }
                  >
                    {it.icon}
                    <span className="flex-1">{it.label}</span>
                    {it.badge ? <span className="rounded-full bg-warn-soft px-1.5 text-[11px] font-semibold text-warn">{it.badge}</span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Avatar name={user.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{user.name}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
        </div>
        <button
          onClick={async () => {
            await signOut();
            navigate('/login');
          }}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-surface lg:block">{sidebar}</aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-2xl">{sidebar}</aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-6">
          <button className="-ml-1 inline-flex size-8 items-center justify-center rounded-lg text-ink-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <p className="truncate text-sm text-muted lg:hidden">{workspace.name}</p>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Notifications />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Activity, Database, Mail, RotateCcw, Sparkles, Timer } from 'lucide-react';
import { useState } from 'react';
import type { AuditLogDTO, JobDTO } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Badge, Card, CardHeader, Loading, Notice, Stat, StatusBadge } from '../../components/ui/display';
import { Field, Input, Select } from '../../components/ui/field';
import { DataTable } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, formatRelative, humanize } from '../../lib/format';
import { useAction, useDebounced } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';

export function SystemSettings() {
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState('');
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.system.health(), refetchInterval: 15_000 });
  const jobs = useQuery({ queryKey: ['jobs', status], queryFn: () => api.system.jobs({ status: status || undefined, limit: 100 }), refetchInterval: 15_000 });
  const retry = useAction((id: string) => api.system.retryJob(id), { success: 'Job re-queued', invalidate: [['jobs']] });
  const cancel = useAction((id: string) => api.system.cancelJob(id), { success: 'Job cancelled', invalidate: [['jobs']] });
  const h = health.data;
  return (
    <div className="flex flex-col gap-6">
      {h ? (
        <>
          {!h.scheduler.healthy ? <Notice tone="warn" title="The scheduler is not running">Birthdays, waits and scheduled campaigns will not fire until a scheduler process runs (<code className="font-mono">morrow start</code> or <code className="font-mono">morrow scheduler</code>).</Notice> : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Database" icon={<Database className="size-4" />} value={h.database.ok ? 'Healthy' : 'Down'} sub={`${h.database.dialect} · ${h.database.latencyMs} ms`} />
            <Stat label="Queue lag" icon={<Timer className="size-4" />} value={`${formatNumber(h.queue.lagSeconds)}s`} sub={`${formatNumber(h.queue.byStatus.queued ?? 0)} queued · ${formatNumber(h.queue.byStatus.dead ?? 0)} dead · ${formatNumber(h.queue.runningExpired)} stuck`} />
            <Stat label="Scheduler" icon={<Activity className="size-4" />} value={h.scheduler.healthy ? 'Running' : 'Not running'} sub={h.scheduler.lastTickAt ? `last tick ${formatRelative(h.scheduler.lastTickAt)}` : 'never ran'} />
            <Stat label="E-mail" icon={<Mail className="size-4" />} value={h.email.provider ?? 'None'} sub={`${humanize(h.email.source)} · Morrow ${h.version}`} />
          </div>
        </>
      ) : (
        <Loading />
      )}
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
          <div>
            <h2 className="text-[15px] font-semibold">Background jobs</h2>
            <p className="text-[13px] text-muted">Sends, automation steps, imports and webhooks for this workspace. Failed jobs retry with backoff; dead jobs need a look.</p>
          </div>
          <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Job status">
            <option value="">All statuses</option>
            {['queued', 'running', 'failed', 'dead', 'succeeded', 'cancelled'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        </div>
        <DataTable<JobDTO>
          rows={jobs.data?.items ?? []}
          rowKey={(j) => j.id}
          dim={jobs.isFetching}
          empty={<p className="pb-8 text-center text-sm text-muted">No jobs.</p>}
          columns={[
            { key: 'type', header: 'Job', cell: (j) => <span className="font-mono text-xs">{j.type}</span> },
            { key: 'status', header: 'Status', cell: (j) => <StatusBadge status={j.status} /> },
            { key: 'attempts', header: 'Attempts', cell: (j) => `${j.attempts}/${j.maxAttempts}` },
            { key: 'run', header: 'Runs at', cell: (j) => <span className="text-xs text-ink-2">{formatDateTime(j.runAt, workspace.timezone)}</span> },
            { key: 'error', header: 'Last error', cell: (j) => <span className="line-clamp-2 text-xs text-muted">{j.lastError ?? '—'}</span>, className: 'max-w-xs' },
            {
              key: 'actions',
              header: '',
              cell: (j) =>
                can('system:manage') ? (
                  j.status === 'dead' || j.status === 'failed' ? (
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => retry.mutate(j.id)}>Retry</Button>
                  ) : j.status === 'queued' ? (
                    <Button size="sm" variant="ghost" onClick={() => cancel.mutate(j.id)}>Cancel</Button>
                  ) : null
                ) : null,
            },
          ]}
        />
      </Card>
    </div>
  );
}

export function AuditSettings() {
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const [action, setAction] = useState('');
  const filter = useDebounced(action);
  const log = useQuery({ queryKey: ['audit', filter], queryFn: () => api.workspace.audit({ action: filter || undefined, limit: 200 }), enabled: can('audit:read') });
  if (!can('audit:read')) return <Notice>Only administrators can read the audit log.</Notice>;
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Audit log</h2>
          <p className="text-[13px] text-muted">Sends, approvals, consent changes, exports, permission and integration changes. Message bodies and secrets are never logged.</p>
        </div>
        <Input className="w-56" placeholder="Filter by action, e.g. campaign." value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter actions" />
      </div>
      <DataTable<AuditLogDTO>
        rows={log.data?.items ?? []}
        rowKey={(a) => a.id}
        dim={log.isFetching}
        empty={<p className="pb-8 text-center text-sm text-muted">No entries.</p>}
        columns={[
          { key: 'at', header: 'When', cell: (a) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(a.createdAt, workspace.timezone)}</span> },
          { key: 'who', header: 'Who', cell: (a) => <span className="text-sm">{a.actorLabel ?? a.actorType} <Badge className="ml-1">{a.actorType.replace('_', ' ')}</Badge></span> },
          { key: 'action', header: 'Action', cell: (a) => <span className="font-mono text-xs">{a.action}</span> },
          { key: 'entity', header: 'Entity', cell: (a) => (a.entityType ? <span className="font-mono text-[11px] text-muted">{a.entityType}:{a.entityId}</span> : '—') },
          { key: 'meta', header: 'Details', cell: (a) => <span className="line-clamp-2 font-mono text-[11px] text-muted">{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}</span>, className: 'max-w-xs' },
        ]}
      />
    </Card>
  );
}

export function AiSettings() {
  const { can } = useSession();
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.integrations.ai() });
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const save = useAction(() => api.integrations.setAi({ provider: 'anthropic', config: { model: model || undefined }, secrets: apiKey ? { apiKey } : {} }), { success: 'AI assistance enabled', invalidate: [['ai-status']], onSuccess: () => setApiKey('') });
  const disable = useAction(() => api.integrations.setAi({ provider: null }), { success: 'AI assistance turned off', invalidate: [['ai-status']] });
  if (!ai.data) return <Loading />;
  const editable = can('integrations:manage');
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4" /> AI writing assistance</span>} description="Optional. Drafts templates, rewrites copy, suggests subject lines and summarises campaign results." action={<StatusBadge status={ai.data.enabled ? 'active' : 'draft'} label={ai.data.enabled ? `On · ${ai.data.model ?? ai.data.provider}` : 'Off'} />} />
        <ul className="mb-4 flex flex-col gap-1.5 text-sm text-ink-2">
          <li>• AI never receives contact names, addresses or any personal data — only your instructions and the template text.</li>
          <li>• Output is always a draft. A person reviews, saves and publishes; AI never sends e-mail.</li>
          <li>• Everything else in Morrow works without it.</li>
        </ul>
        {editable ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Anthropic API key" hint={ai.data.enabled ? 'Saved — enter a new key to replace it.' : 'From console.anthropic.com. Stored encrypted.'}>{(id) => <Input id={id} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={ai.data.enabled ? '••••••••' : 'sk-ant-…'} />}</Field>
            <Field label="Model (optional)" hint="Leave empty for the default.">{(id) => <Input id={id} value={model} onChange={(e) => setModel(e.target.value)} placeholder={ai.data.model ?? 'claude-opus-5-5'} />}</Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="primary" disabled={!apiKey && !ai.data.enabled} loading={save.isPending} onClick={() => save.mutate(undefined)}>{ai.data.enabled ? 'Update' : 'Enable AI assistance'}</Button>
              {ai.data.enabled ? <Button variant="ghost" loading={disable.isPending} onClick={() => disable.mutate(undefined)}>Turn off</Button> : null}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export function AccountSettings() {
  const { user } = useWorkspace();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useAction(() => api.auth.changePassword(current, next), { success: 'Password changed. Other sessions were signed out.', onSuccess: () => (setCurrent(''), setNext('')) });
  return (
    <Card className="max-w-xl">
      <CardHeader title="Your account" description={`${user.name} · ${user.email}`} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(undefined);
        }}
      >
        <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="New password" hint="At least 10 characters.">{(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" className="self-start" disabled={!current || next.length < 10} loading={change.isPending}>Change password</Button>
      </form>
    </Card>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, Pause, Play, Send, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { CampaignDTO, CampaignRecipientDTO, MessageCategory, PreflightDTO } from '@morrow/core';
import { BarList } from '../../components/charts/BarList';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Card, CardHeader, ErrorState, Loading, Notice, PageHeader, Stat, StatusBadge, Tabs } from '../../components/ui/display';
import { Field, Input, Select } from '../../components/ui/field';
import { DataTable, Pagination } from '../../components/ui/table';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatNumber, formatPercent, humanize } from '../../lib/format';
import { useAction, useDocumentTitle } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';

const REASONS: Record<string, string> = {
  no_email: 'No e-mail address',
  invalid_email: 'Invalid or bouncing address',
  suppressed: 'Suppressed (bounce, complaint or manual)',
  unsubscribed: 'Unsubscribed or consent withdrawn',
  consent_missing: 'No consent for this kind of e-mail',
  frequency_cap: 'Frequency cap reached',
  duplicate: 'Duplicate address',
};

function Preflight({ p }: { p: PreflightDTO }) {
  const excluded = Object.entries(p.excluded).filter(([, n]) => n);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="text-xs text-muted">In the segment</p>
          <p className="text-2xl font-semibold">{formatNumber(p.audience)}</p>
        </div>
        <div className="rounded-lg bg-good-soft p-3">
          <p className="text-xs text-good">Will receive it</p>
          <p className="text-2xl font-semibold text-ink">{formatNumber(p.eligible)}</p>
        </div>
      </div>
      {excluded.length ? (
        <div>
          <p className="mb-2 text-[13px] font-medium">Excluded, and why</p>
          <BarList label="Excluded contacts by reason" color="var(--series-2)" items={excluded.map(([k, n]) => ({ key: k, label: REASONS[k] ?? humanize(k), value: n! }))} />
        </div>
      ) : null}
      {p.missingPersonalization.map((m) => (
        <Notice key={m.variable} tone="warn">
          {formatNumber(m.contacts)} contact(s) have no <code className="font-mono">{`{{${m.variable}}}`}</code> — {m.handledBy === 'fallback' ? 'the fallback text is used' : m.handledBy === 'skip' ? 'they will be skipped' : 'it is left blank'}.
        </Notice>
      ))}
      {p.warnings.map((w) => <Notice key={w} tone="warn" icon={<AlertTriangle className="size-4" />}>{w}</Notice>)}
      {p.blockers.map((b) => <Notice key={b} tone="bad" icon={<XCircle className="size-4" />}>{b}</Notice>)}
      {p.ok && !p.blockers.length ? <Notice tone="good" icon={<CheckCircle2 className="size-4" />}>Ready to send.</Notice> : null}
    </div>
  );
}

function Setup({ c, onSaved }: { c: CampaignDTO; onSaved(): void }) {
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.segments.list() });
  const templates = useQuery({ queryKey: ['templates', 'published'], queryFn: () => api.templates.list({ status: 'published' }) });
  const senders = useQuery({ queryKey: ['senders'], queryFn: () => api.senders.list() });
  const [form, setForm] = useState({ name: c.name, segmentId: c.segmentId ?? '', templateId: c.templateId ?? '', senderId: c.senderId ?? '', subject: c.subject ?? '', category: c.category });
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [at, setAt] = useState('');
  const preflight = useQuery({ queryKey: ['campaign', c.id, 'preflight', c.updatedAt], queryFn: () => api.campaigns.preflight(c.id), enabled: Boolean(c.segmentId && c.templateId) });
  const editable = can('campaigns:write') && (c.status === 'draft' || c.status === 'scheduled');
  const dirty = form.name !== c.name || form.segmentId !== (c.segmentId ?? '') || form.templateId !== (c.templateId ?? '') || form.senderId !== (c.senderId ?? '') || form.subject !== (c.subject ?? '') || form.category !== c.category;

  const save = useAction(() => api.campaigns.update(c.id, { name: form.name, segmentId: form.segmentId || null, templateId: form.templateId || null, senderId: form.senderId || null, subject: form.subject || null, category: form.category }), { success: 'Saved', onSuccess: onSaved });
  const test = useAction(() => api.campaigns.testSend(c.id), { success: (r) => `Test sent to ${r.to}` });
  const launch = useAction(() => api.campaigns.launch(c.id), { success: (r) => (r.status === 'pending_approval' ? 'Submitted for approval' : 'Sending started'), onSuccess: () => (setLaunchOpen(false), onSaved()) });
  const schedule = useAction(() => api.campaigns.schedule(c.id, { scheduledAt: new Date(at).toISOString(), timezone: workspace.timezone }), { success: 'Scheduled', onSuccess: () => (setScheduleOpen(false), onSaved()) });
  // Unscheduling goes through update (back to draft). schedule() without a time would send immediately.
  const unschedule = useAction(() => api.campaigns.update(c.id, { scheduledAt: null }), { success: 'Back to draft', onSuccess: onSaved });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
      <Card>
        <CardHeader title="Setup" />
        <div className="flex flex-col gap-4">
          <Field label="Name">{(id) => <Input id={id} value={form.name} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Audience">
            {(id) => (
              <Select id={id} value={form.segmentId} disabled={!editable} onChange={(e) => setForm({ ...form, segmentId: e.target.value })}>
                <option value="">Choose a segment</option>
                {segments.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}{s.count !== null ? ` (${formatNumber(s.count)})` : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Template" hint="The published version is frozen when sending starts.">
            {(id) => (
              <Select id={id} value={form.templateId} disabled={!editable} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
                <option value="">Choose a template</option>
                {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From">
              {(id) => (
                <Select id={id} value={form.senderId} disabled={!editable} onChange={(e) => setForm({ ...form, senderId: e.target.value })}>
                  <option value="">Default sender</option>
                  {senders.data?.items.filter((s) => s.status === 'verified').map((s) => <option key={s.id} value={s.id}>{s.name} &lt;{s.email}&gt;</option>)}
                </Select>
              )}
            </Field>
            <Field label="Kind of e-mail" hint={form.category === 'marketing' ? 'Needs granted (or implied, if allowed) consent.' : 'For people you have a relationship with.'}>
              {(id) => (
                <Select id={id} value={form.category} disabled={!editable} onChange={(e) => setForm({ ...form, category: e.target.value as MessageCategory })}>
                  <option value="marketing">Marketing</option>
                  <option value="relationship">Relationship</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Subject override (optional)">{(id) => <Input id={id} value={form.subject} disabled={!editable} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Use the template subject" />}</Field>
          {editable ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
              {can('messages:test') ? <Button icon={<Send className="size-4" />} disabled={dirty || !c.templateId} loading={test.isPending} onClick={() => test.mutate(undefined)}>Send test to me</Button> : null}
            </div>
          ) : null}
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Preflight" description="Recomputed from live data every time you open it." />
          {!c.segmentId || !c.templateId ? (
            <p className="text-sm text-muted">Choose and save an audience and a template to see who will receive it.</p>
          ) : preflight.isLoading ? (
            <Loading />
          ) : preflight.isError ? (
            <Notice tone="bad">{errorMessage(preflight.error)}</Notice>
          ) : (
            <Preflight p={preflight.data!} />
          )}
        </Card>
        {can('campaigns:launch') && (c.status === 'draft' || c.status === 'scheduled') ? (
          <Card>
            <CardHeader title="Send" description={c.requiresApproval ? 'This workspace requires a second person to approve campaigns.' : undefined} />
            {c.status === 'scheduled' ? (
              <div className="flex flex-col gap-3">
                <Notice tone="accent" icon={<CalendarClock className="size-4" />}>Scheduled for {formatDateTime(c.scheduledAt, c.timezone ?? workspace.timezone)}.</Notice>
                <Button variant="ghost" loading={unschedule.isPending} onClick={() => unschedule.mutate(undefined)}>Unschedule</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Send className="size-4" />} disabled={dirty || !preflight.data?.ok} onClick={() => setLaunchOpen(true)}>
                  {c.requiresApproval ? 'Submit for approval' : 'Send now'}
                </Button>
                <Button icon={<CalendarClock className="size-4" />} disabled={dirty || !preflight.data?.ok} onClick={() => setScheduleOpen(true)}>Schedule</Button>
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <ConfirmDialog open={launchOpen} onClose={() => setLaunchOpen(false)} onConfirm={() => launch.mutate(undefined)} loading={launch.isPending} title={`Send to ${formatNumber(preflight.data?.eligible ?? 0)} contacts?`} confirmLabel={c.requiresApproval ? 'Submit' : 'Send now'}>
        Sending is paced by your workspace limits and can be paused. E-mail that has already been handed to the provider cannot be recalled.
      </ConfirmDialog>
      <Dialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title="Schedule campaign"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!at} loading={schedule.isPending} onClick={() => schedule.mutate(undefined)}>Schedule</Button>
          </>
        }
      >
        <Field label="Send at (your local time)" hint={`Workspace time zone: ${workspace.timezone}`}>{(id) => <Input id={id} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
      </Dialog>
    </div>
  );
}

function Results({ c, onChanged }: { c: CampaignDTO; onChanged(): void }) {
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<'all' | 'sent' | 'skipped' | 'failed'>('all');
  const [page, setPage] = useState(1);
  const recipients = useQuery({ queryKey: ['campaign', c.id, 'recipients', status, page], queryFn: () => api.campaigns.recipients(c.id, { status: status === 'all' ? undefined : status, page, pageSize: 50 }) });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.integrations.ai() });
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.ai.summarizeCampaign>> | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const pause = useAction(() => api.campaigns.pause(c.id), { success: 'Paused', onSuccess: onChanged });
  const resume = useAction(() => api.campaigns.resume(c.id), { success: 'Resumed', onSuccess: onChanged });
  const approve = useAction(() => api.campaigns.approve(c.id), { success: 'Approved — sending', onSuccess: onChanged });
  const cancel = useAction(() => api.campaigns.cancel(c.id), { success: (r) => `Cancelled ${r.cancelledMessages} unsent; ${r.alreadySent} already sent`, onSuccess: () => (setCancelOpen(false), onChanged()) });
  const summarize = useAction(() => api.ai.summarizeCampaign(c.id), { onSuccess: setSummary });
  const { counts, rates, reporting } = c.stats;

  useEffect(() => {
    if (c.status !== 'sending') return;
    const t = window.setInterval(onChanged, 5000);
    return () => window.clearInterval(t);
  }, [c.status, onChanged]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {c.status === 'pending_approval' && can('campaigns:approve') ? <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate(undefined)}>Approve and send</Button> : null}
        {c.status === 'sending' && can('campaigns:launch') ? <Button icon={<Pause className="size-4" />} loading={pause.isPending} onClick={() => pause.mutate(undefined)}>Pause</Button> : null}
        {c.status === 'paused' && can('campaigns:launch') ? <Button variant="primary" icon={<Play className="size-4" />} loading={resume.isPending} onClick={() => resume.mutate(undefined)}>Resume</Button> : null}
        {['sending', 'paused', 'pending_approval'].includes(c.status) && can('campaigns:launch') ? <Button variant="ghost" onClick={() => setCancelOpen(true)}>Cancel remaining</Button> : null}
        {ai.data?.enabled && can('ai:use') && c.status === 'completed' ? <Button variant="ghost" icon={<Sparkles className="size-4" />} loading={summarize.isPending} onClick={() => summarize.mutate(undefined)}>Summarise results</Button> : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sent" value={formatNumber(counts.sent)} sub={`of ${formatNumber(c.recipientCount ?? 0)} recipients`} />
        <Stat label="Delivered" value={formatPercent(rates.deliveryRate)} sub={reporting.deliveryEvents ? `${formatNumber(counts.delivered)} confirmed · ${formatNumber(counts.bounced)} bounced` : 'Provider does not report deliveries'} />
        <Stat label="Clicked" value={formatPercent(rates.clickRate)} sub={`${formatNumber(counts.clicked)} people`} />
        <Stat label="Opened (estimate)" value={formatPercent(rates.openRate)} sub="Privacy proxies and image blocking distort opens" />
      </div>
      {summary ? (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4" /> AI summary</span>} description="Generated from aggregate numbers only." />
          <p className="text-sm text-ink">{summary.summary}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3 text-sm">
            {(['highlights', 'concerns', 'nextSteps'] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{humanize(k === 'nextSteps' ? 'next_steps' : k)}</p>
                <ul className="list-disc pl-4 text-ink-2">{summary[k].map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card padded={false}>
        <div className="p-4 pb-0">
          <Tabs value={status} onChange={(s) => (setStatus(s), setPage(1))} items={[{ value: 'all', label: 'All recipients' }, { value: 'sent', label: 'Sent' }, { value: 'skipped', label: 'Skipped' }, { value: 'failed', label: 'Failed' }]} />
        </div>
        {recipients.isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable<CampaignRecipientDTO>
              rows={recipients.data?.items ?? []}
              rowKey={(r) => r.contactId}
              dim={recipients.isFetching}
              empty={<p className="py-12 text-center text-sm text-muted">No recipients in this view.</p>}
              columns={[
                { key: 'name', header: 'Contact', cell: (r) => <Link to={`/contacts/${r.contactId}`} className="font-medium hover:underline">{r.name}</Link> },
                { key: 'email', header: 'E-mail', cell: (r) => <span className="text-ink-2">{r.email ?? '—'}</span> },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'reason', header: 'Detail', cell: (r) => <span className="text-xs text-muted">{r.skipReason ? r.skipReason.split(', ').map((x) => REASONS[x] ?? humanize(x)).join('; ') : '—'}</span> },
              ]}
            />
            {recipients.data && recipients.data.total > recipients.data.pageSize ? <Pagination page={page} pageSize={recipients.data.pageSize} total={recipients.data.total} onPage={setPage} /> : null}
          </>
        )}
      </Card>
      <p className="text-xs text-muted">Launched {formatDateTime(c.launchedAt, workspace.timezone)}{c.completedAt ? ` · completed ${formatDateTime(c.completedAt, workspace.timezone)}` : ''}</p>
      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={() => cancel.mutate(undefined)} loading={cancel.isPending} danger title="Cancel the remaining sends?" confirmLabel="Cancel remaining">
        Messages not yet handed to the provider are cancelled. Messages already sent cannot be recalled — Morrow will tell you how many.
      </ConfirmDialog>
    </div>
  );
}

export default function CampaignPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const campaign = useQuery({ queryKey: ['campaign', id], queryFn: () => api.campaigns.get(id) });
  useDocumentTitle(campaign.data?.name ?? 'Campaign');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['campaign', id] });
    void qc.invalidateQueries({ queryKey: ['campaigns'] });
  };
  if (campaign.isLoading) return <Loading />;
  if (campaign.isError || !campaign.data) return <ErrorState error={campaign.error} retry={() => campaign.refetch()} />;
  const c = campaign.data;
  const setupMode = c.status === 'draft' || c.status === 'scheduled';
  return (
    <>
      <PageHeader
        back={<Link to="/campaigns" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Campaigns</Link>}
        title={<span className="flex items-center gap-2">{c.name} <StatusBadge status={c.status} /></span>}
        description={`${c.templateName ?? 'No template'} → ${c.segmentName ?? 'No audience'}${c.approvalNote ? ` · Note: ${c.approvalNote}` : ''}`}
      />
      {setupMode ? <Setup key={c.updatedAt} c={c} onSaved={refresh} /> : <Results c={c} onChanged={refresh} />}
    </>
  );
}

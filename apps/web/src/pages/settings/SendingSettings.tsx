import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, Globe, Mail, Plus, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DnsCheckDTO, SuppressionDTO } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, Loading, Notice, StatusBadge } from '../../components/ui/display';
import { Checkbox, Field, Input, Select } from '../../components/ui/field';
import { DataTable, Pagination } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatDate, formatRelative, humanize } from '../../lib/format';
import { useAction, useDebounced } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';

function ProviderCard() {
  const { can } = useSession();
  const toast = useToast();
  const integration = useQuery({ queryKey: ['integration-email'], queryFn: () => api.integrations.email() });
  const [provider, setProvider] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  useEffect(() => {
    if (integration.data && !provider) {
      setProvider(integration.data.provider ?? integration.data.providers[0]?.name ?? '');
      setConfig(integration.data.config);
    }
  }, [integration.data, provider]);
  const save = useAction(() => api.integrations.setEmail({ provider, config, secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) }), { success: 'Provider saved', invalidate: [['integration-email']], onSuccess: () => setSecrets({}) });
  const test = useAction(() => api.integrations.testEmail(), { onSuccess: (r) => (r.ok ? toast.success(r.message || 'Connection works') : toast.error(new Error(r.message))) , invalidate: [['integration-email']] });
  const remove = useAction(() => api.integrations.removeEmail(), { success: 'Workspace provider removed', invalidate: [['integration-email']] });
  if (integration.isLoading || !integration.data) return <Card><Loading /></Card>;
  const d = integration.data;
  const info = d.providers.find((p) => p.name === provider);
  const editable = can('integrations:manage');

  return (
    <Card>
      <CardHeader
        title="E-mail provider"
        description={d.source === 'environment' ? `Using the installation default (${d.providerLabel}). Configure your own to send from this workspace’s account.` : d.source === 'workspace' ? `Connected: ${d.providerLabel}` : 'No provider yet — nothing can be sent.'}
        action={d.source === 'workspace' ? <StatusBadge status={d.status === 'ok' ? 'ok' : d.status} label={d.status === 'ok' ? 'Working' : humanize(d.status)} /> : null}
      />
      <div className="flex flex-col gap-4">
        <Field label="Provider">
          {(id) => (
            <Select id={id} value={provider} disabled={!editable} onChange={(e) => (setProvider(e.target.value), setConfig({}), setSecrets({}))}>
              {d.providers.map((p) => <option key={p.name} value={p.name}>{p.label}{p.developmentOnly ? ' (development only)' : ''}</option>)}
            </Select>
          )}
        </Field>
        {info ? <p className="text-sm text-ink-2">{info.description} {info.docsUrl ? <a className="text-accent-text hover:underline" href={info.docsUrl} target="_blank" rel="noreferrer">Docs</a> : null}</p> : null}
        {info?.developmentOnly ? <Notice tone="warn">The development inbox keeps every e-mail inside Morrow. Use it to try things out; nothing reaches real inboxes.</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {info?.fields.map((f) =>
            f.type === 'boolean' ? (
              <Checkbox key={f.key} label={f.label} description={f.help} disabled={!editable} checked={Boolean(config[f.key] ?? f.defaultValue)} onChange={(e) => setConfig({ ...config, [f.key]: e.target.checked })} />
            ) : (
              <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.secret ? (d.secretsSet[f.key] && d.provider === provider ? 'Saved — leave empty to keep it.' : f.help) : f.help}>
                {(id) =>
                  f.type === 'select' ? (
                    <Select id={id} disabled={!editable} value={String(config[f.key] ?? f.defaultValue ?? '')} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : f.secret ? (
                    <Input id={id} type="password" autoComplete="off" disabled={!editable} placeholder={d.secretsSet[f.key] && d.provider === provider ? '••••••••' : f.placeholder} value={secrets[f.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} />
                  ) : (
                    <Input id={id} type={f.type === 'number' ? 'number' : 'text'} disabled={!editable} placeholder={f.placeholder} value={String(config[f.key] ?? f.defaultValue ?? '')} onChange={(e) => setConfig({ ...config, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />
                  )
                }
              </Field>
            ),
          )}
        </div>
        {d.webhookUrl && info?.webhook.supported ? (
          <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
            <p className="font-medium">Delivery webhook</p>
            <p className="mt-1 text-xs text-ink-2">{info.webhook.instructions}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs">{d.webhookUrl}</code>
              <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(d.webhookUrl!).then(() => toast.success('Copied'))}>Copy</Button>
            </div>
          </div>
        ) : null}
        {d.capabilities ? (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(d.capabilities).map(([k, v]) => <Badge key={k} tone={v ? 'good' : 'neutral'}>{v ? '✓' : '—'} {humanize(k.replace(/([A-Z])/g, '_$1').toLowerCase())}</Badge>)}
          </div>
        ) : null}
        {d.lastTestedAt ? <p className="text-xs text-muted">Last tested {formatRelative(d.lastTestedAt)}: {d.lastTestResult}</p> : null}
        {editable ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            {d.source === 'workspace' ? <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>Remove</Button> : null}
            {d.source !== 'none' ? <Button loading={test.isPending} onClick={() => test.mutate(undefined)}>Test connection</Button> : null}
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save provider</Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function DnsDialog({ senderId, onClose }: { senderId: string | null; onClose(): void }) {
  const dns = useQuery({ queryKey: ['dns', senderId], queryFn: () => api.senders.dns(senderId!), enabled: Boolean(senderId) });
  const rows = (d: DnsCheckDTO) => [
    { name: 'SPF', ...d.spf },
    { name: 'DMARC', ...d.dmarc },
    { name: 'MX', ...d.mx },
    ...d.dkim.map((k) => ({ name: `DKIM (${k.selector})`, ...k })),
  ];
  return (
    <Dialog open={Boolean(senderId)} onClose={onClose} title={dns.data ? `DNS for ${dns.data.domain}` : 'DNS check'} description="Authenticated domains land in the inbox, not spam. Your provider shows the exact records to add." size="lg">
      {dns.isLoading ? (
        <Loading label="Looking up DNS…" />
      ) : dns.data ? (
        <ul className="flex flex-col divide-y divide-line">
          {rows(dns.data).map((r) => (
            <li key={r.name} className="flex items-start gap-3 py-3">
              <StatusBadge status={r.status === 'pass' ? 'ok' : r.status === 'fail' ? 'failed' : 'pending'} label={r.status} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.name}</p>
                <p className="text-xs text-ink-2">{r.message}</p>
                {r.record ? <code className="mt-1 block truncate font-mono text-[11px] text-muted">{r.record}</code> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

function SendersCard() {
  const { can } = useSession();
  const senders = useQuery({ queryKey: ['senders'], queryFn: () => api.senders.list() });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', replyTo: '' });
  const [dnsFor, setDnsFor] = useState<string | null>(null);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const create = useAction(() => api.senders.create({ name: form.name, email: form.email, replyTo: form.replyTo || null }), { success: 'Sender added — check that inbox for a verification link', invalidate: [['senders']], onSuccess: () => (setAdding(false), setForm({ name: '', email: '', replyTo: '' })) });
  const resend = useAction((id: string) => api.senders.sendVerification(id), { success: 'Verification e-mail sent' });
  const makeDefault = useAction((id: string) => api.senders.update(id, { isDefault: true }), { success: 'Default sender updated', invalidate: [['senders']] });
  const remove = useAction((id: string) => api.senders.delete(id), { success: 'Sender removed', invalidate: [['senders']] });
  const markVerified = useAction(() => api.senders.markVerified(verifyFor!, note), { success: 'Marked as verified', invalidate: [['senders']], onSuccess: () => (setVerifyFor(null), setNote('')) });
  const editable = can('integrations:manage');

  return (
    <Card padded={false}>
      <div className="p-5 pb-2">
        <CardHeader title="Senders" description="Addresses you send from. Each must be verified by clicking a link sent to it, or by an admin after verifying the domain at the provider." action={editable ? <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add sender</Button> : null} />
      </div>
      {senders.isLoading ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {senders.data?.items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Mail className="size-4 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{s.name} <span className="font-normal text-ink-2">&lt;{s.email}&gt;</span></p>
                <p className="text-xs text-muted">{s.replyTo ? `Replies to ${s.replyTo} · ` : ''}added {formatDate(s.createdAt)}</p>
              </div>
              {s.isDefault ? <Badge tone="accent">Default</Badge> : null}
              <StatusBadge status={s.status} />
              <Button size="sm" variant="ghost" icon={<Globe className="size-3.5" />} onClick={() => setDnsFor(s.id)}>DNS</Button>
              {editable && s.status !== 'verified' ? (
                <>
                  <Button size="sm" variant="ghost" loading={resend.isPending} onClick={() => resend.mutate(s.id)}>Resend link</Button>
                  <Button size="sm" variant="ghost" icon={<CheckCircle2 className="size-3.5" />} onClick={() => setVerifyFor(s.id)}>Mark verified</Button>
                </>
              ) : null}
              {editable && s.status === 'verified' && !s.isDefault ? <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate(s.id)}>Make default</Button> : null}
              {editable && !s.isDefault ? <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>Remove</Button> : null}
            </li>
          ))}
          {!senders.data?.items.length ? <li className="px-5 py-8 text-center text-sm text-muted">No senders yet.</li> : null}
        </ul>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add sender" footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!form.name || !form.email} loading={create.isPending} onClick={() => create.mutate(undefined)}>Add and send verification</Button></>}>
        <div className="flex flex-col gap-4">
          <Field label="From name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ammaar from Cyphen" />}</Field>
          <Field label="From address" hint="Use a domain you own and have authenticated with your provider.">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="hello@cyphen.dev" />}</Field>
          <Field label="Reply-to (optional)">{(id) => <Input id={id} type="email" value={form.replyTo} onChange={(e) => setForm({ ...form, replyTo: e.target.value })} />}</Field>
        </div>
      </Dialog>
      <Dialog open={Boolean(verifyFor)} onClose={() => setVerifyFor(null)} title="Mark sender as verified" description="Only do this after confirming the domain at your e-mail provider. The note is kept in the audit log." size="sm" footer={<><Button variant="ghost" onClick={() => setVerifyFor(null)}>Cancel</Button><Button variant="primary" disabled={!note.trim()} loading={markVerified.isPending} onClick={() => markVerified.mutate(undefined)}>Mark verified</Button></>}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Domain verified in Resend on 2026-10-17" aria-label="Verification note" />
      </Dialog>
      <DnsDialog senderId={dnsFor} onClose={() => setDnsFor(null)} />
    </Card>
  );
}

function SuppressionsCard() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ['suppressions', query, page], queryFn: () => api.suppressions.list({ q: query || undefined, page, pageSize: 25 }) });
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [lifting, setLifting] = useState<SuppressionDTO | null>(null);
  const [note, setNote] = useState('');
  const add = useAction(() => api.suppressions.add({ email, reason: 'manual' }), { success: 'Address suppressed', invalidate: [['suppressions']], onSuccess: () => (setAdding(false), setEmail('')) });
  const lift = useAction(() => api.suppressions.lift(lifting!.id, note), { success: 'Suppression lifted', invalidate: [['suppressions']], onSuccess: () => (setLifting(null), setNote('')) });
  return (
    <Card padded={false}>
      <div className="p-5 pb-3">
        <CardHeader title="Suppression list" description="Addresses Morrow will never e-mail: unsubscribes, hard bounces, spam complaints and manual blocks." action={can('suppressions:manage') ? <Button size="sm" icon={<ShieldOff className="size-3.5" />} onClick={() => setAdding(true)}>Suppress address</Button> : null} />
        <Input placeholder="Search addresses" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search suppressions" />
      </div>
      <DataTable<SuppressionDTO>
        rows={list.data?.items ?? []}
        rowKey={(s) => s.id}
        dim={list.isFetching}
        empty={<p className="pb-8 text-center text-sm text-muted">No suppressed addresses.</p>}
        columns={[
          { key: 'email', header: 'Address', cell: (s) => <span className="font-medium">{s.email}</span> },
          { key: 'reason', header: 'Reason', cell: (s) => <StatusBadge status={s.reason === 'manual' ? 'paused' : 'suppressed'} label={humanize(s.reason)} /> },
          { key: 'scope', header: 'Blocks', cell: (s) => (s.scope === 'all' ? 'All e-mail' : 'Marketing & relationship') },
          { key: 'source', header: 'Source', cell: (s) => <span className="text-xs text-muted">{s.source ?? '—'}</span> },
          { key: 'at', header: 'Since', cell: (s) => <span className="text-xs text-muted">{formatDate(s.createdAt)}</span> },
          { key: 'lift', header: '', cell: (s) => (can('suppressions:manage') && (!['unsubscribed', 'complaint'].includes(s.reason) || can('integrations:manage')) ? <Button size="sm" variant="ghost" onClick={() => setLifting(s)}>Lift</Button> : null) },
        ]}
      />
      {list.data && list.data.total > list.data.pageSize ? <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} /> : null}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Suppress an address" size="sm" footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!email} loading={add.isPending} onClick={() => add.mutate(undefined)}>Suppress</Button></>}>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="someone@example.com" aria-label="E-mail address" />
      </Dialog>
      <Dialog open={Boolean(lifting)} onClose={() => setLifting(null)} title={`Lift suppression for ${lifting?.email ?? ''}?`} description={lifting?.reason === 'unsubscribed' ? 'Only do this if the person asked to receive e-mail again.' : 'Make sure the address now works.'} size="sm" footer={<><Button variant="ghost" onClick={() => setLifting(null)}>Cancel</Button><Button variant="primary" disabled={note.trim().length < 5} loading={lift.isPending} onClick={() => lift.mutate(undefined)}>Lift</Button></>}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (kept in the audit log)" aria-label="Reason" />
      </Dialog>
    </Card>
  );
}

export function SendingSettings() {
  return (
    <div className="flex flex-col gap-6">
      <ProviderCard />
      <SendersCard />
      <SuppressionsCard />
    </div>
  );
}

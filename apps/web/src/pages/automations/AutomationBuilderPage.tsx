import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Pause, Play, ShieldCheck, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { emptyCriteria, type AutomationDefinition, type AutomationRunDTO } from '@morrow/core';
import { CriteriaBuilder } from '../../components/criteria/CriteriaBuilder';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorState, Loading, Notice, PageHeader, StatusBadge, Tabs } from '../../components/ui/display';
import { Checkbox, Field, Input } from '../../components/ui/field';
import { DataTable } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, formatRelative } from '../../lib/format';
import { useAction, useDebounced, useDocumentTitle } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';
import { DryRunPanel } from './DryRunPanel';
import { StepsEditor } from './StepsEditor';
import { TriggerEditor } from './TriggerEditor';

export default function AutomationBuilderPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const automation = useQuery({ queryKey: ['automation', id], queryFn: () => api.automations.get(id) });
  const [name, setName] = useState('');
  const [def, setDef] = useState<AutomationDefinition | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [tab, setTab] = useState<'build' | 'runs'>('build');
  const [confirmAuto, setConfirmAuto] = useState(false);
  useDocumentTitle(automation.data?.name ?? 'Automation');

  useEffect(() => {
    if (automation.data && !def) {
      setName(automation.data.name);
      setDef(automation.data.definition);
      setSavedJson(JSON.stringify({ name: automation.data.name, def: automation.data.definition }));
    }
  }, [automation.data, def]);

  const dirty = useMemo(() => def !== null && JSON.stringify({ name, def }) !== savedJson, [name, def, savedJson]);
  const liveDef = useDebounced(def, 500);
  const validation = useQuery({ queryKey: ['automation-validate', liveDef], queryFn: () => api.automations.validate(liveDef!), enabled: Boolean(liveDef) && dirty, retry: false });
  const runs = useQuery({ queryKey: ['automation', id, 'runs'], queryFn: () => api.automations.runs(id, { pageSize: 50 }), enabled: tab === 'runs' });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['automation', id] });
    await qc.invalidateQueries({ queryKey: ['automations'] });
  };
  const save = useAction(() => api.automations.update(id, { name, definition: def! }), {
    success: (a) => `Saved as version ${a.version}${a.status === 'active' && a.deliveryMode === 'review' ? ' — automatic delivery needs re-approval after edits' : ''}`,
    onSuccess: async (a) => {
      setDef(a.definition);
      setSavedJson(JSON.stringify({ name: a.name, def: a.definition }));
      await refresh();
    },
  });
  const activate = useAction((mode: 'review' | 'auto') => api.automations.activate(id, mode), { success: (a) => `Active — ${a.deliveryMode === 'auto' ? 'sends automatically' : 'each e-mail waits for review'}`, onSuccess: refresh });
  const setMode = useAction((mode: 'review' | 'auto') => api.automations.setDeliveryMode(id, mode), { success: 'Delivery mode updated', onSuccess: refresh });
  const pause = useAction(() => api.automations.pause(id), { success: 'Paused. Runs in progress hold until you resume.', onSuccess: refresh });
  const resume = useAction(() => api.automations.resume(id), { success: 'Resumed', onSuccess: refresh });

  if (automation.isLoading || !def) return automation.isError ? <ErrorState error={automation.error} /> : <Loading />;
  const a = automation.data!;
  const editable = can('automations:write') && a.status !== 'archived';
  const problems = dirty ? (validation.data?.problems ?? []) : a.problems;
  const errors = problems.filter((p) => p.severity === 'error');

  return (
    <>
      <PageHeader
        back={<Link to="/automations" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Automations</Link>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {a.name} <StatusBadge status={a.status} /> <Badge tone={a.deliveryMode === 'auto' ? 'accent' : 'warn'}>{a.deliveryMode === 'auto' ? 'Automatic delivery' : 'Review mode'}</Badge>
            {dirty ? <Badge tone="warn">Unsaved</Badge> : null}
          </span>
        }
        description={`${a.triggerSummary} · version ${a.version}${a.lastTriggeredAt ? ` · last triggered ${formatRelative(a.lastTriggeredAt)}` : ''}`}
        actions={
          <>
            {editable ? <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button> : null}
            {can('automations:activate') && !dirty ? (
              a.status === 'active' ? (
                <Button icon={<Pause className="size-4" />} loading={pause.isPending} onClick={() => pause.mutate(undefined)}>Pause</Button>
              ) : a.status === 'paused' ? (
                <Button variant="primary" icon={<Play className="size-4" />} loading={resume.isPending} onClick={() => resume.mutate(undefined)}>Resume</Button>
              ) : a.status === 'draft' ? (
                <Button variant="primary" icon={<Play className="size-4" />} disabled={errors.length > 0} loading={activate.isPending} onClick={() => activate.mutate('review')}>Activate (review mode)</Button>
              ) : null
            ) : null}
          </>
        }
      />

      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'build', label: 'Builder' }, { value: 'runs', label: 'Runs', count: a.stats.runs }]} />
      </div>

      {tab === 'runs' ? (
        <Card padded={false}>
          {runs.isLoading ? (
            <Loading />
          ) : (
            <DataTable<AutomationRunDTO>
              rows={runs.data?.items ?? []}
              rowKey={(r) => r.id}
              empty={<p className="py-12 text-center text-sm text-muted">No runs yet.</p>}
              columns={[
                { key: 'contact', header: 'Contact', cell: (r) => <Link className="font-medium hover:underline" to={`/contacts/${r.contactId}`}>{r.contactName ?? r.contactEmail}</Link> },
                { key: 'key', header: 'Occasion', cell: (r) => <span className="font-mono text-xs text-ink-2">{r.eventKey}</span> },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'next', header: 'Next step', cell: (r) => (r.resumeAt ? `resumes ${formatDateTime(r.resumeAt, workspace.timezone)}` : (r.error ?? '—')) },
                { key: 'started', header: 'Started', cell: (r) => <span className="text-xs text-muted">{formatRelative(r.startedAt)}</span> },
              ]}
            />
          )}
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <Field label="Name">{(fid) => <Input id={fid} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />}</Field>
            </Card>
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><Zap className="size-4 text-accent-text" /> Trigger</span>} />
              <TriggerEditor value={def.trigger} disabled={!editable} onChange={(trigger) => setDef({ ...def, trigger })} />
            </Card>
            <Card>
              <CardHeader
                title="Entry conditions"
                description="Contacts must also match these when the trigger fires. Consent and suppression are always checked separately."
                action={editable ? <Checkbox label="Use conditions" checked={Boolean(def.conditions)} onChange={(e) => setDef({ ...def, conditions: e.target.checked ? emptyCriteria() : null })} /> : null}
              />
              {def.conditions ? <CriteriaBuilder value={def.conditions} onChange={(conditions) => setDef({ ...def, conditions })} /> : <p className="text-sm text-muted">Everyone the trigger fires for.</p>}
            </Card>
            <div>
              <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted">Steps</p>
              <StepsEditor steps={def.steps} disabled={!editable} onChange={(steps) => setDef({ ...def, steps })} />
            </div>
            <Card>
              <CardHeader title="Repeat rules" />
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Cooldown (days)" hint="Don’t start again within this many days.">
                  {(fid) => <Input id={fid} type="number" min={0} value={def.settings.cooldownDays} disabled={!editable} onChange={(e) => setDef({ ...def, settings: { ...def.settings, cooldownDays: Number(e.target.value) } })} />}
                </Field>
                <Field label="Max runs per contact" hint="0 = unlimited">
                  {(fid) => <Input id={fid} type="number" min={0} value={def.settings.maxRunsPerContact} disabled={!editable} onChange={(e) => setDef({ ...def, settings: { ...def.settings, maxRunsPerContact: Number(e.target.value) } })} />}
                </Field>
                <div className="pt-6">
                  <Checkbox label="Allow re-entry" description="E.g. a birthday every year." checked={def.settings.allowReentry} disabled={!editable} onChange={(e) => setDef({ ...def, settings: { ...def.settings, allowReentry: e.target.checked } })} />
                </div>
              </div>
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:h-fit">
            {problems.length ? (
              <Card>
                <CardHeader title="Checks" />
                <ul className="flex flex-col gap-2 text-sm">
                  {problems.map((p, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <AlertTriangle className={p.severity === 'error' ? 'mt-0.5 size-4 shrink-0 text-bad' : 'mt-0.5 size-4 shrink-0 text-warn'} />
                      <span><strong className="font-medium">{p.severity === 'error' ? 'Error' : 'Warning'}:</strong> {p.message}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <Card>
              <CardHeader title="Delivery" description="Review mode queues each e-mail for a person to approve. Automatic delivery sends without review." />
              <div className="flex flex-col gap-3 text-sm">
                <p className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-good" /> Consent, suppressions, frequency caps and duplicates are checked before every send.
                </p>
                {a.deliveryMode === 'auto' ? (
                  <Notice tone="accent">Approved for automatic delivery by {a.autoApprovedBy && !a.autoApprovedBy.startsWith('usr_') ? a.autoApprovedBy : 'an admin'} {a.autoApprovedAt ? formatRelative(a.autoApprovedAt) : ''}. Any edit returns it to review mode.</Notice>
                ) : null}
                {can('automations:approve_auto') && a.status !== 'draft' && !dirty ? (
                  a.deliveryMode === 'review' ? (
                    <Button onClick={() => setConfirmAuto(true)}>Approve automatic delivery</Button>
                  ) : (
                    <Button variant="ghost" onClick={() => setMode.mutate('review')}>Switch back to review mode</Button>
                  )
                ) : null}
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ['Runs', a.stats.runs],
                    ['Messages', a.stats.messages],
                    ['To review', a.stats.pendingApproval],
                  ].map(([l, n]) => (
                    <div key={l as string} className="rounded-lg bg-surface-2 py-2">
                      <dt className="text-xs text-muted">{l}</dt>
                      <dd className="text-lg font-semibold">{formatNumber(n as number)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Card>
            <DryRunPanel automationId={id} definition={def} timezone={workspace.timezone} />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmAuto}
        onClose={() => setConfirmAuto(false)}
        onConfirm={() => {
          setMode.mutate('auto');
          setConfirmAuto(false);
        }}
        title="Send without review?"
        confirmLabel="Approve automatic delivery"
      >
        From now on, e-mails from <strong>{a.name}</strong> go out without anyone approving them. Morrow still enforces consent, unsubscribes, suppressions, frequency caps and duplicate protection. Editing the automation returns it to review mode. This approval is recorded in the audit log.
      </ConfirmDialog>
    </>
  );
}

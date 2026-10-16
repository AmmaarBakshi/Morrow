import { useQuery } from '@tanstack/react-query';
import { Cake, Plus, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { TRIGGER_LABELS, type TriggerType } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, Loading, Notice, PageHeader, StatusBadge } from '../../components/ui/display';
import { Field, Input, Select } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatNumber, formatRelative } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { newStep } from './StepsEditor';
import { defaultTrigger } from './TriggerEditor';

export default function AutomationsPage() {
  useDocumentTitle('Automations');
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['automations'], queryFn: () => api.automations.list() });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<TriggerType>('event');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const templates = await api.templates.list({ status: 'published' });
      const first = templates.items[0];
      const steps = first ? [newStep('send_email', first.id)] : [newStep('notify')];
      const a = await api.automations.create({ name, definition: { trigger: defaultTrigger(trigger), steps } });
      navigate(`/automations/${a.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.items.filter((a) => a.status !== 'archived') ?? [];
  return (
    <>
      <PageHeader
        title="Automations"
        description="Lifecycle e-mail that runs on its own: birthdays, anniversaries, welcomes, follow-ups and re-engagement. New automations start in review mode."
        actions={can('automations:write') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New automation</Button> : null}
      />
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => list.refetch()} />
      ) : items.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((a) => (
            <Link key={a.id} to={`/automations/${a.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                    {a.triggerType === 'calendar' ? <Cake className="size-4" /> : <Workflow className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold group-hover:underline">{a.name}</p>
                      <StatusBadge status={a.status} />
                      {a.status === 'active' ? <Badge tone={a.deliveryMode === 'auto' ? 'accent' : 'warn'}>{a.deliveryMode === 'auto' ? 'automatic' : 'review'}</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-sm text-ink-2">{a.triggerSummary}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                  <span>{formatNumber(a.stats.runs)} runs</span>
                  <span>{formatNumber(a.stats.active)} in progress</span>
                  <span>{formatNumber(a.stats.messages)} e-mails</span>
                  {a.stats.pendingApproval ? <span className="font-medium text-warn">{formatNumber(a.stats.pendingApproval)} to review</span> : null}
                  {a.lastTriggeredAt ? <span>last {formatRelative(a.lastTriggeredAt)}</span> : null}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<Workflow className="size-5" />} title="No automations yet" />
        </Card>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New automation"
        description="You can change everything in the builder. Nothing runs until you activate it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={create}>Create and open builder</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="Name">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Thank clients when a project ships" />}</Field>
          <Field label="Starts when">
            {(id) => (
              <Select id={id} value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
                {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Bell, CheckSquare, Clock, GitBranch, Mail, Plus, Square, Tag, Trash2, UserCog } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AUTOMATION_UPDATABLE_FIELDS, emptyCriteria, STEP_LABELS, type Step, type StepType } from '@morrow/core';
import { CriteriaBuilder } from '../../components/criteria/CriteriaBuilder';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/field';
import { api } from '../../lib/api';
import { humanize } from '../../lib/format';

const ICONS: Record<StepType, ReactNode> = {
  send_email: <Mail className="size-4" />,
  wait: <Clock className="size-4" />,
  add_tag: <Tag className="size-4" />,
  remove_tag: <Tag className="size-4" />,
  update_field: <UserCog className="size-4" />,
  create_task: <CheckSquare className="size-4" />,
  notify: <Bell className="size-4" />,
  branch: <GitBranch className="size-4" />,
  end: <Square className="size-4" />,
};

function newId(type: StepType): string {
  return `${type}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newStep(type: StepType, templateId = ''): Step {
  const id = newId(type);
  switch (type) {
    case 'send_email': return { id, type, templateId };
    case 'wait': return { id, type, amount: 3, unit: 'days' };
    case 'add_tag':
    case 'remove_tag': return { id, type, tag: '' };
    case 'update_field': return { id, type, field: 'relationship_type', value: 'client' };
    case 'create_task': return { id, type, title: 'Follow up with {{first_name}}', dueInDays: 2 };
    case 'notify': return { id, type, title: 'Automation update' };
    case 'branch': return { id, type, condition: emptyCriteria(), then: [], else: [] };
    case 'end': return { id, type };
  }
}

function summary(step: Step, templates: Map<string, string>): string {
  switch (step.type) {
    case 'send_email': return templates.get(step.templateId) ?? 'Choose a template';
    case 'wait': return `${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, '') : step.unit}`;
    case 'add_tag':
    case 'remove_tag': return step.tag || 'Choose a tag';
    case 'update_field': return `${humanize(step.field.replace('custom:', ''))} → ${String(step.value)}`;
    case 'create_task': return `${step.title} (due in ${step.dueInDays} days)`;
    case 'notify': return step.title;
    case 'branch': return `${step.condition.rules.length} condition(s)`;
    case 'end': return 'Stop here';
  }
}

function AddStep({ onAdd, disabled }: { onAdd(type: StepType): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  if (disabled) return <div className="mx-auto h-5 w-px bg-line-strong" />;
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-3 w-px bg-line-strong" />
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex size-6 items-center justify-center rounded-full border border-line-strong bg-surface text-muted hover:border-accent hover:text-accent-text" aria-label="Add step" aria-expanded={open}>
        <Plus className="size-3.5" />
      </button>
      <div className="h-3 w-px bg-line-strong" />
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-8 z-20 grid w-64 grid-cols-1 gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
            {(Object.keys(STEP_LABELS) as StepType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onAdd(t);
                  setOpen(false);
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <span className="text-muted">{ICONS[t]}</span> {STEP_LABELS[t]}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function StepForm({ step, onChange, disabled }: { step: Step; onChange(s: Step): void; disabled?: boolean }) {
  const templates = useQuery({ queryKey: ['templates', 'published'], queryFn: () => api.templates.list({ status: 'published' }) });
  const senders = useQuery({ queryKey: ['senders'], queryFn: () => api.senders.list(), enabled: step.type === 'send_email' });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.workspace.members(), enabled: step.type === 'create_task', retry: false });
  switch (step.type) {
    case 'send_email':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Template" hint="Only published templates can be sent.">
            {(id) => (
              <Select id={id} value={step.templateId} disabled={disabled} onChange={(e) => onChange({ ...step, templateId: e.target.value })}>
                <option value="">Choose a template</option>
                {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="From">
            {(id) => (
              <Select id={id} value={step.senderId ?? ''} disabled={disabled} onChange={(e) => onChange({ ...step, senderId: e.target.value || null })}>
                <option value="">Default sender</option>
                {senders.data?.items.filter((s) => s.status === 'verified').map((s) => <option key={s.id} value={s.id}>{s.name} &lt;{s.email}&gt;</option>)}
              </Select>
            )}
          </Field>
          <Field label="Subject override (optional)" className="sm:col-span-2">
            {(id) => <Input id={id} value={step.subjectOverride ?? ''} disabled={disabled} onChange={(e) => onChange({ ...step, subjectOverride: e.target.value || null })} placeholder="Use the template subject" />}
          </Field>
        </div>
      );
    case 'wait':
      return (
        <div className="flex items-end gap-2">
          <Field label="Wait for">{(id) => <Input id={id} className="w-24" type="number" min={1} value={step.amount} disabled={disabled} onChange={(e) => onChange({ ...step, amount: Number(e.target.value) || 1 })} />}</Field>
          <Select className="w-auto" aria-label="Unit" value={step.unit} disabled={disabled} onChange={(e) => onChange({ ...step, unit: e.target.value as 'days' })}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </Select>
        </div>
      );
    case 'add_tag':
    case 'remove_tag':
      return <Field label="Tag">{(id) => <Input id={id} value={step.tag} disabled={disabled} onChange={(e) => onChange({ ...step, tag: e.target.value })} />}</Field>;
    case 'update_field':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Field">
            {(id) => (
              <Select id={id} value={step.field} disabled={disabled} onChange={(e) => onChange({ ...step, field: e.target.value })}>
                {AUTOMATION_UPDATABLE_FIELDS.map((f) => <option key={f} value={f}>{humanize(f)}</option>)}
              </Select>
            )}
          </Field>
          <Field label="New value">{(id) => <Input id={id} value={String(step.value ?? '')} disabled={disabled} onChange={(e) => onChange({ ...step, value: e.target.value })} />}</Field>
        </div>
      );
    case 'create_task':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Task" className="sm:col-span-2" hint="Variables like {{first_name}} work here too.">{(id) => <Input id={id} value={step.title} disabled={disabled} onChange={(e) => onChange({ ...step, title: e.target.value })} />}</Field>
          <Field label="Due in (days)">{(id) => <Input id={id} type="number" min={0} value={step.dueInDays} disabled={disabled} onChange={(e) => onChange({ ...step, dueInDays: Number(e.target.value) })} />}</Field>
          <Field label="Assign to">
            {(id) => (
              <Select id={id} value={step.assigneeUserId ?? ''} disabled={disabled} onChange={(e) => onChange({ ...step, assigneeUserId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {members.data?.items.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
      );
    case 'notify':
      return (
        <div className="flex flex-col gap-3">
          <Field label="Notification">{(id) => <Input id={id} value={step.title} disabled={disabled} onChange={(e) => onChange({ ...step, title: e.target.value })} />}</Field>
          <Field label="Details (optional)">{(id) => <Textarea id={id} rows={2} value={step.body ?? ''} disabled={disabled} onChange={(e) => onChange({ ...step, body: e.target.value || null })} />}</Field>
          <Checkbox label="Also e-mail workspace admins" checked={Boolean(step.email)} disabled={disabled} onChange={(e) => onChange({ ...step, email: e.target.checked })} />
        </div>
      );
    case 'branch':
      return <CriteriaBuilder value={step.condition} onChange={(condition) => onChange({ ...step, condition })} />;
    case 'end':
      return <p className="text-sm text-muted">The run finishes here.</p>;
  }
}

/** Vertical flow editor: steps connected top to bottom, branches split into two lanes. */
export function StepsEditor({ steps, onChange, disabled, depth = 0 }: { steps: Step[]; onChange(s: Step[]): void; disabled?: boolean; depth?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const templates = useQuery({ queryKey: ['templates', 'published'], queryFn: () => api.templates.list({ status: 'published' }) });
  const names = new Map((templates.data?.items ?? []).map((t) => [t.id, t.name]));
  const insertAt = (i: number, type: StepType) => {
    const s = newStep(type, templates.data?.items[0]?.id ?? '');
    const next = [...steps];
    next.splice(i, 0, s);
    onChange(next);
    setOpen(s.id);
  };
  const update = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + dir, 0, s!);
    onChange(next);
  };

  return (
    <div className="flex flex-col">
      <AddStep onAdd={(t) => insertAt(0, t)} disabled={disabled} />
      {steps.map((s, i) => (
        <div key={s.id} className="flex flex-col">
          <div className={clsx('@container rounded-xl border bg-surface shadow-card', open === s.id ? 'border-accent' : 'border-line')}>
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">{ICONS[s.type]}</span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <p className="truncate text-sm font-medium text-ink">{STEP_LABELS[s.type]}</p>
                <p className="truncate text-xs text-muted">{summary(s, names)}</p>
              </button>
              <span className="hidden max-w-28 truncate font-mono text-[10px] text-muted @md:block" title={s.id}>{s.id}</span>
              {!disabled ? (
                <div className="flex shrink-0 items-center">
                  <button type="button" className="p-1 text-muted hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-3.5" /></button>
                  <button type="button" className="p-1 text-muted hover:text-ink disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-3.5" /></button>
                  <button type="button" className="p-1 text-muted hover:text-bad" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Delete step"><Trash2 className="size-3.5" /></button>
                </div>
              ) : null}
            </div>
            {open === s.id ? (
              <div className="border-t border-line px-4 py-4">
                <StepForm step={s} onChange={(n) => update(i, n)} disabled={disabled} />
              </div>
            ) : null}
            {s.type === 'branch' ? (
              <div className="grid gap-3 border-t border-line p-3 md:grid-cols-2">
                {(['then', 'else'] as const).map((lane) => (
                  <div key={lane} className="rounded-lg bg-surface-2/70 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{lane === 'then' ? 'If yes' : 'Otherwise'}</p>
                    {depth < 3 ? <StepsEditor steps={s[lane]} depth={depth + 1} disabled={disabled} onChange={(sub) => update(i, { ...s, [lane]: sub })} /> : <p className="text-xs text-muted">Branches can be nested three levels deep.</p>}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <AddStep onAdd={(t) => insertAt(i + 1, t)} disabled={disabled} />
        </div>
      ))}
      {!steps.length ? <p className="py-2 text-center text-xs text-muted">No steps{depth ? ' — the run continues after the branch' : ''}.</p> : null}
    </div>
  );
}

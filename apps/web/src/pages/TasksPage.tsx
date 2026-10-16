import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckSquare, Circle, CircleCheck, Plus, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../components/ui/button';
import { Card, EmptyState, ErrorState, Loading, PageHeader, Tabs } from '../components/ui/display';
import { Input } from '../components/ui/field';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import { useAction, useDocumentTitle } from '../lib/hooks';
import { useSession } from '../lib/session';

export default function TasksPage() {
  useDocumentTitle('Tasks');
  const { can } = useSession();
  const [view, setView] = useState<'open' | 'mine' | 'done'>('open');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const list = useQuery({ queryKey: ['tasks', view], queryFn: () => api.tasks.list({ status: view === 'done' ? 'done' : 'open', mine: view === 'mine' || undefined, pageSize: 200 }) });
  const create = useAction(() => api.tasks.create({ title, dueAt: due ? new Date(due).toISOString() : null }), { success: 'Task added', invalidate: [['tasks']], onSuccess: () => (setTitle(''), setDue('')) });
  const toggle = useAction((t: { id: string; done: boolean }) => api.tasks.update(t.id, { status: t.done ? 'open' : 'done' }), { invalidate: [['tasks'], ['dashboard']] });
  const now = Date.now();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate(undefined);
  };

  return (
    <>
      <PageHeader title="Tasks" description="Follow-ups for your team. Automations create them too — for example “call the lead who didn’t reply”." />
      {can('tasks:write') ? (
        <Card className="mb-4">
          <form onSubmit={submit} className="flex flex-wrap gap-2">
            <Input className="min-w-56 flex-1" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
            <Input className="w-auto" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
            <Button type="submit" variant="primary" icon={<Plus className="size-4" />} disabled={!title.trim()} loading={create.isPending}>Add</Button>
          </form>
        </Card>
      ) : null}
      <div className="mb-4">
        <Tabs value={view} onChange={setView} items={[{ value: 'open', label: 'Open' }, { value: 'mine', label: 'Assigned to me' }, { value: 'done', label: 'Done' }]} />
      </div>
      <Card padded={false}>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} retry={() => list.refetch()} /></div>
        ) : list.data!.items.length ? (
          <ul className="divide-y divide-line">
            {list.data!.items.map((t) => {
              const overdue = t.status === 'open' && t.dueAt && Date.parse(t.dueAt) < now;
              return (
                <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                  <button
                    onClick={() => toggle.mutate({ id: t.id, done: t.status === 'done' })}
                    disabled={!can('tasks:write')}
                    className="mt-0.5 text-muted hover:text-good disabled:opacity-50"
                    aria-label={t.status === 'done' ? 'Reopen task' : 'Complete task'}
                  >
                    {t.status === 'done' ? <CircleCheck className="size-5 text-good" /> : <Circle className="size-5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={clsx('text-sm', t.status === 'done' ? 'text-muted line-through' : 'text-ink')}>{t.title}</p>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      {t.contactName ? <Link to={`/contacts/${t.contactId}`} className="hover:underline">{t.contactName}</Link> : null}
                      {t.assigneeName ? <span>→ {t.assigneeName}</span> : null}
                      {t.dueAt ? <span className={overdue ? 'font-medium text-bad' : ''}>{overdue ? 'overdue, ' : ''}due {formatRelative(t.dueAt)}</span> : null}
                      {t.source === 'automation' ? <span className="flex items-center gap-1"><Sparkles className="size-3" /> from an automation</span> : null}
                    </p>
                    {t.description ? <p className="mt-1 text-xs text-ink-2">{t.description}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<CheckSquare className="size-5" />} title={view === 'done' ? 'Nothing completed yet' : 'No open tasks'} />
        )}
      </Card>
    </>
  );
}

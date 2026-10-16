import { useQuery } from '@tanstack/react-query';
import { FileText, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { MESSAGE_CATEGORY_LABELS, type MessageCategory, type TemplatePurpose } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, Loading, Notice, PageHeader, StatusBadge, Tabs } from '../../components/ui/display';
import { Field, Input, Select, Textarea } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatRelative, humanize } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';

const PURPOSES: TemplatePurpose[] = ['birthday', 'welcome', 'follow_up', 'newsletter', 'announcement', 'collaboration', 'work_anniversary', 're_engagement', 'project_completion', 'feedback', 'custom'];

const STARTER_HTML = `<p>Hi {{first_name}},</p>
<p>Write your message here.</p>
<p>— {{sender_name}}</p>
{{> footer}}`;

export default function TemplatesPage() {
  useDocumentTitle('Templates');
  const { can } = useSession();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | 'published' | 'draft' | 'archived'>('all');
  const list = useQuery({ queryKey: ['templates', status], queryFn: () => api.templates.list({ status: status === 'all' ? undefined : status }) });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.integrations.ai() });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'relationship' as MessageCategory, purpose: 'custom' as TemplatePurpose, brief: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (withAi: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let subject = 'Hello {{first_name}}';
      let html = STARTER_HTML;
      let previewText: string | null = null;
      if (withAi) {
        const draft = await api.ai.draft({ purpose: form.brief || humanize(form.purpose), category: form.category });
        subject = draft.subject ?? subject;
        html = draft.html ?? html;
        previewText = draft.previewText;
      }
      const t = await api.templates.create({ name: form.name, category: form.category, purpose: form.purpose, subject, previewText, html });
      navigate(`/templates/${t.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable e-mails with personalisation, safe fallbacks and version history. Published versions are what automations and campaigns send."
        actions={can('templates:write') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New template</Button> : null}
      />
      <div className="mb-4">
        <Tabs value={status} onChange={setStatus} items={[{ value: 'all', label: 'All' }, { value: 'published', label: 'Published' }, { value: 'draft', label: 'Drafts' }, { value: 'archived', label: 'Archived' }]} />
      </div>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => list.refetch()} />
      ) : list.data!.items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data!.items.map((t) => (
            <Link key={t.id} to={`/templates/${t.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-line-strong">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-ink group-hover:underline">{t.name}</p>
                  <StatusBadge status={t.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-2">{t.subject}</p>
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <Badge>{MESSAGE_CATEGORY_LABELS[t.category]}</Badge>
                  <Badge>{humanize(t.purpose)}</Badge>
                  {t.hasUnpublishedChanges ? <Badge tone="warn">Unpublished changes</Badge> : null}
                  <span className="ml-auto text-xs text-muted">v{t.version} · {formatRelative(t.updatedAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<FileText className="size-5" />} title="No templates here" />
        </Card>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New template"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            {ai.data?.enabled ? (
              <Button icon={<Sparkles className="size-4" />} disabled={!form.name.trim()} loading={busy} onClick={() => create(true)}>
                Draft with AI
              </Button>
            ) : null}
            <Button variant="primary" disabled={!form.name.trim()} loading={busy} onClick={() => create(false)}>
              Create blank
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="Name">{(id) => <Input id={id} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Client project wrap-up" />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" hint={form.category === 'marketing' ? 'Needs granted consent and an unsubscribe link.' : form.category === 'relationship' ? 'Personal notes: birthdays, follow-ups. Respects consent.' : 'Receipts and account e-mail only.'}>
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as MessageCategory })}>
                  <option value="relationship">Relationship</option>
                  <option value="marketing">Marketing</option>
                  <option value="transactional">Transactional</option>
                </Select>
              )}
            </Field>
            <Field label="Purpose">
              {(id) => (
                <Select id={id} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value as TemplatePurpose })}>
                  {PURPOSES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
                </Select>
              )}
            </Field>
          </div>
          {ai.data?.enabled ? (
            <Field label="Brief for AI (optional)" hint="AI only writes a draft. It never sees contact data and nothing is sent without you.">
              {(id) => <Textarea id={id} rows={3} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} placeholder="Thank a client after we shipped their analytics dashboard; invite them to a retro call." />}
            </Field>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Braces, Copy, History, Send, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AiSubjectSuggestionDTO, MessageCategory, VariableDefinition } from '@morrow/core';
import { ContactPicker } from '../../components/email/ContactPicker';
import { EmailPreview } from '../../components/email/EmailPreview';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, CardHeader, ErrorState, Loading, Notice, PageHeader, StatusBadge, Tabs } from '../../components/ui/display';
import { Field, Input, Select, Textarea } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, humanize } from '../../lib/format';
import { useAction, useDebounced, useDocumentTitle } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';
import { useToast } from '../../lib/toast';

interface Draft {
  name: string;
  category: MessageCategory;
  subject: string;
  previewText: string;
  html: string;
  text: string;
  missingPolicy: 'fallback' | 'skip';
}

type Target = 'subject' | 'previewText' | 'html';

export default function TemplateEditorPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const tpl = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const variables = useQuery({ queryKey: ['variables'], queryFn: () => api.templates.variables() });
  const snippets = useQuery({ queryKey: ['snippets'], queryFn: () => api.snippets.list() });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.integrations.ai() });
  const [d, setD] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [side, setSide] = useState<'preview' | 'text' | 'ai'>('preview');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [undo, setUndo] = useState<Draft | null>(null);
  const [tone, setTone] = useState('warm');
  const [instructions, setInstructions] = useState('');
  const [subjects, setSubjects] = useState<AiSubjectSuggestionDTO[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const refs = { subject: useRef<HTMLInputElement>(null), previewText: useRef<HTMLInputElement>(null), html: useRef<HTMLTextAreaElement>(null) };
  const lastFocus = useRef<Target>('html');
  useDocumentTitle(tpl.data?.name ?? 'Template');

  useEffect(() => {
    if (tpl.data && !d) {
      const v = tpl.data.draft;
      const initial: Draft = { name: tpl.data.name, category: tpl.data.category, subject: v.subject, previewText: v.previewText ?? '', html: v.html, text: v.text ?? '', missingPolicy: v.missingPolicy };
      setD(initial);
      setSaved(initial);
    }
  }, [tpl.data, d]);

  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(saved), [d, saved]);
  const live = useDebounced(d, 350);
  const render = useQuery({
    queryKey: ['template-render', id, live, contactId],
    queryFn: () => api.templates.renderContent({ subject: live!.subject, previewText: live!.previewText || null, html: live!.html, text: live!.text || null, missingPolicy: live!.missingPolicy, category: live!.category, contactId }),
    enabled: Boolean(live),
    retry: false,
  });

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const saveDraft = async () => {
    if (!d) return null;
    const res = await api.templates.update(id, { name: d.name, category: d.category, subject: d.subject, previewText: d.previewText || null, html: d.html, text: d.text || null, missingPolicy: d.missingPolicy });
    for (const w of res.warnings) toast.info(w);
    const next: Draft = { ...d, html: res.draft.html };
    setD(next);
    setSaved(next);
    await qc.invalidateQueries({ queryKey: ['template', id] });
    await qc.invalidateQueries({ queryKey: ['templates'] });
    return res;
  };
  const save = useAction(saveDraft, { success: 'Draft saved' });
  const publish = useAction(
    async () => {
      if (dirty) await saveDraft();
      return api.templates.publish(id);
    },
    { success: (t) => `Published version ${t.publishedVersion}`, invalidate: [['template', id], ['templates']] },
  );
  const test = useAction(
    async () => {
      if (dirty) await saveDraft();
      return api.templates.testSend(id, { which: 'draft', contactId });
    },
    { success: (r) => `Test sent to ${r.to}` },
  );
  const duplicate = useAction(() => api.templates.duplicate(id), { success: 'Duplicated', invalidate: [['templates']], onSuccess: (t) => navigate(`/templates/${t.id}`) });
  const archive = useAction(async (): Promise<unknown> => (tpl.data?.status === 'archived' ? api.templates.restore(id) : api.templates.archive(id)), { success: 'Updated', invalidate: [['template', id], ['templates']] });
  const versions = useQuery({ queryKey: ['template', id, 'versions'], queryFn: () => api.templates.versions(id), enabled: versionsOpen });

  if (tpl.isLoading || !d) return tpl.isError ? <ErrorState error={tpl.error} /> : <Loading />;
  const t = tpl.data!;
  const editable = can('templates:write') && t.status !== 'archived';
  const set = (patch: Partial<Draft>) => setD((cur) => (cur ? { ...cur, ...patch } : cur));

  const insert = (snippet: string) => {
    const target = lastFocus.current;
    const el = refs[target].current;
    const value = d[target];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set({ [target]: value.slice(0, start) + snippet + value.slice(end) } as Partial<Draft>);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const runAi = async (kind: 'rewrite' | 'subjects') => {
    setAiBusy(true);
    try {
      if (kind === 'rewrite') {
        const res = await api.ai.rewrite({ subject: d.subject, html: d.html, tone, instructions: instructions || undefined });
        setUndo(d);
        set({ subject: res.subject ?? d.subject, html: res.html ?? d.html, previewText: res.previewText ?? d.previewText });
        if (res.unknownVariables.length) toast.info(`AI used unknown variables: ${res.unknownVariables.join(', ')} — review before publishing.`);
        else toast.success('Draft rewritten. Review it, then save.');
      } else {
        setSubjects((await api.ai.subjects({ html: d.html, current: d.subject, count: 5 })).items);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setAiBusy(false);
    }
  };

  const grouped = (variables.data?.items ?? []).reduce<Record<string, VariableDefinition[]>>((acc, v) => {
    (acc[v.group] ??= []).push(v);
    return acc;
  }, {});
  const issues = render.data?.issues ?? [];

  return (
    <>
      <PageHeader
        back={<Link to="/templates" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Templates</Link>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t.name} <StatusBadge status={t.status} /> {t.hasUnpublishedChanges || dirty ? <Badge tone="warn">{dirty ? 'Unsaved changes' : 'Draft differs from published'}</Badge> : null}
          </span>
        }
        description={`Draft v${t.draft.version}${t.published ? ` · published v${t.published.version} on ${formatDateTime(t.published.publishedAt, workspace.timezone)}` : ' · never published'}`}
        actions={
          <>
            <Button variant="ghost" icon={<History className="size-4" />} onClick={() => setVersionsOpen(true)}>Versions</Button>
            {can('templates:write') ? <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => duplicate.mutate(undefined)}>Duplicate</Button> : null}
            {can('messages:test') && editable ? <Button icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate(undefined)}>Send test</Button> : null}
            {editable ? <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save draft</Button> : null}
            {can('templates:publish') && editable ? (
              <Button variant="primary" loading={publish.isPending} disabled={!dirty && !t.hasUnpublishedChanges && t.status === 'published'} onClick={() => publish.mutate(undefined)}>
                Publish
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">{(fid) => <Input id={fid} value={d.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} />}</Field>
              <Field label="Category" hint={d.category === 'transactional' ? 'Sent regardless of marketing consent. Only for receipts and account notices.' : 'Consent and unsubscribe rules apply.'}>
                {(fid) => (
                  <Select id={fid} value={d.category} disabled={!editable} onChange={(e) => set({ category: e.target.value as MessageCategory })}>
                    <option value="relationship">Relationship</option>
                    <option value="marketing">Marketing</option>
                    <option value="transactional">Transactional</option>
                  </Select>
                )}
              </Field>
              <Field label="Subject" className="sm:col-span-2">
                {(fid) => <Input id={fid} ref={refs.subject} value={d.subject} disabled={!editable} onFocus={() => (lastFocus.current = 'subject')} onChange={(e) => set({ subject: e.target.value })} />}
              </Field>
              <Field label="Preview text" hint="Shown next to the subject in most inboxes." className="sm:col-span-2">
                {(fid) => <Input id={fid} ref={refs.previewText} value={d.previewText} disabled={!editable} onFocus={() => (lastFocus.current = 'previewText')} onChange={(e) => set({ previewText: e.target.value })} />}
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Content (HTML)"
              description={'Use {{first_name}}, or {{first_name | default: "there"}} for a fallback. Unsafe markup (scripts, event handlers) is removed on save.'}
              action={
                <Select className="w-auto" value={d.missingPolicy} disabled={!editable} onChange={(e) => set({ missingPolicy: e.target.value as 'fallback' | 'skip' })} aria-label="When a variable is missing">
                  <option value="fallback">Missing data: use fallbacks</option>
                  <option value="skip">Missing data: skip the contact</option>
                </Select>
              }
            />
            <Textarea
              ref={refs.html}
              value={d.html}
              disabled={!editable}
              onFocus={() => (lastFocus.current = 'html')}
              onChange={(e) => set({ html: e.target.value })}
              rows={20}
              spellCheck={false}
              className="font-mono text-[12.5px] leading-relaxed"
              aria-label="HTML content"
            />
            {editable ? (
              <div className="mt-4 flex flex-col gap-3">
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"><Braces className="size-3.5" /> Insert variable</p>
                  {Object.entries(grouped).map(([group, vars]) => (
                    <div key={group} className="mb-1.5 flex flex-wrap items-center gap-1">
                      <span className="w-20 text-xs text-muted">{humanize(group)}</span>
                      {vars.map((v) => (
                        <button key={v.key} type="button" onClick={() => insert(`{{${v.key}}}`)} title={`${v.label} — e.g. ${v.sample}`} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-accent hover:text-ink">
                          {v.key}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                {snippets.data?.items.length ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="w-20 text-xs text-muted">Snippets</span>
                    {snippets.data.items.map((s) => (
                      <button key={s.id} type="button" onClick={() => insert(`{{> ${s.key}}}`)} title={s.name} className="rounded-md border border-line bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent-text hover:border-accent">
                        &gt; {s.key}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:h-fit">
          <Tabs
            value={side}
            onChange={setSide}
            items={[
              { value: 'preview', label: 'Preview' },
              { value: 'text', label: 'Plain text' },
              ...(ai.data?.enabled && can('ai:use') ? [{ value: 'ai' as const, label: <span className="flex items-center gap-1"><Sparkles className="size-3.5" /> AI assist</span> }] : []),
            ]}
          />
          {side === 'preview' ? (
            <Card>
              <div className="mb-4">
                <ContactPicker value={contactId} onChange={setContactId} />
              </div>
              {render.isError ? (
                <Notice tone="bad">{errorMessage(render.error)}</Notice>
              ) : render.data ? (
                <div className={render.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                  {render.data.eligibility && !render.data.eligibility.eligible ? (
                    <div className="mb-3">
                      <Notice tone="warn" title="This contact would not receive it">
                        {render.data.eligibility.reasons.map(humanize).join(', ')}
                      </Notice>
                    </div>
                  ) : null}
                  {render.data.html ? <EmailPreview html={render.data.html} subject={render.data.subject} previewText={render.data.previewText} /> : <p className="py-10 text-center text-sm text-muted">Fix the errors below to see a preview.</p>}
                  {render.data.fallbacksUsed.length ? <p className="mt-3 text-xs text-muted">Fallbacks used: {render.data.fallbacksUsed.join(', ')}</p> : null}
                </div>
              ) : (
                <Loading />
              )}
            </Card>
          ) : side === 'text' ? (
            <Card>
              <CardHeader title="Plain-text version" description="Leave empty to generate it from the HTML automatically." />
              <Textarea rows={14} value={d.text} disabled={!editable} onChange={(e) => set({ text: e.target.value })} className="font-mono text-xs" aria-label="Plain text" />
              {render.data && !d.text ? <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs text-ink-2">{render.data.text}</pre> : null}
            </Card>
          ) : (
            <Card>
              <CardHeader title="AI assist" description="Suggestions only. AI never sees your contacts and never sends anything." />
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Select className="w-auto" value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone">
                    {['warm', 'professional', 'friendly', 'concise', 'celebratory', 'formal'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
                  </Select>
                  <Input className="min-w-0 flex-1" placeholder="Extra instructions (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button icon={<Sparkles className="size-4" />} loading={aiBusy} onClick={() => runAi('rewrite')} disabled={!editable}>Rewrite draft</Button>
                  <Button variant="ghost" loading={aiBusy} onClick={() => runAi('subjects')}>Suggest subject lines</Button>
                  {undo ? <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => (setD(undo), setUndo(null))}>Undo rewrite</Button> : null}
                </div>
                {subjects.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                    {subjects.map((s) => (
                      <li key={s.subject} className="flex items-start gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{s.subject}</p>
                          <p className="text-xs text-muted">{s.rationale}</p>
                        </div>
                        {editable ? <Button size="sm" onClick={() => set({ subject: s.subject, previewText: s.previewText || d.previewText })}>Use</Button> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Card>
          )}

          {issues.length || render.data?.warnings.length ? (
            <Card>
              <CardHeader title="Checks" />
              <ul className="flex flex-col gap-2 text-sm">
                {issues.map((i, n) => (
                  <li key={n} className="flex items-start gap-2">
                    <AlertTriangle className={i.severity === 'error' ? 'mt-0.5 size-4 shrink-0 text-bad' : 'mt-0.5 size-4 shrink-0 text-warn'} />
                    <span><span className="font-medium">{i.severity === 'error' ? 'Error' : 'Warning'}</span> · {humanize(i.field)}{i.line ? ` line ${i.line}` : ''}: {i.message}</span>
                  </li>
                ))}
                {render.data?.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 text-ink-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
                    {w}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {can('templates:write') ? (
            <button className="self-start text-xs text-muted hover:text-ink" onClick={() => archive.mutate(undefined)}>
              {t.status === 'archived' ? 'Restore template' : 'Archive template'}
            </button>
          ) : null}
        </div>
      </div>

      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Version history" description="Published versions are immutable. Restoring copies a version into a new draft." size="lg">
        {versions.isLoading ? (
          <Loading />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {versions.data?.items.map((v) => (
              <li key={v.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    v{v.version} {v.publishedAt ? <Badge tone="good">Published {formatDateTime(v.publishedAt, workspace.timezone)}</Badge> : <Badge>Draft</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted">{v.subject}</p>
                </div>
                {editable && v.id !== t.draft.id ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await api.templates.restoreVersion(id, v.id);
                        setD(null);
                        await qc.invalidateQueries({ queryKey: ['template', id] });
                        setVersionsOpen(false);
                        toast.success(`Restored v${v.version} into the draft`);
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

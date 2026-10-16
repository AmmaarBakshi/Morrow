import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, Cake, CheckSquare, FileText, Mail, MessageSquare, Pencil, ShieldCheck, Sparkles, Trash2, UserPlus, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RELATIONSHIP_LABELS, type TimelineItemDTO } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Avatar, Badge, Card, CardHeader, ErrorState, Loading, Notice, PageHeader, StatusBadge } from '../../components/ui/display';
import { Input, Textarea } from '../../components/ui/field';
import { api } from '../../lib/api';
import { formatBirthday, formatDate, formatDateTime, formatRelative, humanize } from '../../lib/format';
import { useAction, useDocumentTitle } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';
import { ContactForm } from './ContactForm';

const TIMELINE_ICONS: Record<TimelineItemDTO['type'], ReactNode> = {
  message: <Mail className="size-3.5" />,
  event: <Zap className="size-3.5" />,
  note: <MessageSquare className="size-3.5" />,
  consent: <ShieldCheck className="size-3.5" />,
  task: <CheckSquare className="size-3.5" />,
  automation: <Sparkles className="size-3.5" />,
  created: <UserPlus className="size-3.5" />,
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-36 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children || '—'}</dd>
    </div>
  );
}

export default function ContactDetailPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const contact = useQuery({ queryKey: ['contact', id], queryFn: () => api.contacts.get(id) });
  const timeline = useQuery({ queryKey: ['contact', id, 'timeline'], queryFn: () => api.contacts.timeline(id, 100) });
  const consent = useQuery({ queryKey: ['contact', id, 'consent'], queryFn: () => api.contacts.consentHistory(id) });
  const [editing, setEditing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [note, setNote] = useState('');
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentSource, setConsentSource] = useState('');
  useDocumentTitle(contact.data?.fullName ?? 'Contact');

  const refresh = () => qc.invalidateQueries({ queryKey: ['contact', id] });
  const addNote = useAction(() => api.contacts.addNote(id, note), { success: 'Note added', invalidate: [['contact', id]], onSuccess: () => setNote('') });
  const archive = useAction(() => (contact.data?.status === 'archived' ? api.contacts.restore(id) : api.contacts.archive(id)), { success: (c) => (c.status === 'archived' ? 'Archived' : 'Restored'), invalidate: [['contact', id], ['contacts']] });
  const erase = useAction(() => api.contacts.erase(id), { success: 'Personal data erased', invalidate: [['contacts']], onSuccess: () => navigate('/contacts') });
  const grant = useAction(() => api.contacts.setConsent(id, { status: 'granted', source: consentSource }), { success: 'Consent recorded', invalidate: [['contact', id]], onSuccess: () => setConsentOpen(false) });

  if (contact.isLoading) return <Loading />;
  if (contact.isError || !contact.data) return <ErrorState error={contact.error} retry={() => contact.refetch()} />;
  const c = contact.data;

  return (
    <>
      <PageHeader
        back={
          <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Contacts
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <Avatar name={c.fullName} className="size-10 text-sm" />
            <span>
              {c.fullName}
              <span className="block text-sm font-normal text-muted">{[c.jobTitle, c.company].filter(Boolean).join(' at ') || RELATIONSHIP_LABELS[c.relationshipType]}</span>
            </span>
          </span>
        }
        actions={
          can('contacts:write') ? (
            <>
              <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Archive className="size-4" />} loading={archive.isPending} onClick={() => archive.mutate(undefined)}>
                {c.status === 'archived' ? 'Restore' : 'Archive'}
              </Button>
              {can('contacts:erase') ? (
                <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setErasing(true)}>
                  Erase
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      {c.suppression ? (
        <div className="mb-4">
          <Notice tone="bad" title={`No e-mail will be sent: ${humanize(c.suppression.reason)}`}>
            Suppressed since {formatDate(c.suppression.createdAt)} ({c.suppression.scope === 'all' ? 'all e-mail' : 'marketing and relationship e-mail'}). Lift it in Settings → Sending → Suppressions.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Profile" />
            <dl className="divide-y divide-line">
              <Detail label="E-mail">{c.email ? <span className="flex items-center gap-2">{c.email} {c.emailStatus !== 'valid' && c.emailStatus !== 'unknown' ? <StatusBadge status={c.emailStatus} /> : null}</span> : null}</Detail>
              <Detail label="Relationship">{RELATIONSHIP_LABELS[c.relationshipType]}</Detail>
              <Detail label="Birthday">
                {c.birthday ? (
                  <span className="flex items-center gap-1.5">
                    <Cake className="size-3.5 text-muted" /> {formatBirthday(c.birthday)}
                  </span>
                ) : null}
              </Detail>
              <Detail label="Work anniversary">{c.workAnniversary ? formatDate(c.workAnniversary) : null}</Detail>
              <Detail label="Tags">
                {c.tags.length ? (
                  <span className="flex flex-wrap gap-1">
                    {c.tags.map((t) => (
                      <Badge key={t.id}>{t.name}</Badge>
                    ))}
                  </span>
                ) : null}
              </Detail>
              <Detail label="Time zone">{c.timezone ?? `Workspace (${workspace.timezone})`}</Detail>
              <Detail label="Language">{c.language}</Detail>
              <Detail label="Source">{c.source}</Detail>
              {Object.entries(c.customFields).map(([k, v]) => (
                <Detail key={k} label={humanize(k)}>
                  {v === null ? null : String(v)}
                </Detail>
              ))}
              <Detail label="Last interaction">{c.lastInteractionAt ? formatRelative(c.lastInteractionAt) : null}</Detail>
              <Detail label="Last e-mailed">{c.lastEmailedAt ? formatRelative(c.lastEmailedAt) : null}</Detail>
              <Detail label="Added">{formatDateTime(c.createdAt, workspace.timezone)}</Detail>
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="Consent"
              description="Morrow checks consent before every send and again just before delivery."
              action={can('contacts:write') && c.consentStatus !== 'granted' ? <Button size="sm" onClick={() => setConsentOpen(true)}>Record consent</Button> : null}
            />
            <div className="mb-3 flex items-center gap-2 text-sm">
              <StatusBadge status={c.consentStatus} />
              <span className="text-ink-2">{c.consentSource ?? 'No source recorded'}</span>
            </div>
            <ul className="flex flex-col gap-2 text-[13px]">
              {consent.data?.items.map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-ink-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
                  <span>
                    {e.fromStatus ?? 'new'} → <strong className="text-ink">{e.toStatus}</strong> · {e.source}
                    {e.note ? ` — ${e.note}` : ''} <span className="text-muted">({formatRelative(e.createdAt)})</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card>
          <CardHeader title="Activity" description="E-mails, events, notes and automation steps, newest first." />
          {can('contacts:write') ? (
            <form
              className="mb-4 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) addNote.mutate(undefined);
              }}
            >
              <Textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" />
              <div className="flex justify-end">
                <Button size="sm" type="submit" variant="primary" disabled={!note.trim()} loading={addNote.isPending}>
                  Add note
                </Button>
              </div>
            </form>
          ) : null}
          {timeline.isLoading ? (
            <Loading />
          ) : (
            <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
              {timeline.data?.items.map((t) => (
                <li key={t.id} className="relative">
                  <span className="absolute -left-[29px] top-0.5 flex size-[18px] items-center justify-center rounded-full border border-line bg-surface text-muted">{TIMELINE_ICONS[t.type]}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{t.link ? <Link to={t.link} className="hover:underline">{t.title}</Link> : t.title}</p>
                    {t.status ? <StatusBadge status={t.status} /> : null}
                  </div>
                  {t.detail ? <p className="mt-0.5 whitespace-pre-line text-[13px] text-ink-2">{t.detail}</p> : null}
                  <p className="mt-0.5 text-xs text-muted" title={formatDateTime(t.at, workspace.timezone)}>
                    {formatRelative(t.at)}
                  </p>
                </li>
              ))}
              {!timeline.data?.items.length ? (
                <li className="text-sm text-muted">
                  <FileText className="mb-1 size-4" /> Nothing yet.
                </li>
              ) : null}
            </ol>
          )}
        </Card>
      </div>

      <Dialog open={editing} onClose={() => setEditing(false)} title={`Edit ${c.fullName}`} size="lg">
        <ContactForm
          initial={c}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await api.contacts.update(id, input);
            await refresh();
            setEditing(false);
          }}
        />
      </Dialog>

      <Dialog
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        title="Record consent"
        description="Only record consent the person actually gave you."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConsentOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!consentSource.trim()} loading={grant.isPending} onClick={() => grant.mutate(undefined)}>
              Mark as granted
            </Button>
          </>
        }
      >
        <Input placeholder="e.g. Signed up at DevConf booth, 2026-10-12" value={consentSource} onChange={(e) => setConsentSource(e.target.value)} aria-label="Consent source" autoFocus />
      </Dialog>

      <ConfirmDialog open={erasing} onClose={() => setErasing(false)} onConfirm={() => erase.mutate(undefined)} loading={erase.isPending} danger confirmLabel="Erase permanently" title={`Erase ${c.fullName}?`}>
        Removes their personal data for good (right to erasure). Delivery statistics stay, anonymised. Their address stays on the suppression list so they are never e-mailed again. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}

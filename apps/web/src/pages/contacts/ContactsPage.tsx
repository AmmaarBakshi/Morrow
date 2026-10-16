import { useQuery } from '@tanstack/react-query';
import { Archive, Download, Plus, Search, Tag, Upload, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CONSENT_STATUSES, RELATIONSHIP_LABELS, RELATIONSHIP_TYPES, type ConsentStatus, type ContactDTO } from '@morrow/core';
import { Button, ButtonLink, buttonClass } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Card, EmptyState, ErrorState, Loading, PageHeader, StatusBadge } from '../../components/ui/display';
import { Input, Select } from '../../components/ui/field';
import { DataTable, Pagination } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatBirthday, formatRelative } from '../../lib/format';
import { useAction, useDebounced, useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { ContactForm } from './ContactForm';

export default function ContactsPage() {
  useDocumentTitle('Contacts');
  const { can } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = useDebounced(q);
  const page = Number(params.get('page') ?? 1);
  const filter = {
    tag: params.get('tag') ?? undefined,
    relationshipType: params.get('type') ?? undefined,
    consent: (params.get('consent') as ConsentStatus | null) ?? undefined,
    status: (params.get('status') as 'active' | 'archived' | null) ?? 'active',
  };
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next, { replace: true });
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [bulkTag, setBulkTag] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['contacts', query, filter, page], queryFn: () => api.contacts.list({ q: query || undefined, ...filter, page, pageSize: 50, sort: 'created_at', dir: 'desc' }) });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api.tags.list() });
  const bulk = useAction((input: { action: 'archive' | 'restore' | 'add_tag' | 'remove_tag'; tag?: string }) => api.contacts.bulk({ ids: [...selected], ...input }), {
    success: (r) => `Updated ${r.affected} contact(s)`,
    invalidate: [['contacts'], ['tags']],
    onSuccess: () => {
      setSelected(new Set());
      setBulkTag(null);
    },
  });

  const exportHref = `/api/v1/contacts/export?${new URLSearchParams(Object.entries({ q: query, tag: filter.tag ?? '', relationshipType: filter.relationshipType ?? '', consent: filter.consent ?? '' }).filter(([, v]) => v)).toString()}`;

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you work with — clients, leads, developers, collaborators and subscribers."
        actions={
          <>
            {can('contacts:export') ? (
              <a href={exportHref} className={buttonClass('ghost')} download>
                <Download className="size-4" /> Export
              </a>
            ) : null}
            {can('contacts:import') ? (
              <ButtonLink to="/contacts/import" icon={<Upload className="size-4" />}>
                Import CSV
              </ButtonLink>
            ) : null}
            {can('contacts:write') ? (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Add contact
              </Button>
            ) : null}
          </>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Search name, e-mail or company" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
          </div>
          <Select className="w-auto" value={filter.tag ?? ''} onChange={(e) => setParam('tag', e.target.value)} aria-label="Tag">
            <option value="">All tags</option>
            {tags.data?.items.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={filter.relationshipType ?? ''} onChange={(e) => setParam('type', e.target.value)} aria-label="Relationship">
            <option value="">All relationships</option>
            {RELATIONSHIP_TYPES.map((t) => (
              <option key={t} value={t}>
                {RELATIONSHIP_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={filter.consent ?? ''} onChange={(e) => setParam('consent', e.target.value)} aria-label="Consent">
            <option value="">Any consent</option>
            {CONSENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={filter.status} onChange={(e) => setParam('status', e.target.value === 'active' ? '' : e.target.value)} aria-label="Status">
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
        </div>

        {selected.size ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-4 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            {bulkTag === null ? (
              <Button size="sm" variant="ghost" icon={<Tag className="size-3.5" />} onClick={() => setBulkTag('')}>
                Add tag
              </Button>
            ) : (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (bulkTag.trim()) bulk.mutate({ action: 'add_tag', tag: bulkTag.trim() });
                }}
              >
                <Input className="h-8 w-40" autoFocus placeholder="Tag name" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} />
                <Button size="sm" type="submit" variant="primary" loading={bulk.isPending}>
                  Apply
                </Button>
              </form>
            )}
            {filter.status === 'archived' ? (
              <Button size="sm" variant="ghost" onClick={() => bulk.mutate({ action: 'restore' })}>
                Restore
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => bulk.mutate({ action: 'archive' })}>
                Archive
              </Button>
            )}
            <button className="ml-auto text-xs text-muted hover:text-ink" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        ) : null}

        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div className="p-4">
            <ErrorState error={list.error} retry={() => list.refetch()} />
          </div>
        ) : (
          <>
            <DataTable<ContactDTO>
              rows={list.data!.items}
              rowKey={(c) => c.id}
              onRowClick={(c) => navigate(`/contacts/${c.id}`)}
              selected={can('contacts:write') ? selected : undefined}
              onSelect={can('contacts:write') ? setSelected : undefined}
              dim={list.isFetching}
              empty={
                <EmptyState
                  icon={<Users className="size-5" />}
                  title={query || filter.tag || filter.relationshipType || filter.consent ? 'No contacts match' : 'No contacts yet'}
                  description="Add people one by one or import a CSV from your CRM or spreadsheet."
                  action={can('contacts:import') ? <ButtonLink to="/contacts/import" variant="primary">Import contacts</ButtonLink> : undefined}
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  cell: (c) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.fullName}</p>
                      <p className="truncate text-xs text-muted">{c.email ?? 'No e-mail'}</p>
                    </div>
                  ),
                },
                { key: 'company', header: 'Company', cell: (c) => <span className="text-ink-2">{[c.jobTitle, c.company].filter(Boolean).join(' · ') || '—'}</span> },
                { key: 'type', header: 'Relationship', cell: (c) => RELATIONSHIP_LABELS[c.relationshipType] },
                { key: 'birthday', header: 'Birthday', cell: (c) => <span className="text-ink-2">{formatBirthday(c.birthday)}</span> },
                {
                  key: 'consent',
                  header: 'Consent',
                  cell: (c) => (c.suppression ? <StatusBadge status="suppressed" label={`Suppressed: ${c.suppression.reason.replace('_', ' ')}`} /> : <StatusBadge status={c.consentStatus} />),
                },
                {
                  key: 'tags',
                  header: 'Tags',
                  cell: (c) => (
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 3).map((t) => (
                        <Badge key={t.id}>{t.name}</Badge>
                      ))}
                      {c.tags.length > 3 ? <Badge>+{c.tags.length - 3}</Badge> : null}
                    </div>
                  ),
                },
                { key: 'last', header: 'Last contact', cell: (c) => <span className="text-xs text-muted">{formatRelative(c.lastInteractionAt ?? c.lastEmailedAt)}</span> },
              ]}
            />
            {list.data!.total > list.data!.pageSize ? (
              <Pagination
                page={page}
                pageSize={list.data!.pageSize}
                total={list.data!.total}
                onPage={(p) => {
                  const next = new URLSearchParams(params);
                  next.set('page', String(p));
                  setParams(next);
                }}
              />
            ) : null}
          </>
        )}
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add contact" size="lg">
        <ContactForm
          submitLabel="Add contact"
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            const c = await api.contacts.create(input);
            setAdding(false);
            navigate(`/contacts/${c.id}`);
          }}
        />
      </Dialog>
    </>
  );
}

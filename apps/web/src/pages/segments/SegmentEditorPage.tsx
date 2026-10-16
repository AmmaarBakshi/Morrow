import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { emptyCriteria, type CriteriaGroup } from '@morrow/core';
import { CriteriaBuilder } from '../../components/criteria/CriteriaBuilder';
import { Button } from '../../components/ui/button';
import { ConfirmDialog } from '../../components/ui/dialog';
import { Card, CardHeader, ErrorState, Loading, Notice, PageHeader } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { api, errorMessage } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useAction, useDebounced, useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';

export default function SegmentEditorPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['segment', id], queryFn: () => api.segments.get(id), enabled: !isNew });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState<CriteriaGroup>(emptyCriteria());
  const [loaded, setLoaded] = useState(isNew);
  const [archiving, setArchiving] = useState(false);
  useDocumentTitle(isNew ? 'New segment' : (existing.data?.name ?? 'Segment'));

  useEffect(() => {
    if (existing.data && !loaded) {
      setName(existing.data.name);
      setDescription(existing.data.description ?? '');
      setCriteria(existing.data.criteria);
      setLoaded(true);
    }
  }, [existing.data, loaded]);

  const live = useDebounced(criteria, 400);
  const preview = useQuery({ queryKey: ['segment-preview', live], queryFn: () => api.segments.preview(live, 8), enabled: loaded, retry: false });

  const save = useAction(
    () => (isNew ? api.segments.create({ name, description: description || null, criteria }) : api.segments.update(id, { name, description: description || null, criteria })),
    {
      success: 'Segment saved',
      invalidate: [['segments'], ['segment', id]],
      onSuccess: (s) => {
        if (isNew) navigate(`/segments/${s.id}`, { replace: true });
      },
    },
  );
  const archive = useAction(() => api.segments.archive(id), { success: 'Segment archived', invalidate: [['segments']], onSuccess: () => navigate('/segments') });

  if (!isNew && existing.isLoading) return <Loading />;
  if (!isNew && existing.isError) return <ErrorState error={existing.error} />;
  const editable = can('segments:write');

  return (
    <>
      <PageHeader
        back={<Link to="/segments" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Segments</Link>}
        title={isNew ? 'New segment' : name || 'Segment'}
        actions={
          editable ? (
            <>
              {!isNew ? <Button variant="ghost" onClick={() => setArchiving(true)}>Archive</Button> : null}
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!name.trim()}
                onClick={() => {
                  if (!name.trim()) return toast.error(new Error('Name the segment.'));
                  save.mutate(undefined);
                }}
              >
                Save segment
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">{(fid) => <Input id={fid} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rust developers" disabled={!editable} />}</Field>
              <Field label="Description">{(fid) => <Input id={fid} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" disabled={!editable} />}</Field>
            </div>
          </Card>
          <Card>
            <CardHeader title="Who belongs here" description="Conditions are evaluated in the database, so even large audiences stay fast." />
            <CriteriaBuilder value={criteria} onChange={setCriteria} />
          </Card>
        </div>
        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader title="Live preview" />
          {preview.isError ? (
            <Notice tone="warn">{errorMessage(preview.error)}</Notice>
          ) : preview.data ? (
            <div className={preview.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
              <p className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold">{formatNumber(preview.data.count)}</span>
                <span className="text-sm text-muted">matching contacts</span>
              </p>
              <ul className="mt-4 flex flex-col divide-y divide-line">
                {preview.data.sample.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 py-2 text-sm">
                    <Users className="size-3.5 text-muted" />
                    <Link to={`/contacts/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">{c.name}</Link>
                    <span className="truncate text-xs text-muted">{c.email}</span>
                  </li>
                ))}
              </ul>
              {!criteria.rules.length ? <p className="mt-3 text-xs text-muted">No conditions yet: every active contact matches.</p> : null}
            </div>
          ) : (
            <Loading />
          )}
        </Card>
      </div>
      <ConfirmDialog open={archiving} onClose={() => setArchiving(false)} onConfirm={() => archive.mutate(undefined)} loading={archive.isPending} title="Archive this segment?" confirmLabel="Archive">
        Campaigns and automations using it must be changed first. Contacts are not affected.
      </ConfirmDialog>
    </>
  );
}

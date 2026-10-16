import { useQuery } from '@tanstack/react-query';
import { Filter, Plus } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SegmentDTO } from '@morrow/core';
import { ButtonLink } from '../../components/ui/button';
import { Card, EmptyState, ErrorState, Loading, PageHeader } from '../../components/ui/display';
import { DataTable } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatNumber, formatRelative } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession } from '../../lib/session';

export default function SegmentsPage() {
  useDocumentTitle('Segments');
  const { can } = useSession();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['segments'], queryFn: () => api.segments.list() });
  return (
    <>
      <PageHeader
        title="Segments"
        description="Saved audiences. They update automatically as contacts change and power campaigns and automations."
        actions={can('segments:write') ? <ButtonLink to="/segments/new" variant="primary" icon={<Plus className="size-4" />}>New segment</ButtonLink> : null}
      />
      <Card padded={false}>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} retry={() => list.refetch()} /></div>
        ) : (
          <DataTable<SegmentDTO>
            rows={list.data!.items}
            rowKey={(s) => s.id}
            onRowClick={(s) => navigate(`/segments/${s.id}`)}
            empty={<EmptyState icon={<Filter className="size-5" />} title="No segments yet" description="Group contacts by relationship, tags, engagement, birthdays or custom fields." action={can('segments:write') ? <ButtonLink to="/segments/new" variant="primary">Create a segment</ButtonLink> : undefined} />}
            columns={[
              { key: 'name', header: 'Name', cell: (s) => <div><p className="font-medium">{s.name}</p>{s.description ? <p className="text-xs text-muted">{s.description}</p> : null}</div> },
              { key: 'rules', header: 'Rules', cell: (s) => <span className="line-clamp-2 text-ink-2">{s.summary}</span>, className: 'max-w-md' },
              { key: 'count', header: 'Contacts', align: 'right', cell: (s) => formatNumber(s.count) },
              { key: 'updated', header: 'Counted', cell: (s) => <span className="text-xs text-muted">{formatRelative(s.countedAt)}</span> },
            ]}
          />
        )}
      </Card>
    </>
  );
}

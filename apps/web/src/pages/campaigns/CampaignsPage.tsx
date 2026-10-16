import { useQuery } from '@tanstack/react-query';
import { Megaphone, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { CampaignDTO } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Card, EmptyState, ErrorState, Loading, Notice, PageHeader, StatusBadge, Tabs } from '../../components/ui/display';
import { Field, Input } from '../../components/ui/field';
import { DataTable } from '../../components/ui/table';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, formatNumber, formatPercent } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';

type Filter = 'all' | 'draft' | 'scheduled' | 'sending' | 'completed';

export default function CampaignsPage() {
  useDocumentTitle('Campaigns');
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const list = useQuery({ queryKey: ['campaigns', filter], queryFn: () => api.campaigns.list({ status: filter === 'all' ? undefined : filter }) });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.campaigns.create({ name });
      navigate(`/campaigns/${c.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="One-off e-mails to a segment: newsletters, launches, announcements. Every send is checked against consent and suppressions."
        actions={can('campaigns:write') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button> : null}
      />
      <div className="mb-4">
        <Tabs value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'draft', label: 'Drafts' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'sending', label: 'Sending' }, { value: 'completed', label: 'Completed' }]} />
      </div>
      <Card padded={false}>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} retry={() => list.refetch()} /></div>
        ) : (
          <DataTable<CampaignDTO>
            rows={list.data!.items}
            rowKey={(c) => c.id}
            onRowClick={(c) => navigate(`/campaigns/${c.id}`)}
            empty={<EmptyState icon={<Megaphone className="size-5" />} title="No campaigns here" description="Pick a segment and a published template, preview who gets it, then send or schedule." />}
            columns={[
              { key: 'name', header: 'Campaign', cell: (c) => <div><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.templateName ?? 'No template'} → {c.segmentName ?? 'No audience'}</p></div> },
              { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
              { key: 'when', header: 'When', cell: (c) => <span className="text-ink-2">{formatDateTime(c.launchedAt ?? c.scheduledAt, workspace.timezone)}</span> },
              { key: 'sent', header: 'Sent', align: 'right', cell: (c) => formatNumber(c.stats.counts.sent) },
              { key: 'delivered', header: 'Delivered', align: 'right', cell: (c) => formatPercent(c.stats.rates.deliveryRate) },
              { key: 'clicked', header: 'Clicked', align: 'right', cell: (c) => formatPercent(c.stats.rates.clickRate) },
            ]}
          />
        )}
      </Card>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New campaign"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={create}>Create draft</Button>
          </>
        }
      >
        {error ? <div className="mb-3"><Notice tone="bad">{error}</Notice></div> : null}
        <Field label="Name" hint="Only your team sees this.">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="November product update" />}</Field>
      </Dialog>
    </>
  );
}

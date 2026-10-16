import { useQuery } from '@tanstack/react-query';
import { Check, ClipboardCheck, Eye, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { MessageDTO } from '@morrow/core';
import { EmailPreview } from '../components/email/EmailPreview';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Card, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui/display';
import { Input } from '../components/ui/field';
import { DataTable, Pagination } from '../components/ui/table';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAction, useDocumentTitle } from '../lib/hooks';
import { useSession, useWorkspace } from '../lib/session';

export default function ApprovalsPage() {
  useDocumentTitle('Approvals');
  const { can } = useSession();
  const { workspace } = useWorkspace();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const list = useQuery({ queryKey: ['approvals', page], queryFn: () => api.approvals.list({ page, pageSize: 50 }) });
  const detail = useQuery({ queryKey: ['message', viewing], queryFn: () => api.messages.get(viewing!), enabled: Boolean(viewing) });
  const done = () => setSelected(new Set());
  const approve = useAction((ids: string[]) => api.approvals.approve(ids), { success: (r) => `Approved ${r.approved} — they will be sent shortly`, invalidate: [['approvals']], onSuccess: () => (done(), setViewing(null)) });
  const reject = useAction((ids: string[]) => api.approvals.reject(ids, note || undefined), { success: (r) => `Rejected ${r.rejected}`, invalidate: [['approvals']], onSuccess: () => (done(), setViewing(null), setNote('')) });
  const canApprove = can('messages:approve');

  return (
    <>
      <PageHeader
        title="Approvals"
        description="E-mails from automations in review mode wait here. Nothing is sent until someone approves it. Eligibility is checked again at send time."
        actions={
          canApprove && selected.size ? (
            <>
              <Button variant="ghost" icon={<X className="size-4" />} loading={reject.isPending} onClick={() => reject.mutate([...selected])}>Reject {selected.size}</Button>
              <Button variant="primary" icon={<Check className="size-4" />} loading={approve.isPending} onClick={() => approve.mutate([...selected])}>Approve {selected.size}</Button>
            </>
          ) : null
        }
      />
      <Card padded={false}>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <div className="p-4"><ErrorState error={list.error} retry={() => list.refetch()} /></div>
        ) : (
          <>
            <DataTable<MessageDTO>
              rows={list.data!.items}
              rowKey={(m) => m.id}
              selected={canApprove ? selected : undefined}
              onSelect={canApprove ? setSelected : undefined}
              onRowClick={(m) => setViewing(m.id)}
              dim={list.isFetching}
              empty={<EmptyState icon={<ClipboardCheck className="size-5" />} title="Nothing waiting for review" description="When an automation in review mode prepares an e-mail, it appears here." />}
              columns={[
                { key: 'to', header: 'To', cell: (m) => <div><p className="font-medium">{m.contactName ?? m.toEmail}</p><p className="text-xs text-muted">{m.toEmail}</p></div> },
                { key: 'subject', header: 'Subject', cell: (m) => <span className="line-clamp-1">{m.subject}</span> },
                { key: 'from', header: 'Automation', cell: (m) => (m.automationId ? <Link to={`/automations/${m.automationId}`} onClick={(e) => e.stopPropagation()} className="text-accent-text hover:underline">Open</Link> : '—') },
                { key: 'when', header: 'Planned for', cell: (m) => <span className="text-ink-2">{formatDateTime(m.scheduledFor ?? m.createdAt, workspace.timezone)}</span> },
                { key: 'view', header: '', cell: () => <Eye className="size-4 text-muted" /> },
              ]}
            />
            {list.data!.total > list.data!.pageSize ? <Pagination page={page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={setPage} /> : null}
          </>
        )}
      </Card>

      <Dialog
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title="Review e-mail"
        description={detail.data ? `To ${detail.data.toEmail} · from ${detail.data.fromName ?? ''} <${detail.data.fromEmail}>` : undefined}
        size="xl"
        footer={
          canApprove && viewing ? (
            <div className="flex w-full flex-wrap items-center gap-2">
              <Input className="min-w-0 flex-1" placeholder="Reason for rejecting (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="ghost" loading={reject.isPending} onClick={() => reject.mutate([viewing])}>Reject</Button>
              <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate([viewing])}>Approve and send</Button>
            </div>
          ) : null
        }
      >
        {detail.isLoading ? <Loading /> : detail.data ? <EmailPreview html={detail.data.html ?? ''} subject={detail.data.subject} /> : null}
      </Dialog>
    </>
  );
}

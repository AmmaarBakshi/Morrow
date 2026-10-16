import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type CreatedApiKeyDTO, type Role } from '@morrow/core';
import { Button } from '../../components/ui/button';
import { ConfirmDialog, Dialog } from '../../components/ui/dialog';
import { Avatar, Badge, Card, CardHeader, Loading, Notice, StatusBadge } from '../../components/ui/display';
import { Field, Input, Select } from '../../components/ui/field';
import { api } from '../../lib/api';
import { formatDate, formatRelative } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { useSession, useWorkspace } from '../../lib/session';
import { useToast } from '../../lib/toast';

function RoleSelect({ value, onChange, disabled, id }: { value: Role; onChange(r: Role): void; disabled?: boolean; id?: string }) {
  return (
    <Select id={id} className="w-auto" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} aria-label="Role">
      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </Select>
  );
}

export function TeamSettings() {
  const { can } = useSession();
  const { user } = useWorkspace();
  const toast = useToast();
  const manage = can('members:manage');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.workspace.members() });
  const invitations = useQuery({ queryKey: ['invitations'], queryFn: () => api.workspace.invitations(), enabled: manage });
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState<{ email: string; role: Role }>({ email: '', role: 'manager' });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const send = useAction(() => api.workspace.invite(invite.email, invite.role), { success: 'Invitation sent', invalidate: [['invitations']], onSuccess: (i) => (setInviting(false), setInviteLink(i.acceptUrl ?? null), setInvite({ email: '', role: 'manager' })) });
  const changeRole = useAction((v: { id: string; role: Role }) => api.workspace.updateMember(v.id, v.role), { success: 'Role updated', invalidate: [['members']] });
  const remove = useAction(() => api.workspace.removeMember(removing!.id), { success: 'Member removed', invalidate: [['members']], onSuccess: () => setRemoving(null) });
  const revoke = useAction((id: string) => api.workspace.revokeInvitation(id), { success: 'Invitation revoked', invalidate: [['invitations']] });

  return (
    <div className="flex flex-col gap-6">
      <Card padded={false}>
        <div className="p-5 pb-2">
          <CardHeader title="Members" description="Roles decide what each person can do. Checks happen on the server for every action." action={manage ? <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setInviting(true)}>Invite</Button> : null} />
        </div>
        {members.isLoading ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {members.data?.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={m.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{m.name} {m.userId === user.id ? <span className="text-muted">(you)</span> : null}</p>
                  <p className="text-xs text-muted">{m.email} · {m.lastLoginAt ? `last seen ${formatRelative(m.lastLoginAt)}` : 'never signed in'}</p>
                </div>
                {manage && m.userId !== user.id ? (
                  <>
                    <RoleSelect value={m.role} onChange={(role) => changeRole.mutate({ id: m.id, role })} />
                    <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: m.id, name: m.name })}>Remove</Button>
                  </>
                ) : (
                  <Badge>{ROLE_LABELS[m.role]}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {manage && invitations.data?.items.length ? (
        <Card>
          <CardHeader title="Pending invitations" />
          <ul className="divide-y divide-line">
            {invitations.data.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <Badge>{ROLE_LABELS[i.role]}</Badge>
                <span className="text-xs text-muted">expires {formatDate(i.expiresAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="What each role can do" />
        <dl className="grid gap-3 sm:grid-cols-2">
          {ROLES.map((r) => (
            <div key={r} className="rounded-lg bg-surface-2 p-3">
              <dt className="text-sm font-medium">{ROLE_LABELS[r]}</dt>
              <dd className="mt-0.5 text-xs text-ink-2">{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite a teammate" footer={<><Button variant="ghost" onClick={() => setInviting(false)}>Cancel</Button><Button variant="primary" disabled={!invite.email} loading={send.isPending} onClick={() => send.mutate(undefined)}>Send invitation</Button></>}>
        <div className="flex flex-col gap-4">
          <Field label="E-mail">{(id) => <Input id={id} type="email" autoFocus value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />}</Field>
          <Field label="Role" hint={ROLE_DESCRIPTIONS[invite.role]}>{(id) => <RoleSelect id={id} value={invite.role} onChange={(role) => setInvite({ ...invite, role })} />}</Field>
        </div>
      </Dialog>
      <Dialog open={Boolean(inviteLink)} onClose={() => setInviteLink(null)} title="Invitation sent" size="sm">
        <p className="text-sm text-ink-2">We e-mailed the link. You can also share it directly — it works once and expires in 7 days.</p>
        <div className="mt-3 flex gap-2">
          <Input readOnly value={inviteLink ?? ''} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
          <Button icon={<Copy className="size-4" />} onClick={() => navigator.clipboard.writeText(inviteLink ?? '').then(() => toast.success('Copied'))}>Copy</Button>
        </div>
      </Dialog>
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} danger title={`Remove ${removing?.name ?? ''}?`} confirmLabel="Remove">
        They lose access to this workspace immediately. Their past actions stay in the audit log.
      </ConfirmDialog>
    </div>
  );
}

export function ApiKeySettings() {
  const { can } = useSession();
  const toast = useToast();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.workspace.apiKeys(), enabled: can('api_keys:manage') });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ name: string; role: Role; expires: string }>({ name: '', role: 'manager', expires: '' });
  const [created, setCreated] = useState<CreatedApiKeyDTO | null>(null);
  const create = useAction(() => api.workspace.createApiKey({ name: form.name, role: form.role, expiresInDays: form.expires ? Number(form.expires) : null }), { invalidate: [['api-keys']], onSuccess: (k) => (setCreating(false), setCreated(k), setForm({ name: '', role: 'manager', expires: '' })) });
  const revoke = useAction((id: string) => api.workspace.revokeApiKey(id), { success: 'Key revoked', invalidate: [['api-keys']] });
  if (!can('api_keys:manage')) return <Notice>Only administrators can manage API keys.</Notice>;
  return (
    <div className="flex flex-col gap-6">
      <Card padded={false}>
        <div className="p-5 pb-2">
          <CardHeader title="API keys" description="For the CLI, the SDK, Cyphen services and scripts. A key never has more rights than the person who created it." action={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>Create key</Button>} />
        </div>
        {keys.isLoading ? (
          <Loading />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {keys.data?.items.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <KeyRound className="size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name} <code className="ml-1 font-mono text-xs text-muted">mrw_{k.prefix}_…</code></p>
                  <p className="text-xs text-muted">Created {formatDate(k.createdAt)} · {k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : 'never used'}{k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ''}</p>
                </div>
                <Badge>{ROLE_LABELS[k.role]}</Badge>
                {k.revokedAt ? <StatusBadge status="cancelled" label="Revoked" /> : <Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.id)}>Revoke</Button>}
              </li>
            ))}
            {!keys.data?.items.length ? <li className="px-5 py-8 text-center text-sm text-muted">No API keys yet.</li> : null}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Using a key" />
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink-2">{`# CLI
morrow --url ${window.location.origin} login --api-key mrw_…

# HTTP
curl -H "Authorization: Bearer mrw_…" ${window.location.origin}/api/v1/contacts

# TypeScript SDK
const morrow = new MorrowClient({ baseUrl: '${window.location.origin}', token: process.env.MORROW_API_KEY });
await morrow.events.record({ email: 'lead@example.com', name: 'proposal.sent' });`}</pre>
      </Card>
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create API key" footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!form.name} loading={create.isPending} onClick={() => create.mutate(undefined)}>Create</Button></>}>
        <div className="flex flex-col gap-4">
          <Field label="Name">{(id) => <Input id={id} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cyphen website sign-ups" />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role" hint={ROLE_DESCRIPTIONS[form.role]}>{(id) => <RoleSelect id={id} value={form.role} onChange={(role) => setForm({ ...form, role })} />}</Field>
            <Field label="Expires after (days)" hint="Empty = never">{(id) => <Input id={id} type="number" min={1} value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />}</Field>
          </div>
        </div>
      </Dialog>
      <Dialog open={Boolean(created)} onClose={() => setCreated(null)} title="Copy your new key" description="This is the only time the full key is shown. Morrow stores only a hash." size="sm">
        <div className="flex gap-2">
          <Input readOnly className="font-mono text-xs" value={created?.key ?? ''} aria-label="API key" onFocus={(e) => e.target.select()} />
          <Button icon={<Copy className="size-4" />} onClick={() => navigator.clipboard.writeText(created?.key ?? '').then(() => toast.success('Copied'))}>Copy</Button>
        </div>
      </Dialog>
    </div>
  );
}

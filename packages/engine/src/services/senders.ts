import { resolveMx, resolveTxt } from 'node:dns/promises';
import {
  ConflictError,
  emailDomain,
  isValidEmail,
  newId,
  NotFoundError,
  normalizeEmail,
  PreconditionError,
  randomToken,
  ValidationError,
  type DnsCheckDTO,
  type DnsRecordCheckDTO,
  type SenderDTO,
} from '@morrow/core';
import { fromBool, toBool, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import { sha256 } from '../crypto';
import type { Engine } from '../engine';

export function toSenderDTO(r: Row<'senders'>): SenderDTO {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    replyTo: r.reply_to,
    domain: r.domain,
    status: r.status as SenderDTO['status'],
    verifiedAt: r.verified_at,
    isDefault: toBool(r.is_default),
    createdAt: r.created_at,
  };
}

const DKIM_SELECTORS = ['resend', 'pm', 'google', 'default', 'selector1', 'selector2', 's1', 's2', 'k1', 'mail', 'dkim', 'mandrill', 'smtp'];

async function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error('DNS lookup timed out')), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function txt(name: string): Promise<string[] | null> {
  try {
    return (await withTimeout(resolveTxt(name))).map((parts) => parts.join(''));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    return null;
  }
}

/** Evaluate SPF/DKIM/DMARC/MX for a sending domain and explain what to fix. */
export async function checkDomainDns(domain: string, selectors: string[] = DKIM_SELECTORS, now = new Date()): Promise<DnsCheckDTO> {
  const d = domain.toLowerCase().replace(/\.$/, '');
  const [spfRecords, dmarcRecords, mxRecords] = await Promise.all([
    txt(d),
    txt(`_dmarc.${d}`),
    withTimeout(resolveMx(d)).catch((err: { code?: string }) => (err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? [] : null)),
  ]);

  let spf: DnsRecordCheckDTO;
  if (spfRecords === null) spf = { status: 'unknown', record: null, message: 'Could not query DNS. Try again later.' };
  else {
    const records = spfRecords.filter((r) => r.toLowerCase().startsWith('v=spf1'));
    if (records.length === 0) spf = { status: 'fail', record: null, message: `No SPF record. Add a TXT record on ${d} such as "v=spf1 include:<your provider> ~all".` };
    else if (records.length > 1) spf = { status: 'fail', record: records.join(' | '), message: 'Multiple SPF records found; receivers treat this as an error. Merge them into one.' };
    else if (/\+all\b/.test(records[0]!)) spf = { status: 'warn', record: records[0]!, message: 'SPF ends with +all, which lets anyone send as your domain. Use ~all or -all.' };
    else spf = { status: 'pass', record: records[0]!, message: 'SPF record found. Make sure it includes your e-mail provider.' };
  }

  let dmarc: DnsRecordCheckDTO;
  if (dmarcRecords === null) dmarc = { status: 'unknown', record: null, message: 'Could not query DNS. Try again later.' };
  else {
    const record = dmarcRecords.find((r) => r.toUpperCase().startsWith('V=DMARC1'));
    if (!record) dmarc = { status: 'fail', record: null, message: `No DMARC record. Add a TXT record on _dmarc.${d}, for example "v=DMARC1; p=none; rua=mailto:dmarc@${d}".` };
    else {
      const policy = /;\s*p=(\w+)/i.exec(record)?.[1]?.toLowerCase();
      dmarc =
        policy === 'none'
          ? { status: 'warn', record, message: 'DMARC is in monitoring mode (p=none). Move to quarantine or reject once reports look clean.' }
          : { status: 'pass', record, message: `DMARC policy: ${policy ?? 'set'}.` };
    }
  }

  let mx: DnsRecordCheckDTO;
  if (mxRecords === null) mx = { status: 'unknown', record: null, message: 'Could not query MX records.' };
  else if (mxRecords.length === 0) mx = { status: 'warn', record: null, message: 'No MX records: replies and bounces to this domain cannot be received.' };
  else mx = { status: 'pass', record: mxRecords.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`).join(', '), message: 'Domain can receive mail.' };

  const dkim = await Promise.all(
    [...new Set(selectors)].slice(0, 20).map(async (selector) => {
      const records = await txt(`${selector}._domainkey.${d}`);
      if (records === null) return { selector, status: 'unknown' as const, record: null, message: 'Lookup failed.' };
      const rec = records.find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
      return rec
        ? { selector, status: 'pass' as const, record: rec.length > 80 ? `${rec.slice(0, 80)}…` : rec, message: 'DKIM key published.' }
        : { selector, status: 'fail' as const, record: null, message: 'No DKIM key for this selector.' };
    }),
  );
  return { domain: d, checkedAt: now.toISOString(), spf, dmarc, mx, dkim };
}

/**
 * Sender identities. A sender must be verified (by clicking a link sent to
 * the address, or by an administrator confirming domain verification at the
 * provider) before campaigns and automations can use it.
 */
export class SendersService {
  constructor(private readonly e: Engine) {}

  async list(ctx: WorkspaceContext): Promise<SenderDTO[]> {
    authorize(ctx, 'workspace:read');
    const rows = await this.e.db.selectFrom('senders').selectAll().where('workspace_id', '=', ctx.workspaceId).orderBy('created_at', 'asc').execute();
    return rows.map(toSenderDTO);
  }

  async row(workspaceId: string, id: string): Promise<Row<'senders'>> {
    const r = await this.e.db.selectFrom('senders').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError('Sender', id);
    return r;
  }

  /** Default verified sender (or the first verified one). */
  async defaultSender(workspaceId: string): Promise<Row<'senders'> | null> {
    const rows = await this.e.db
      .selectFrom('senders')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'verified')
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc')
      .limit(1)
      .execute();
    return rows[0] ?? null;
  }

  /** A specific sender if verified, otherwise the default. */
  async resolve(workspaceId: string, senderId?: string | null): Promise<Row<'senders'> | null> {
    if (senderId) {
      const r = await this.e.db.selectFrom('senders').selectAll().where('id', '=', senderId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (r && r.status === 'verified') return r;
      return null;
    }
    return this.defaultSender(workspaceId);
  }

  async create(ctx: WorkspaceContext, input: { name: string; email: string; replyTo?: string | null; isDefault?: boolean }): Promise<SenderDTO> {
    authorize(ctx, 'workspace:manage');
    const email = normalizeEmail(input.email);
    if (!email) throw new ValidationError('Enter a valid sender address.', [{ path: 'email', message: 'Invalid e-mail address.' }]);
    const name = (input.name ?? '').replace(/[\r\n"<>]/g, '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Enter a sender name.', [{ path: 'name', message: 'Required.' }]);
    const replyTo = input.replyTo ? normalizeEmail(input.replyTo) : null;
    if (input.replyTo && !replyTo) throw new ValidationError('Reply-to must be a valid address.', [{ path: 'replyTo', message: 'Invalid e-mail address.' }]);
    const exists = await this.e.db.selectFrom('senders').select('id').where('workspace_id', '=', ctx.workspaceId).where('email', '=', email).executeTakeFirst();
    if (exists) throw new ConflictError('That sender address already exists.');
    const now = this.e.nowIso();
    const hasDefault = Boolean(await this.e.db.selectFrom('senders').select('id').where('workspace_id', '=', ctx.workspaceId).where('is_default', '=', 1).executeTakeFirst());
    const row: Row<'senders'> = {
      id: newId('snd'),
      workspace_id: ctx.workspaceId,
      name,
      email,
      reply_to: replyTo,
      domain: emailDomain(email),
      status: 'pending',
      verification_token_hash: null,
      verification_sent_at: null,
      verified_at: null,
      is_default: fromBool(input.isDefault || !hasDefault),
      created_at: now,
      updated_at: now,
    };
    await this.e.db.transaction().execute(async (trx) => {
      if (input.isDefault) await trx.updateTable('senders').set({ is_default: 0 }).where('workspace_id', '=', ctx.workspaceId).execute();
      await trx.insertInto('senders').values(row).execute();
    });
    await this.e.audit.record(ctx, 'sender.created', { type: 'sender', id: row.id }, { domain: row.domain });
    await this.sendVerification(ctx, row.id).catch((err) => this.e.log.warn('sender verification e-mail failed', { error: err as Error }));
    return toSenderDTO(await this.row(ctx.workspaceId, row.id));
  }

  /** E-mail a verification link to the sender address itself. */
  async sendVerification(ctx: WorkspaceContext, id: string): Promise<{ sent: boolean; verifyUrl?: string }> {
    authorize(ctx, 'workspace:manage');
    const sender = await this.row(ctx.workspaceId, id);
    if (sender.status === 'verified') return { sent: false };
    const token = randomToken(32);
    await this.e.db
      .updateTable('senders')
      .set({ verification_token_hash: sha256(token), verification_sent_at: this.e.nowIso(), updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .execute();
    const verifyUrl = `${this.e.config.publicUrl}/verify-sender/${token}`;
    const ws = await this.e.workspaces.row(ctx.workspaceId);
    await this.e.system.sendSystemEmail(
      ctx.workspaceId,
      {
        to: sender.email,
        subject: `Verify ${sender.email} for ${ws.name} on Morrow`,
        text: `Someone added ${sender.email} as a sender for ${ws.name} on Morrow.\n\nIf that was you, confirm this address:\n${verifyUrl}\n\nIf not, ignore this e-mail — nothing will be sent from this address.`,
        idempotencyKey: `sender-verify:${id}:${sha256(token).slice(0, 12)}`,
      },
      // The address being verified cannot itself be the sender yet.
      { allowUnverifiedFrom: { email: sender.email, name: sender.name } },
    );
    return { sent: true, ...(this.e.config.env !== 'production' ? { verifyUrl } : {}) };
  }

  /** Public endpoint: confirm a sender via the link it received. */
  async verifyToken(token: string): Promise<SenderDTO | null> {
    if (!token || token.length > 200) return null;
    const sender = await this.e.db.selectFrom('senders').selectAll().where('verification_token_hash', '=', sha256(token)).executeTakeFirst();
    if (!sender) return null;
    const sentAt = sender.verification_sent_at ? Date.parse(sender.verification_sent_at) : 0;
    if (this.e.now().getTime() - sentAt > 3 * 86_400_000) return null;
    await this.e.db
      .updateTable('senders')
      .set({ status: 'verified', verified_at: this.e.nowIso(), verification_token_hash: null, updated_at: this.e.nowIso() })
      .where('id', '=', sender.id)
      .execute();
    await this.e.audit.record(
      { workspaceId: sender.workspace_id, role: 'owner', actor: { type: 'system', id: null, label: 'Sender verification link' } },
      'sender.verified',
      { type: 'sender', id: sender.id },
      { method: 'link' },
    );
    return toSenderDTO({ ...sender, status: 'verified' });
  }

  /**
   * Administrators may confirm a sender whose domain is already verified at
   * the e-mail provider. Recorded in the audit log.
   */
  async markVerified(ctx: WorkspaceContext, id: string, note: string): Promise<SenderDTO> {
    authorize(ctx, 'integrations:manage');
    if (!note || note.trim().length < 5) throw new PreconditionError('Describe how the address or domain was verified.');
    await this.row(ctx.workspaceId, id);
    await this.e.db
      .updateTable('senders')
      .set({ status: 'verified', verified_at: this.e.nowIso(), verification_token_hash: null, updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .execute();
    await this.e.audit.record(ctx, 'sender.verified', { type: 'sender', id }, { method: 'admin', note: note.slice(0, 200) });
    return toSenderDTO(await this.row(ctx.workspaceId, id));
  }

  async update(ctx: WorkspaceContext, id: string, input: { name?: string; replyTo?: string | null; isDefault?: boolean }): Promise<SenderDTO> {
    authorize(ctx, 'workspace:manage');
    const sender = await this.row(ctx.workspaceId, id);
    const patch: Partial<Row<'senders'>> = { updated_at: this.e.nowIso() };
    if (input.name !== undefined) patch.name = input.name.replace(/[\r\n"<>]/g, '').trim().slice(0, 100) || sender.name;
    if (input.replyTo !== undefined) {
      if (input.replyTo && !isValidEmail(input.replyTo)) throw new ValidationError('Reply-to must be a valid address.');
      patch.reply_to = input.replyTo ? normalizeEmail(input.replyTo) : null;
    }
    await this.e.db.transaction().execute(async (trx) => {
      if (input.isDefault) {
        await trx.updateTable('senders').set({ is_default: 0 }).where('workspace_id', '=', ctx.workspaceId).execute();
        patch.is_default = 1;
      }
      await trx.updateTable('senders').set(patch).where('id', '=', id).execute();
    });
    await this.e.audit.record(ctx, 'sender.updated', { type: 'sender', id });
    return toSenderDTO(await this.row(ctx.workspaceId, id));
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'workspace:manage');
    await this.row(ctx.workspaceId, id);
    const inUse = await this.e.db
      .selectFrom('campaigns')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('sender_id', '=', id)
      .where('status', 'in', ['scheduled', 'sending', 'paused', 'pending_approval'])
      .executeTakeFirst();
    if (inUse) throw new PreconditionError('This sender is used by a scheduled or sending campaign.');
    await this.e.db.deleteFrom('senders').where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'sender.removed', { type: 'sender', id });
  }

  async dnsCheck(ctx: WorkspaceContext, id: string): Promise<DnsCheckDTO> {
    authorize(ctx, 'workspace:read');
    const sender = await this.row(ctx.workspaceId, id);
    return checkDomainDns(sender.domain, DKIM_SELECTORS, this.e.now());
  }
}

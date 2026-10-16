import { escapeHtml, PreconditionError, type JobDTO, type SystemHealthDTO } from '@morrow/core';
import { sql, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';
import type { PrepareResult } from './delivery';

export const MORROW_VERSION = '0.1.0';

function toJobDTO(r: Row<'jobs'>): JobDTO {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: r.run_at,
    lastError: r.last_error,
    dedupeKey: r.dedupe_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

export interface SystemEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

/** Operational concerns: system e-mail, health, metrics and job administration. */
export class SystemService {
  constructor(private readonly e: Engine) {}

  /**
   * Send an internal transactional e-mail (invitations, verification,
   * alerts) through the normal durable pipeline.
   */
  async sendSystemEmail(
    workspaceId: string,
    mail: SystemEmail,
    options: { allowUnverifiedFrom?: { email: string; name: string } } = {},
  ): Promise<PrepareResult> {
    const dev = this.e.config.env !== 'production';
    const fromConfig = this.e.config.systemFrom;
    const fromSender = fromConfig ? null : await this.e.senders.defaultSender(workspaceId);
    const from =
      fromConfig ??
      (fromSender ? { email: fromSender.email, name: fromSender.name } : null) ??
      (dev ? (options.allowUnverifiedFrom ?? { email: 'no-reply@morrow.local', name: 'Morrow' }) : null);
    if (!from) {
      throw new PreconditionError('Set MORROW_SYSTEM_FROM_EMAIL or verify a sender before Morrow can send system e-mail.');
    }
    const html = `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827;padding:24px">${escapeHtml(mail.text)
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, '<br>')}</body></html>`;
    return this.e.delivery.prepare({
      workspaceId,
      kind: 'system',
      category: 'transactional',
      idempotencyKey: `system:${mail.idempotencyKey}`,
      toEmail: mail.to,
      template: { templateId: null, versionId: null, subject: mail.subject, previewText: null, html, text: mail.text, missingPolicy: 'fallback', raw: true },
      sender: { email: from.email, name: from.name, replyTo: null },
      bypassConsent: true,
      bypassFrequencyCap: true,
    });
  }

  async health(workspaceId?: string): Promise<SystemHealthDTO> {
    const started = Date.now();
    let dbOk = true;
    try {
      await sql`select 1`.execute(this.e.db);
    } catch {
      dbOk = false;
    }
    const latencyMs = Date.now() - started;
    const queue = dbOk ? await this.e.queue.stats() : { byStatus: {}, byType: [], lagSeconds: 0, oldestQueuedAt: null, runningExpired: 0 };
    const state = dbOk
      ? await this.e.db.selectFrom('scheduler_state').selectAll().where('key', 'in', ['scheduler:heartbeat', 'scheduler:leader']).execute()
      : [];
    const heartbeat = state.find((s) => s.key === 'scheduler:heartbeat');
    const leader = state.find((s) => s.key === 'scheduler:leader');
    const secondsSinceTick = heartbeat ? Math.round((this.e.now().getTime() - Date.parse(heartbeat.updated_at)) / 1000) : null;
    const schedulerHealthy = secondsSinceTick !== null && secondsSinceTick < Math.max(120, (this.e.config.scheduler.intervalMs / 1000) * 4);
    const provider = workspaceId ? await this.e.integrations.resolveEmailProvider(workspaceId) : null;
    const ai = workspaceId ? await this.e.ai.status(workspaceId) : { enabled: false, provider: null, model: null };
    return {
      ok: dbOk && queue.runningExpired < 50,
      version: MORROW_VERSION,
      database: { ok: dbOk, dialect: this.e.dialect, latencyMs },
      queue: { byStatus: queue.byStatus, lagSeconds: queue.lagSeconds, oldestQueuedAt: queue.oldestQueuedAt, runningExpired: queue.runningExpired },
      scheduler: { lastTickAt: heartbeat?.updated_at ?? null, secondsSinceTick, leader: leader?.value ?? null, healthy: schedulerHealthy },
      email: { provider: provider?.name ?? this.e.config.defaultEmail?.provider ?? null, source: provider ? (provider.source === 'override' ? 'environment' : provider.source) : 'none' },
      ai: { enabled: ai.enabled, provider: ai.provider },
    };
  }

  /** Prometheus text exposition of operational metrics (no contact data). */
  async metrics(): Promise<string> {
    const lines: string[] = [];
    const stats = await this.e.queue.stats();
    lines.push('# HELP morrow_jobs Jobs by type and status.', '# TYPE morrow_jobs gauge');
    for (const r of stats.byType) lines.push(`morrow_jobs{type="${r.type}",status="${r.status}"} ${r.count}`);
    lines.push('# HELP morrow_queue_lag_seconds Age of the oldest runnable job.', '# TYPE morrow_queue_lag_seconds gauge', `morrow_queue_lag_seconds ${stats.lagSeconds}`);
    lines.push('# HELP morrow_jobs_stuck Running jobs with expired leases.', '# TYPE morrow_jobs_stuck gauge', `morrow_jobs_stuck ${stats.runningExpired}`);
    const since = new Date(this.e.now().getTime() - 86_400_000).toISOString();
    const msgs = await this.e.db
      .selectFrom('messages')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('created_at', '>=', since)
      .groupBy('status')
      .execute();
    lines.push('# HELP morrow_messages_24h Messages created in the last 24 hours by status.', '# TYPE morrow_messages_24h gauge');
    for (const m of msgs) lines.push(`morrow_messages_24h{status="${m.status}"} ${Number(m.n)}`);
    const hb = await this.e.db.selectFrom('scheduler_state').select('updated_at').where('key', '=', 'scheduler:heartbeat').executeTakeFirst();
    if (hb) {
      lines.push(
        '# HELP morrow_scheduler_seconds_since_tick Seconds since the scheduler last ran.',
        '# TYPE morrow_scheduler_seconds_since_tick gauge',
        `morrow_scheduler_seconds_since_tick ${Math.round((this.e.now().getTime() - Date.parse(hb.updated_at)) / 1000)}`,
      );
    }
    for (const [name, value] of Object.entries(this.e.workerMetrics())) {
      if (typeof value === 'number') lines.push(`morrow_worker_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  async jobs(ctx: WorkspaceContext, filter: { status?: string; type?: string; limit?: number } = {}): Promise<JobDTO[]> {
    authorize(ctx, 'system:read');
    return (await this.e.queue.list({ ...filter, workspaceId: ctx.workspaceId })).map(toJobDTO);
  }

  async retryJob(ctx: WorkspaceContext, id: string): Promise<boolean> {
    authorize(ctx, 'system:manage');
    const ok = await this.e.queue.retry(id, ctx.workspaceId);
    if (ok) {
      const job = await this.e.queue.get(id);
      // A failed send can be retried only while its message is still retryable.
      if (job?.type === 'email.send') {
        const messageId = String(JSON.parse(job.payload).messageId ?? '');
        await this.e.db
          .updateTable('messages')
          .set({ status: 'queued', error_code: null, error_message: null, error_class: null, failed_at: null, updated_at: this.e.nowIso() })
          .where('id', '=', messageId)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('status', '=', 'failed')
          .where('error_class', '=', 'transient')
          .execute();
      }
      await this.e.audit.record(ctx, 'job.retried', { type: 'job', id });
      this.e.nudgeWorker();
    }
    return ok;
  }

  async cancelJob(ctx: WorkspaceContext, id: string): Promise<boolean> {
    authorize(ctx, 'system:manage');
    const ok = await this.e.queue.cancel(id, ctx.workspaceId);
    if (ok) await this.e.audit.record(ctx, 'job.cancelled', { type: 'job', id });
    return ok;
  }
}

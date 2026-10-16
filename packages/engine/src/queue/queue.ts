/**
 * Durable job queue stored in the `jobs` table.
 *
 * - Jobs are claimed in batches with a lease (`locked_until`). Expired leases
 *   are reclaimed, so a crashed worker never loses work.
 * - PostgreSQL claims use `FOR UPDATE SKIP LOCKED` so many workers can poll
 *   concurrently; SQLite serialises writes, so a conditional UPDATE is atomic.
 * - `dedupe_key` is unique: enqueueing the same logical job twice is a no-op.
 * - Retryable failures back off exponentially with jitter; exhausted jobs go
 *   to `dead` (the dead-letter state); permanent failures go to `failed`.
 */
import { newId } from '@morrow/core';
import { fromJson, toJson, type Db, type DialectName, type Kysely, type Database, type Row } from '@morrow/db';
import type { Clock } from '../clock';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface Job<P = Record<string, unknown>> {
  id: string;
  type: string;
  workspaceId: string | null;
  payload: P;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  dedupeKey: string | null;
  lockedBy: string | null;
}

export interface EnqueueOptions {
  workspaceId?: string | null;
  runAt?: Date;
  priority?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface QueueStats {
  byStatus: Record<string, number>;
  byType: Array<{ type: string; status: string; count: number }>;
  oldestQueuedAt: string | null;
  /** Seconds the oldest runnable job has been waiting past its run time. */
  lagSeconds: number;
  runningExpired: number;
}

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 6 * 3_600_000;

/** Exponential backoff with ±20% jitter: 30s, 1m, 2m, 4m … capped at 6h. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + random() * 0.4));
}

function toJob(row: Row<'jobs'>): Job {
  return {
    id: row.id,
    type: row.type,
    workspaceId: row.workspace_id,
    payload: fromJson<Record<string, unknown>>(row.payload, {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    dedupeKey: row.dedupe_key,
    lockedBy: row.locked_by,
  };
}

export class JobQueue {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly dialect: DialectName,
    private readonly clock: Clock,
  ) {}

  /**
   * Add a job. Pass a transaction as `db` to enqueue atomically with other writes.
   * Returns `created: false` when a job with the same dedupe key already exists.
   */
  async enqueue(type: string, payload: Record<string, unknown>, options: EnqueueOptions = {}, db: Db = this.db): Promise<{ id: string; created: boolean }> {
    const now = this.clock.now().toISOString();
    const id = newId('job');
    const inserted = await db
      .insertInto('jobs')
      .values({
        id,
        workspace_id: options.workspaceId ?? null,
        type,
        payload: toJson(payload),
        status: 'queued',
        priority: options.priority ?? 0,
        run_at: (options.runAt ?? this.clock.now()).toISOString(),
        attempts: 0,
        max_attempts: options.maxAttempts ?? 8,
        dedupe_key: options.dedupeKey ?? null,
        locked_by: null,
        locked_until: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        finished_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) return { id: inserted.id, created: true };
    const existing = await db.selectFrom('jobs').select('id').where('dedupe_key', '=', options.dedupeKey ?? '').executeTakeFirst();
    return { id: existing?.id ?? id, created: false };
  }

  /** Atomically claim up to `limit` runnable jobs (queued and due, or running with an expired lease). */
  async claim(workerId: string, limit: number, leaseMs: number, types?: string[]): Promise<Job[]> {
    if (limit <= 0) return [];
    const now = this.clock.now();
    const nowIso = now.toISOString();
    let candidates = this.db
      .selectFrom('jobs')
      .select('id')
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'queued'), eb('run_at', '<=', nowIso)]),
          eb.and([eb('status', '=', 'running'), eb('locked_until', '<', nowIso)]),
        ]),
      )
      .orderBy('priority', 'desc')
      .orderBy('run_at', 'asc')
      .limit(limit);
    if (types?.length) candidates = candidates.where('type', 'in', types);
    if (this.dialect === 'postgres') candidates = candidates.forUpdate().skipLocked();

    const rows = await this.db
      .updateTable('jobs')
      .set((eb) => ({
        status: 'running',
        locked_by: workerId,
        locked_until: new Date(now.getTime() + leaseMs).toISOString(),
        attempts: eb('attempts', '+', 1),
        updated_at: nowIso,
      }))
      .where('id', 'in', candidates)
      .returningAll()
      .execute();
    // UPDATE … RETURNING does not preserve the sub-query order.
    rows.sort((a, b) => b.priority - a.priority || (a.run_at < b.run_at ? -1 : a.run_at > b.run_at ? 1 : 0));
    return rows.map(toJob);
  }

  async heartbeat(job: Job, leaseMs: number): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ locked_until: new Date(this.clock.now().getTime() + leaseMs).toISOString(), updated_at: this.clock.now().toISOString() })
      .where('id', '=', job.id)
      .where('locked_by', '=', job.lockedBy)
      .where('status', '=', 'running')
      .execute();
  }

  async complete(job: Job): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.db
      .updateTable('jobs')
      .set({ status: 'succeeded', locked_by: null, locked_until: null, finished_at: now, updated_at: now, last_error: null })
      .where('id', '=', job.id)
      .where('locked_by', '=', job.lockedBy)
      .execute();
  }

  /**
   * Record a failure. Retryable failures are re-queued with backoff until
   * `maxAttempts`; then the job is dead-lettered.
   */
  async fail(job: Job, error: string, options: { retryable: boolean; retryAfterMs?: number }): Promise<JobStatus> {
    const now = this.clock.now();
    const canRetry = options.retryable && job.attempts < job.maxAttempts;
    const status: JobStatus = canRetry ? 'queued' : options.retryable ? 'dead' : 'failed';
    const delay = Math.max(options.retryAfterMs ?? 0, backoffMs(job.attempts));
    await this.db
      .updateTable('jobs')
      .set({
        status,
        last_error: error.slice(0, 2000),
        locked_by: null,
        locked_until: null,
        run_at: canRetry ? new Date(now.getTime() + delay).toISOString() : job.runAt,
        finished_at: canRetry ? null : now.toISOString(),
        updated_at: now.toISOString(),
      })
      .where('id', '=', job.id)
      .where('locked_by', '=', job.lockedBy)
      .execute();
    return status;
  }

  /** Put a claimed job back for later without counting the attempt (pauses, rate limits). */
  async reschedule(job: Job, runAt: Date): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set((eb) => ({
        status: 'queued',
        locked_by: null,
        locked_until: null,
        run_at: runAt.toISOString(),
        attempts: eb('attempts', '-', 1),
        updated_at: this.clock.now().toISOString(),
      }))
      .where('id', '=', job.id)
      .where('locked_by', '=', job.lockedBy)
      .execute();
  }

  /** Release jobs held by a worker that is shutting down so others can pick them up immediately. */
  async releaseWorker(workerId: string): Promise<number> {
    const res = await this.db
      .updateTable('jobs')
      .set((eb) => ({ status: 'queued', locked_by: null, locked_until: null, attempts: eb('attempts', '-', 1), updated_at: this.clock.now().toISOString() }))
      .where('locked_by', '=', workerId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }

  async cancel(id: string, workspaceId?: string): Promise<boolean> {
    let q = this.db
      .updateTable('jobs')
      .set({ status: 'cancelled', finished_at: this.clock.now().toISOString(), updated_at: this.clock.now().toISOString() })
      .where('id', '=', id)
      .where('status', 'in', ['queued', 'failed', 'dead']);
    if (workspaceId) q = q.where('workspace_id', '=', workspaceId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0) > 0;
  }

  async cancelByDedupeKey(dedupeKey: string, db: Db = this.db): Promise<void> {
    await db
      .updateTable('jobs')
      .set({ status: 'cancelled', finished_at: this.clock.now().toISOString(), updated_at: this.clock.now().toISOString() })
      .where('dedupe_key', '=', dedupeKey)
      .where('status', '=', 'queued')
      .execute();
  }

  /** Move a dead or failed job back to the queue (operator action). */
  async retry(id: string, workspaceId?: string): Promise<boolean> {
    let q = this.db
      .updateTable('jobs')
      .set({ status: 'queued', attempts: 0, run_at: this.clock.now().toISOString(), finished_at: null, last_error: null, updated_at: this.clock.now().toISOString() })
      .where('id', '=', id)
      .where('status', 'in', ['dead', 'failed', 'cancelled']);
    if (workspaceId) q = q.where('workspace_id', '=', workspaceId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0) > 0;
  }

  async get(id: string): Promise<Row<'jobs'> | undefined> {
    return this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async list(filter: { workspaceId?: string; status?: string; type?: string; limit?: number } = {}): Promise<Row<'jobs'>[]> {
    let q = this.db.selectFrom('jobs').selectAll().orderBy('updated_at', 'desc').limit(Math.min(filter.limit ?? 50, 500));
    if (filter.workspaceId) q = q.where('workspace_id', '=', filter.workspaceId);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.type) q = q.where('type', '=', filter.type);
    return q.execute();
  }

  async stats(workspaceId?: string): Promise<QueueStats> {
    const nowIso = this.clock.now().toISOString();
    let grouped = this.db
      .selectFrom('jobs')
      .select(['type', 'status', (eb) => eb.fn.countAll<number>().as('count')])
      .groupBy(['type', 'status']);
    if (workspaceId) grouped = grouped.where('workspace_id', '=', workspaceId);
    const rows = await grouped.execute();
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.count);

    let oldestQ = this.db.selectFrom('jobs').select((eb) => eb.fn.min('run_at').as('oldest')).where('status', '=', 'queued').where('run_at', '<=', nowIso);
    if (workspaceId) oldestQ = oldestQ.where('workspace_id', '=', workspaceId);
    const oldest = (await oldestQ.executeTakeFirst())?.oldest ?? null;

    let expiredQ = this.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'running')
      .where('locked_until', '<', nowIso);
    if (workspaceId) expiredQ = expiredQ.where('workspace_id', '=', workspaceId);
    const expired = Number((await expiredQ.executeTakeFirst())?.n ?? 0);

    return {
      byStatus,
      byType: rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.count) })),
      oldestQueuedAt: oldest ? String(oldest) : null,
      lagSeconds: oldest ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(String(oldest))) / 1000)) : 0,
      runningExpired: expired,
    };
  }

  /** Delete finished jobs older than the retention window. */
  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - retentionDays * 86_400_000).toISOString();
    const res = await this.db
      .deleteFrom('jobs')
      .where('status', 'in', ['succeeded', 'cancelled'])
      .where('finished_at', '<', cutoff)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  }
}

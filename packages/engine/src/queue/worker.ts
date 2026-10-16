import { isMorrowError } from '@morrow/core';
import type { Logger } from '../logger';
import type { Job, JobQueue } from './queue';

/** Throw from a handler to control retry behaviour explicitly. */
export class JobError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'JobError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Return from a handler to put the job back without counting an attempt. */
export interface Reschedule {
  reschedule: Date;
}

export interface JobHelpers {
  heartbeat(): Promise<void>;
  log: Logger;
}

export type JobHandler = (job: Job, helpers: JobHelpers) => Promise<void | Reschedule>;

export interface WorkerOptions {
  id: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  /** Only process these job types (default: all registered). */
  types?: string[];
}

export interface WorkerMetrics {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  dead: number;
  rescheduled: number;
  totalMs: number;
  startedAt: string | null;
  lastPollAt: string | null;
}

function classify(err: unknown): { retryable: boolean; retryAfterMs?: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof JobError) return { retryable: err.retryable, retryAfterMs: err.retryAfterMs, message };
  const e = err as { retryable?: unknown; retryAfterMs?: unknown };
  if (typeof e?.retryable === 'boolean') {
    return { retryable: e.retryable, retryAfterMs: typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined, message };
  }
  // Validation/permission/not-found errors will not fix themselves on retry.
  if (isMorrowError(err) && err.code !== 'internal_error' && err.code !== 'unavailable') return { retryable: false, message };
  return { retryable: true, message };
}

/**
 * Polls the queue, runs handlers with bounded concurrency and records the
 * outcome. Safe to run many workers (processes) against one database.
 */
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  readonly metrics: WorkerMetrics = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    dead: 0,
    rescheduled: 0,
    totalMs: 0,
    startedAt: null,
    lastPollAt: null,
  };

  constructor(
    private readonly queue: JobQueue,
    private readonly options: WorkerOptions,
    private readonly log: Logger,
  ) {}

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  private async execute(job: Job): Promise<void> {
    const started = Date.now();
    const log = this.log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const handler = this.handlers.get(job.type);
    this.metrics.processed++;
    try {
      if (!handler) throw new JobError(`No handler registered for job type "${job.type}"`, { retryable: false });
      if (job.attempts > job.maxAttempts) {
        // A job that keeps crashing its worker (lease expiry) must not loop forever.
        throw new JobError('Exceeded maximum attempts (worker lease expired repeatedly)', { retryable: false });
      }
      const result = await handler(job, { heartbeat: () => this.queue.heartbeat(job, this.options.leaseMs), log });
      if (result && 'reschedule' in result) {
        await this.queue.reschedule(job, result.reschedule);
        this.metrics.rescheduled++;
      } else {
        await this.queue.complete(job);
        this.metrics.succeeded++;
      }
    } catch (err) {
      const c = classify(err);
      const status = await this.queue.fail(job, c.message, { retryable: c.retryable, retryAfterMs: c.retryAfterMs });
      if (status === 'queued') {
        this.metrics.retried++;
        log.warn('job failed, will retry', { error: c.message });
      } else if (status === 'dead') {
        this.metrics.dead++;
        log.error('job dead-lettered after retries', { error: c.message });
      } else {
        this.metrics.failed++;
        log.warn('job failed permanently', { error: c.message });
      }
    } finally {
      this.metrics.totalMs += Date.now() - started;
    }
  }

  /** Claim and run one batch. Returns the number of jobs processed. */
  async runOnce(): Promise<number> {
    const capacity = this.options.concurrency - this.inflight.size;
    if (capacity <= 0) return 0;
    this.metrics.lastPollAt = new Date().toISOString();
    const jobs = await this.queue.claim(this.options.id, capacity, this.options.leaseMs, this.options.types ?? this.registeredTypes);
    await Promise.all(
      jobs.map((job) => {
        const p = this.execute(job).finally(() => this.inflight.delete(p));
        this.inflight.add(p);
        return p;
      }),
    );
    return jobs.length;
  }

  /**
   * Process until no runnable jobs remain (tests, `morrow worker --once`).
   * Jobs scheduled in the future are left alone.
   */
  async drain(maxIterations = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxIterations; i++) {
      const n = await this.runOnce();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.metrics.startedAt = new Date().toISOString();
    this.log.info('worker started', { workerId: this.options.id, concurrency: this.options.concurrency, types: this.registeredTypes.length });
    const loop = async () => {
      while (this.running) {
        let processed = 0;
        try {
          if (this.inflight.size < this.options.concurrency) processed = await this.claimAndSpawn();
        } catch (err) {
          this.log.error('worker poll failed', { error: err as Error });
        }
        if (!this.running) break;
        if (processed === 0) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, this.options.pollIntervalMs);
          });
          this.wake = null;
        }
      }
    };
    void loop();
  }

  /** Non-blocking variant used by the long-running loop. */
  private async claimAndSpawn(): Promise<number> {
    const capacity = this.options.concurrency - this.inflight.size;
    if (capacity <= 0) return 0;
    this.metrics.lastPollAt = new Date().toISOString();
    const jobs = await this.queue.claim(this.options.id, capacity, this.options.leaseMs, this.options.types ?? this.registeredTypes);
    for (const job of jobs) {
      const p = this.execute(job).finally(() => {
        this.inflight.delete(p);
        this.wake?.();
      });
      this.inflight.add(p);
    }
    return jobs.length;
  }

  /** Wake the poll loop early (e.g. right after enqueueing). */
  nudge(): void {
    this.wake?.();
  }

  /** Stop polling, wait for in-flight jobs (up to `graceMs`), then release anything still held. */
  async stop(graceMs = 30_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    const all = Promise.allSettled([...this.inflight]);
    await Promise.race([all, new Promise((r) => setTimeout(r, graceMs))]);
    const released = await this.queue.releaseWorker(this.options.id);
    this.log.info('worker stopped', { workerId: this.options.id, released });
  }
}

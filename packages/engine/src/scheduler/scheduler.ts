import type { CalendarReport } from '../automation/triggers';
import type { Engine } from '../engine';

export interface SchedulerOptions {
  id: string;
  intervalMs: number;
}

export interface TickReport {
  at: string;
  leader: boolean;
  calendar: CalendarReport | null;
  scheduleFanouts: number;
  inactivityFanouts: number;
  segmentRunsStarted: number;
  campaignsLaunched: number;
  campaignsCompleted: number;
  maintenance: Record<string, number> | null;
  durationMs: number;
  errors: string[];
}

const LEADER_KEY = 'scheduler:leader';
const HEARTBEAT_KEY = 'scheduler:heartbeat';
const SEGMENT_SWEEP_MS = 15 * 60_000;
const MAINTENANCE_MS = 60 * 60_000;

/**
 * The scheduler turns time into work: it evaluates calendar and recurring
 * triggers, launches due campaigns and performs maintenance. It holds a
 * lease so only one instance is the active leader; if two run anyway,
 * idempotency keys make the overlap harmless.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking: Promise<TickReport> | null = null;
  private lastSegmentSweep = 0;
  private lastMaintenance = 0;

  constructor(
    private readonly e: Engine,
    private readonly options: SchedulerOptions,
  ) {}

  /** Acquire or renew the leader lease. */
  async acquireLeadership(): Promise<boolean> {
    const now = this.e.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - Math.max(3 * this.options.intervalMs, 90_000)).toISOString();
    const res = await this.e.db
      .updateTable('scheduler_state')
      .set({ value: this.options.id, updated_at: nowIso })
      .where('key', '=', LEADER_KEY)
      .where((eb) => eb.or([eb('value', '=', this.options.id), eb('updated_at', '<', staleBefore)]))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) > 0) return true;
    const inserted = await this.e.db
      .insertInto('scheduler_state')
      .values({ key: LEADER_KEY, value: this.options.id, updated_at: nowIso })
      .onConflict((oc) => oc.doNothing())
      .returning('key')
      .executeTakeFirst();
    return Boolean(inserted);
  }

  /** Run one scheduling pass. Safe to call manually (e.g. `morrow scheduler --once`). */
  async tick(options: { force?: boolean } = {}): Promise<TickReport> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick(options).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(options: { force?: boolean }): Promise<TickReport> {
    const started = Date.now();
    const now = this.e.now();
    const report: TickReport = {
      at: now.toISOString(),
      leader: false,
      calendar: null,
      scheduleFanouts: 0,
      inactivityFanouts: 0,
      segmentRunsStarted: 0,
      campaignsLaunched: 0,
      campaignsCompleted: 0,
      maintenance: null,
      durationMs: 0,
      errors: [],
    };
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        report.errors.push(`${name}: ${(err as Error).message}`);
        this.e.log.error('scheduler step failed', { step: name, error: err as Error });
        return null;
      }
    };
    report.leader = (await step('leadership', () => this.acquireLeadership())) ?? false;
    await step('heartbeat', () => this.e.triggers.stateSet(HEARTBEAT_KEY, this.options.id));
    if (!report.leader && !options.force) {
      report.durationMs = Date.now() - started;
      return report;
    }
    report.calendar = await step('calendar', () => this.e.triggers.evaluateCalendar(now));
    report.scheduleFanouts = (await step('schedules', () => this.e.triggers.evaluateSchedules(now))) ?? 0;
    report.inactivityFanouts = (await step('inactivity', () => this.e.triggers.evaluateInactivity(now))) ?? 0;
    if (options.force || now.getTime() - this.lastSegmentSweep >= SEGMENT_SWEEP_MS) {
      report.segmentRunsStarted = (await step('segments', () => this.e.triggers.sweepSegments())) ?? 0;
      this.lastSegmentSweep = now.getTime();
    }
    report.campaignsLaunched = (await step('campaigns.launch', () => this.e.campaigns.launchDue(now))) ?? 0;
    report.campaignsCompleted = (await step('campaigns.complete', () => this.e.campaigns.checkCompletion())) ?? 0;
    if (options.force || now.getTime() - this.lastMaintenance >= MAINTENANCE_MS) {
      report.maintenance = await step('maintenance', () => this.maintenance());
      this.lastMaintenance = now.getTime();
    }
    if (report.calendar?.runsStarted || report.scheduleFanouts || report.campaignsLaunched) this.e.nudgeWorker();
    report.durationMs = Date.now() - started;
    if (report.durationMs > this.options.intervalMs) {
      this.e.log.warn('scheduler tick took longer than its interval', { durationMs: report.durationMs, intervalMs: this.options.intervalMs });
    }
    return report;
  }

  /** Housekeeping: expired sessions, finished jobs, stale imports and old message bodies. */
  async maintenance(): Promise<Record<string, number>> {
    const sessions = await this.e.auth.pruneSessions();
    const jobs = await this.e.queue.prune(this.e.config.jobRetentionDays);
    const imports = await this.e.imports.purgeStale(7);
    let bodies = 0;
    const workspaces = await this.e.db.selectFrom('workspaces').select('id').execute();
    for (const ws of workspaces) {
      const { settings } = await this.e.workspaces.settings(ws.id);
      const cutoff = new Date(this.e.now().getTime() - settings.retention.messageBodyDays * 86_400_000).toISOString();
      const res = await this.e.db
        .updateTable('messages')
        .set({ html: null, text: null })
        .where('workspace_id', '=', ws.id)
        .where('created_at', '<', cutoff)
        .where('html', 'is not', null)
        .where('status', 'not in', ['queued', 'sending', 'pending_approval'])
        .executeTakeFirst();
      bodies += Number(res.numUpdatedRows ?? 0);
    }
    const webhooks = await this.e.db
      .deleteFrom('webhook_events')
      .where('received_at', '<', new Date(this.e.now().getTime() - 30 * 86_400_000).toISOString())
      .executeTakeFirst();
    return { sessions, jobs, imports, messageBodies: bodies, webhookEvents: Number(webhooks.numDeletedRows ?? 0) };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.e.log.info('scheduler started', { schedulerId: this.options.id, intervalMs: this.options.intervalMs });
    const loop = async () => {
      if (!this.running) return;
      await this.tick().catch((err) => this.e.log.error('scheduler tick failed', { error: err as Error }));
      if (this.running) this.timer = setTimeout(loop, this.options.intervalMs);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking.catch(() => undefined);
    // Release leadership so a standby instance can take over immediately.
    await this.e.db
      .deleteFrom('scheduler_state')
      .where('key', '=', LEADER_KEY)
      .where('value', '=', this.options.id)
      .execute()
      .catch(() => undefined);
    this.e.log.info('scheduler stopped', { schedulerId: this.options.id });
  }
}

import { hostname } from 'node:os';
import type { AiProvider } from '@morrow/ai';
import { randomToken } from '@morrow/core';
import { connectDatabase, migrateToLatest, type Database, type DatabaseHandle, type DialectName, type Kysely } from '@morrow/db';
import type { EmailProvider, ProviderEvent } from '@morrow/email';
import { AutomationExecutor } from './automation/executor';
import { TriggerService } from './automation/triggers';
import { systemClock, type Clock } from './clock';
import { loadConfig, type EngineConfig } from './config';
import { createLogger, type Logger } from './logger';
import { JobQueue } from './queue/queue';
import { JobError, Worker, type WorkerMetrics } from './queue/worker';
import { Scheduler } from './scheduler/scheduler';
import { AiService } from './services/ai';
import { AnalyticsService } from './services/analytics';
import { AuditService } from './services/audit';
import { AuthService } from './services/auth';
import { AutomationsService } from './services/automations';
import { CalendarService } from './services/calendar';
import { CampaignsService } from './services/campaigns';
import { ContactsService } from './services/contacts';
import { DashboardService } from './services/dashboard';
import { DeliveryService } from './services/delivery';
import { CustomFieldsService } from './services/fields';
import { ImportsService } from './services/imports';
import { IntegrationsService } from './services/integrations';
import { MessagesService } from './services/messages';
import { NotificationsService } from './services/notifications';
import { SegmentsService } from './services/segments';
import { SendersService } from './services/senders';
import { StarterService } from './services/starter';
import { SuppressionService } from './services/suppressions';
import { SystemService } from './services/system';
import { TagsService } from './services/tags';
import { TasksService } from './services/tasks';
import { TemplatesService } from './services/templates';
import { WorkspaceService } from './services/workspaces';

export interface EngineOptions {
  database: DatabaseHandle;
  config?: EngineConfig;
  clock?: Clock;
  logger?: Logger;
  /** Use this provider for every workspace (tests, local demos). */
  providerOverride?: EmailProvider;
  /** Use this AI provider for every workspace (tests). */
  aiOverride?: AiProvider;
}

/**
 * The Morrow engine: one object holding the database, configuration, durable
 * queue and every service. HTTP routes, the CLI, workers and the scheduler
 * all go through it, so they share the same permission checks and rules.
 */
export class Engine {
  readonly db: Kysely<Database>;
  readonly dialect: DialectName;
  readonly database: DatabaseHandle;
  readonly config: EngineConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly queue: JobQueue;
  readonly providerOverride?: EmailProvider;
  readonly aiOverride?: AiProvider;

  readonly audit: AuditService;
  readonly auth: AuthService;
  readonly workspaces: WorkspaceService;
  readonly starter: StarterService;
  readonly integrations: IntegrationsService;
  readonly suppressions: SuppressionService;
  readonly senders: SendersService;
  readonly delivery: DeliveryService;
  readonly messages: MessagesService;
  readonly notifications: NotificationsService;
  readonly tasks: TasksService;
  readonly system: SystemService;
  readonly fields: CustomFieldsService;
  readonly tags: TagsService;
  readonly contacts: ContactsService;
  readonly segments: SegmentsService;
  readonly imports: ImportsService;
  readonly templates: TemplatesService;
  readonly executor: AutomationExecutor;
  readonly triggers: TriggerService;
  readonly automations: AutomationsService;
  readonly campaigns: CampaignsService;
  readonly analytics: AnalyticsService;
  readonly dashboard: DashboardService;
  readonly calendar: CalendarService;
  readonly ai: AiService;

  private workers: Worker[] = [];

  constructor(options: EngineOptions) {
    this.database = options.database;
    this.db = options.database.db;
    this.dialect = options.database.dialect;
    this.config = options.config ?? loadConfig();
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger({ level: this.config.env === 'production' ? 'info' : 'debug', pretty: this.config.env !== 'production' });
    this.providerOverride = options.providerOverride;
    this.aiOverride = options.aiOverride;
    this.queue = new JobQueue(this.db, this.dialect, this.clock);

    this.audit = new AuditService(this);
    this.auth = new AuthService(this);
    this.workspaces = new WorkspaceService(this);
    this.starter = new StarterService(this);
    this.integrations = new IntegrationsService(this);
    this.suppressions = new SuppressionService(this);
    this.senders = new SendersService(this);
    this.delivery = new DeliveryService(this);
    this.messages = new MessagesService(this);
    this.notifications = new NotificationsService(this);
    this.tasks = new TasksService(this);
    this.system = new SystemService(this);
    this.fields = new CustomFieldsService(this);
    this.tags = new TagsService(this);
    this.contacts = new ContactsService(this);
    this.segments = new SegmentsService(this);
    this.imports = new ImportsService(this);
    this.templates = new TemplatesService(this);
    this.executor = new AutomationExecutor(this);
    this.triggers = new TriggerService(this);
    this.automations = new AutomationsService(this);
    this.campaigns = new CampaignsService(this);
    this.analytics = new AnalyticsService(this);
    this.dashboard = new DashboardService(this);
    this.calendar = new CalendarService(this);
    this.ai = new AiService(this);
  }

  now(): Date {
    return this.clock.now();
  }

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  /** A worker with every Morrow job handler registered. */
  createWorker(options: { id?: string; concurrency?: number; pollIntervalMs?: number; types?: string[] } = {}): Worker {
    const worker = new Worker(
      this.queue,
      {
        id: options.id ?? `worker:${hostname()}:${process.pid}:${randomToken(4)}`,
        concurrency: options.concurrency ?? this.config.worker.concurrency,
        pollIntervalMs: options.pollIntervalMs ?? this.config.worker.pollIntervalMs,
        leaseMs: this.config.worker.leaseMs,
        types: options.types,
      },
      this.log.child({ component: 'worker' }),
    );
    worker
      .register('email.send', (job) => this.delivery.send(job))
      .register('email.events', async (job) => {
        const p = job.payload as { workspaceId: string | null; provider: string; events: ProviderEvent[] };
        const result = await this.delivery.ingestEvents(p.workspaceId, p.provider, p.events ?? []);
        if (result.unknown.length) {
          // The message may not have its provider ID yet (event raced the send); retry later.
          await this.queue.enqueue('email.events', { ...p, events: result.unknown } as unknown as Record<string, unknown>, {
            workspaceId: p.workspaceId,
            runAt: new Date(this.now().getTime() + 60_000),
            maxAttempts: 1,
          });
          if (job.attempts >= job.maxAttempts) throw new JobError(`${result.unknown.length} event(s) matched no message`, { retryable: false });
        }
      })
      .register('automation.execute', (job) => this.executor.execute(job))
      .register('automation.fanout', (job) => this.triggers.handleFanout(job))
      .register('contact.changed', (job) => this.triggers.handleContactChanged(job))
      .register('campaign.dispatch', (job) => this.campaigns.dispatch(job));
    this.workers.push(worker);
    return worker;
  }

  createScheduler(options: { id?: string; intervalMs?: number } = {}): Scheduler {
    return new Scheduler(this, {
      id: options.id ?? `scheduler:${hostname()}:${process.pid}`,
      intervalMs: options.intervalMs ?? this.config.scheduler.intervalMs,
    });
  }

  /** Wake in-process workers early after enqueueing urgent work. */
  nudgeWorker(): void {
    for (const w of this.workers) w.nudge();
  }

  workerMetrics(): Partial<WorkerMetrics> {
    const total: Partial<WorkerMetrics> = {};
    for (const w of this.workers) {
      for (const [k, v] of Object.entries(w.metrics)) {
        if (typeof v === 'number') (total as Record<string, number>)[k] = ((total as Record<string, number>)[k] ?? 0) + v;
      }
    }
    return total;
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}

export interface CreateEngineOptions extends Omit<EngineOptions, 'database'> {
  databaseUrl?: string;
  database?: DatabaseHandle;
  migrate?: boolean;
}

/** Connect, optionally migrate, and build an engine. */
export async function createEngine(options: CreateEngineOptions = {}): Promise<Engine> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? (await connectDatabase(options.databaseUrl ?? process.env.DATABASE_URL ?? 'sqlite:./data/morrow.db'));
  if (options.migrate !== false) await migrateToLatest(database.db);
  return new Engine({ ...options, database, config });
}

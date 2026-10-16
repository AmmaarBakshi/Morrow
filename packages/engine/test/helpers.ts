import { createTestDatabase } from '@morrow/db/testing';
import { FakeProvider, type EmailProvider } from '@morrow/email';
import type { AiProvider } from '@morrow/ai';
import type { ContactCreateInput, Role } from '@morrow/core';
import { ManualClock } from '../src/clock';
import { testConfig, type EngineConfig } from '../src/config';
import type { WorkspaceContext } from '../src/context';
import { Engine } from '../src/engine';
import { silentLogger } from '../src/logger';

export interface Harness {
  engine: Engine;
  clock: ManualClock;
  provider: FakeProvider;
  ctx: WorkspaceContext;
  workspaceId: string;
  userId: string;
  senderId: string;
  drain(): Promise<number>;
  tick(): ReturnType<ReturnType<Engine['createScheduler']>['tick']>;
  contact(input: ContactCreateInput): Promise<string>;
  as(role: Role): WorkspaceContext;
  templateId(name: string): Promise<string>;
  automationId(name: string): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  start?: string;
  timezone?: string;
  provider?: EmailProvider;
  ai?: AiProvider;
  config?: Partial<EngineConfig>;
}

/**
 * A complete engine on an in-memory database with a manual clock and the
 * development e-mail provider: nothing leaves the process.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = await createTestDatabase();
  const clock = new ManualClock(options.start ?? '2027-03-06T12:00:00Z');
  const provider = new FakeProvider({ now: () => clock.now() });
  const engine = new Engine({
    database,
    config: testConfig(options.config),
    clock,
    logger: silentLogger,
    providerOverride: options.provider ?? provider,
    aiOverride: options.ai,
  });
  const { user, workspaceId } = await engine.auth.signup({
    email: 'owner@cyphen.dev',
    name: 'Ammaar',
    password: 'correct horse battery staple',
    workspaceName: 'Cyphen',
    timezone: options.timezone ?? 'Asia/Kolkata',
  });
  const ctx: WorkspaceContext = { workspaceId, role: 'owner', actor: { type: 'user', id: user.id, label: user.name } };
  const sender = await engine.senders.create(ctx, { name: 'Ammaar from Cyphen', email: 'hello@cyphen.dev' });
  await engine.senders.markVerified(ctx, sender.id, 'Domain verified at the provider (test)');
  await engine.workspaces.update(ctx, {
    settings: { companyAddress: '221B Residency Road, Bengaluru', variables: { collaboration_url: 'https://cyphen.dev/collaborate', latest_project_name: 'Orbit Analytics' } },
  });
  const worker = engine.createWorker({ id: 'test-worker', concurrency: 4, pollIntervalMs: 10 });
  const scheduler = engine.createScheduler({ id: 'test-scheduler', intervalMs: 30_000 });
  // Start every test from a clean slate: flush setup e-mail (sender verification) and forget it.
  await worker.drain();
  await engine.db.deleteFrom('messages').where('kind', '=', 'system').execute();
  await engine.db.deleteFrom('jobs').execute();
  provider.clear();
  return {
    engine,
    clock,
    provider,
    ctx,
    workspaceId,
    userId: user.id,
    senderId: sender.id,
    drain: () => worker.drain(),
    tick: () => scheduler.tick(),
    async contact(input) {
      return (await engine.contacts.create(ctx, input)).id;
    },
    as(role) {
      return { ...ctx, role };
    },
    async templateId(name) {
      const t = (await engine.templates.list(ctx)).find((x) => x.name === name);
      if (!t) throw new Error(`No template ${name}`);
      return t.id;
    },
    async automationId(name) {
      const a = (await engine.automations.list(ctx)).find((x) => x.name === name);
      if (!a) throw new Error(`No automation ${name}`);
      return a.id;
    },
    close: () => engine.close(),
  };
}

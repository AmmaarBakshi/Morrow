import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { createEngine, type Engine, type Scheduler, type Worker } from '@morrow/engine';
import { createApp } from './app';
import { nodeSocketIp } from './http/request';

export type RuntimeRole = 'server' | 'worker' | 'scheduler';

export interface RuntimeOptions {
  /** Which processes to run here. Default: all three (single-node install). */
  roles?: RuntimeRole[];
  port?: number;
  host?: string;
  databaseUrl?: string;
  /** Built web app to serve; `null` disables it. Default: apps/web/dist when present. */
  webDist?: string | null;
  engine?: Engine;
  trustProxy?: boolean;
  metricsToken?: string | null;
}

export interface Runtime {
  engine: Engine;
  url: string | null;
  roles: RuntimeRole[];
  stop(): Promise<void>;
}

/** Locate the built web app next to the server package (monorepo or Docker image). */
export function defaultWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../../web/dist'), resolve(here, '../web'), resolve(process.cwd(), 'apps/web/dist')]) {
    if (existsSync(resolve(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * Start Morrow. One process can run everything, or roles can be split across
 * processes and machines: they coordinate only through the database.
 */
export async function startRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const roles = options.roles ?? ['server', 'worker', 'scheduler'];
  const engine = options.engine ?? (await createEngine({ databaseUrl: options.databaseUrl }));
  const log = engine.log.child({ component: 'runtime' });

  let server: ServerType | null = null;
  let url: string | null = null;
  let worker: Worker | null = null;
  let scheduler: Scheduler | null = null;

  if (roles.includes('worker')) {
    worker = engine.createWorker();
    worker.start();
    log.info('worker started', { concurrency: engine.config.worker.concurrency });
  }
  if (roles.includes('scheduler')) {
    scheduler = engine.createScheduler();
    scheduler.start();
    log.info('scheduler started', { intervalMs: engine.config.scheduler.intervalMs });
  }
  if (roles.includes('server')) {
    const port = options.port ?? Number(process.env.PORT ?? 4400);
    const host = options.host ?? process.env.HOST ?? '0.0.0.0';
    const webDist = options.webDist === undefined ? defaultWebDist() : options.webDist;
    const app = createApp({
      engine,
      webDist,
      trustProxy: options.trustProxy ?? ['1', 'true', 'yes'].includes((process.env.MORROW_TRUST_PROXY ?? '').toLowerCase()),
      metricsToken: options.metricsToken ?? process.env.MORROW_METRICS_TOKEN ?? null,
      socketIp: nodeSocketIp,
    });
    await new Promise<void>((done) => {
      server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${info.port}`;
        done();
      });
    });
    log.info('http server listening', { url, publicUrl: engine.config.publicUrl, web: webDist ? 'enabled' : 'api only' });
  }

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      log.info('shutting down');
      const s = server as ServerType | null;
      if (s) await new Promise<void>((done) => s.close(() => done()));
      await scheduler?.stop();
      await worker?.stop();
      if (!options.engine) await engine.close();
      log.info('stopped');
    })());

  return { engine, url, roles, stop };
}

/** Stop cleanly on SIGINT/SIGTERM so leased jobs are released, not left to expire. */
export function handleSignals(runtime: Runtime): void {
  let count = 0;
  const onSignal = (signal: string) => {
    count += 1;
    if (count > 1) process.exit(1);
    runtime.engine.log.info('signal received', { signal });
    runtime
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

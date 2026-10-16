import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase, migrateToLatest, type DatabaseHandle } from '@morrow/db';
import { ManualClock } from '../src/clock';
import { silentLogger } from '../src/logger';
import { backoffMs, JobQueue } from '../src/queue/queue';
import { JobError, Worker } from '../src/queue/worker';

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe(`job queue on ${dialect}`, () => {
    let h: DatabaseHandle;
    let clock: ManualClock;
    let queue: JobQueue;

    beforeAll(async () => {
      h = await connectDatabase(dialect === 'sqlite' ? 'sqlite::memory:' : 'pglite:memory');
      await migrateToLatest(h.db);
    });
    afterAll(async () => h.close());
    beforeEach(async () => {
      await h.db.deleteFrom('jobs').execute();
      clock = new ManualClock('2026-03-07T00:00:00Z');
      queue = new JobQueue(h.db, h.dialect, clock);
    });

    it('de-duplicates jobs by dedupe key', async () => {
      const a = await queue.enqueue('email.send', { messageId: 'msg_1' }, { dedupeKey: 'send:msg_1' });
      const b = await queue.enqueue('email.send', { messageId: 'msg_1' }, { dedupeKey: 'send:msg_1' });
      expect(a.created).toBe(true);
      expect(b).toEqual({ id: a.id, created: false });
      expect((await queue.stats()).byStatus.queued).toBe(1);
    });

    it('never hands the same job to two concurrent claimers', async () => {
      for (let i = 0; i < 20; i++) await queue.enqueue('t', { i });
      const [a, b, c] = await Promise.all([queue.claim('w1', 10, 60_000), queue.claim('w2', 10, 60_000), queue.claim('w3', 10, 60_000)]);
      const ids = [...a, ...b, ...c].map((j) => j.id);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    });

    it('respects run_at and priority', async () => {
      await queue.enqueue('t', { n: 'later' }, { runAt: new Date('2026-03-07T01:00:00Z') });
      await queue.enqueue('t', { n: 'low' }, { priority: 0 });
      await queue.enqueue('t', { n: 'high' }, { priority: 10 });
      const twoHours = 7_200_000;
      const jobs = await queue.claim('w', 10, twoHours);
      expect(jobs.map((j) => j.payload.n)).toEqual(['high', 'low']);
      clock.advanceMinutes(61);
      expect((await queue.claim('w', 10, twoHours)).map((j) => j.payload.n)).toEqual(['later']);
    });

    it('reclaims jobs whose worker died (expired lease)', async () => {
      await queue.enqueue('t', {});
      const [first] = await queue.claim('crashed-worker', 1, 60_000);
      expect(await queue.claim('w2', 1, 60_000)).toEqual([]);
      clock.advanceMinutes(2);
      const [again] = await queue.claim('w2', 1, 60_000);
      expect(again!.id).toBe(first!.id);
      expect(again!.attempts).toBe(2);
      // The crashed worker can no longer complete a job it lost.
      await queue.complete(first!);
      expect((await queue.get(first!.id))!.status).toBe('running');
    });

    it('retries with exponential backoff, then dead-letters', async () => {
      await queue.enqueue('t', {}, { maxAttempts: 2 });
      const [j1] = await queue.claim('w', 1, 60_000);
      expect(await queue.fail(j1!, 'boom', { retryable: true })).toBe('queued');
      expect(await queue.claim('w', 1, 60_000)).toEqual([]);
      clock.advanceMinutes(5);
      const [j2] = await queue.claim('w', 1, 60_000);
      expect(await queue.fail(j2!, 'boom again', { retryable: true })).toBe('dead');
      const row = await queue.get(j2!.id);
      expect(row!.status).toBe('dead');
      expect(row!.last_error).toBe('boom again');
      expect(await queue.retry(j2!.id)).toBe(true);
      expect((await queue.get(j2!.id))!.status).toBe('queued');
    });

    it('marks permanent failures failed without retrying', async () => {
      await queue.enqueue('t', {});
      const [j] = await queue.claim('w', 1, 60_000);
      expect(await queue.fail(j!, 'invalid address', { retryable: false })).toBe('failed');
    });

    it('honours Retry-After when it is longer than the backoff', async () => {
      await queue.enqueue('t', {});
      const [j] = await queue.claim('w', 1, 60_000);
      await queue.fail(j!, 'rate limited', { retryable: true, retryAfterMs: 3_600_000 });
      expect((await queue.get(j!.id))!.run_at).toBe('2026-03-07T01:00:00.000Z');
    });

    it('reports stats and scheduler lag', async () => {
      await queue.enqueue('a', {});
      clock.advanceMinutes(10);
      const stats = await queue.stats();
      expect(stats.byStatus.queued).toBe(1);
      expect(stats.lagSeconds).toBe(600);
    });

    it('runs handlers through the worker and records outcomes', async () => {
      const worker = new Worker(queue, { id: 'w', concurrency: 3, pollIntervalMs: 10, leaseMs: 60_000 }, silentLogger);
      const seen: string[] = [];
      worker.register('ok', async (job) => {
        seen.push(String(job.payload.n));
      });
      worker.register('flaky', async () => {
        throw new JobError('try later', { retryable: true });
      });
      worker.register('bad', async () => {
        throw new JobError('never', { retryable: false });
      });
      worker.register('wait', async () => ({ reschedule: new Date('2026-03-08T00:00:00Z') }));
      await queue.enqueue('ok', { n: 1 });
      await queue.enqueue('ok', { n: 2 });
      await queue.enqueue('flaky', {});
      await queue.enqueue('bad', {});
      const waitJob = await queue.enqueue('wait', {});
      await worker.drain();
      expect(seen.sort()).toEqual(['1', '2']);
      expect(worker.metrics).toMatchObject({ succeeded: 2, retried: 1, failed: 1, rescheduled: 1 });
      const rescheduled = await queue.get(waitJob.id);
      expect(rescheduled).toMatchObject({ status: 'queued', attempts: 0, run_at: '2026-03-08T00:00:00.000Z' });
    });

    it('prunes old finished jobs', async () => {
      await queue.enqueue('t', {});
      const [j] = await queue.claim('w', 1, 60_000);
      await queue.complete(j!);
      clock.advanceDays(31);
      expect(await queue.prune(30)).toBe(1);
    });
  });
}

describe('backoff', () => {
  it('grows exponentially within jitter bounds and caps at 6 hours', () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(5, mid)).toBe(480_000);
    expect(backoffMs(30, mid)).toBe(6 * 3_600_000);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
  });
});

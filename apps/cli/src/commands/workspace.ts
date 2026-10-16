import pc from 'picocolors';
import type { MessageCounts, MessageRates, Role } from '@morrow/sdk';
import { formatDate, formatPercent, statusColor } from '../output';
import type { Register } from './ops';

/** analytics, calendar, tasks, health, queue and API keys. */
export const registerWorkspace: Register = (program, run) => {
  program
    .command('analytics')
    .description('delivery and engagement for a date range (workspace time zone)')
    .option('--from <date>', 'YYYY-MM-DD (default: 30 days ago)')
    .option('--to <date>', 'YYYY-MM-DD (default: today)')
    .option('--campaigns', 'compare campaigns')
    .option('--automations', 'compare automations')
    .action(
      run(async (ctx, o: { from?: string; to?: string; campaigns?: boolean; automations?: boolean }) => {
        const client = ctx.client();
        const range = { from: o.from, to: o.to };
        if (o.campaigns || o.automations) {
          const res: { items: Array<{ name: string; counts: MessageCounts; rates: MessageRates }> } = o.campaigns ? await client.analytics.campaigns(range) : await client.analytics.automations(range);
          ctx.output.result(res, () =>
            ctx.output.table(res.items, [
              { label: 'Name', value: (r) => r.name, max: 32 },
              { label: 'Sent', value: (r) => r.counts.sent, align: 'right' },
              { label: 'Delivered', value: (r) => formatPercent(r.rates.deliveryRate), align: 'right' },
              { label: 'Bounced', value: (r) => formatPercent(r.rates.bounceRate), align: 'right' },
              { label: 'Opened*', value: (r) => formatPercent(r.rates.openRate), align: 'right' },
              { label: 'Clicked', value: (r) => formatPercent(r.rates.clickRate), align: 'right' },
              { label: 'Unsub', value: (r) => formatPercent(r.rates.unsubscribeRate), align: 'right' },
            ]),
          );
          return;
        }
        const [overview, failures] = await Promise.all([client.analytics.overview(range), client.analytics.failures(range)]);
        ctx.output.result({ overview, failures: failures.items }, () => {
          const { counts, rates } = overview;
          ctx.output.heading(`${overview.from} → ${overview.to}`);
          ctx.output.fields([
            ['Sent', counts.sent],
            ['Delivered', `${counts.delivered} (${formatPercent(rates.deliveryRate)})`],
            ['Bounced', `${counts.bounced} (${counts.hardBounced} hard, ${counts.softBounced} soft) ${formatPercent(rates.bounceRate)}`],
            ['Complaints', `${counts.complained} (${formatPercent(rates.complaintRate)})`],
            ['Unsubscribed', `${counts.unsubscribed} (${formatPercent(rates.unsubscribeRate)})`],
            ['Opened*', `${counts.opened} (${formatPercent(rates.openRate)})`],
            ['Clicked', `${counts.clicked} (${formatPercent(rates.clickRate)})`],
            ['Waiting for review', counts.pendingApproval],
            ['Failed', counts.failed],
          ]);
          ctx.output.line(pc.dim(`\n* ${overview.openDisclaimer}`));
          if (failures.items.length) {
            ctx.output.heading('Top failure reasons');
            ctx.output.table(failures.items.slice(0, 8), [
              { label: 'Status', value: (f) => statusColor(f.status) },
              { label: 'Reason', value: (f) => f.reason, max: 70 },
              { label: 'Count', value: (f) => f.count, align: 'right' },
            ]);
          }
        });
      }),
    );

  program
    .command('calendar')
    .description('relationship calendar: occasions, scheduled campaigns and sends')
    .option('--from <date>')
    .option('--to <date>')
    .action(
      run(async (ctx, o: { from?: string; to?: string }) => {
        const res = await ctx.client().calendar.events({ from: o.from, to: o.to });
        ctx.output.result(res, () =>
          ctx.output.table(res.items, [
            { label: 'Date', value: (e) => `${e.date}${e.time ? ` ${e.time}` : ''}` },
            { label: 'Kind', value: (e) => e.kind.replace('_', ' ') },
            { label: 'What', value: (e) => e.title, max: 40 },
            { label: 'Detail', value: (e) => e.subtitle, max: 40 },
          ], 'Nothing on the calendar in this range.'),
        );
      }),
    );

  const tasks = program.command('tasks').alias('task').description('follow-ups for the team');
  tasks
    .command('list')
    .option('--all', 'include completed tasks')
    .option('--mine', 'only tasks assigned to me')
    .action(run(async (ctx, o: { all?: boolean; mine?: boolean }) => {
      const res = await ctx.client().tasks.list({ status: o.all ? undefined : 'open', mine: o.mine, pageSize: 100 });
      ctx.output.result(res, () =>
        ctx.output.table(res.items, [
          { label: 'ID', value: (t) => pc.dim(t.id) },
          { label: 'Task', value: (t) => t.title, max: 44 },
          { label: 'Contact', value: (t) => t.contactName, max: 22 },
          { label: 'Due', value: (t) => formatDate(t.dueAt) },
          { label: 'Status', value: (t) => statusColor(t.status) },
          { label: 'From', value: (t) => t.source },
        ], 'No open tasks.'),
      );
    }));
  tasks
    .command('add <title>')
    .option('--contact <id>')
    .option('--due <datetime>')
    .action(run(async (ctx, title: string, o: { contact?: string; due?: string }) => {
      const t = await ctx.client().tasks.create({ title, contactId: o.contact, dueAt: o.due });
      ctx.output.result(t, () => ctx.output.success(`Added task ${t.id}`));
    }));
  tasks
    .command('done <id>')
    .action(run(async (ctx, id: string) => {
      const t = await ctx.client().tasks.complete(id);
      ctx.output.result(t, () => ctx.output.success(`Done: ${t.title}`));
    }));

  program
    .command('health')
    .description('server, database, queue and scheduler status')
    .action(run(async (ctx) => {
      const h = await ctx.client().system.health();
      ctx.output.result(h, () =>
        ctx.output.fields([
          ['Overall', h.ok ? pc.green('healthy') : pc.red('degraded')],
          ['Version', h.version],
          ['Database', `${h.database.ok ? pc.green('ok') : pc.red('down')} ${h.database.dialect} ${h.database.latencyMs} ms`],
          ['Queue lag', `${h.queue.lagSeconds}s`],
          ['Jobs', Object.entries(h.queue.byStatus).map(([s, n]) => `${s} ${n}`).join(', ')],
          ['Scheduler', h.scheduler.healthy ? pc.green(`ok, ${h.scheduler.secondsSinceTick}s ago`) : pc.yellow(h.scheduler.lastTickAt ? `${h.scheduler.secondsSinceTick}s since last tick` : 'not running')],
          ['E-mail', `${h.email.provider ?? 'none'} (${h.email.source})`],
          ['AI', h.ai.enabled ? h.ai.provider : 'off'],
        ]),
      );
    }));

  const queue = program.command('queue').description('background jobs');
  queue
    .command('list')
    .option('--status <status>', 'queued, running, failed, dead, succeeded')
    .option('--type <type>')
    .action(run(async (ctx, o: { status?: string; type?: string }) => {
      const res = await ctx.client().system.jobs({ status: o.status, type: o.type, limit: 100 });
      ctx.output.result(res, () =>
        ctx.output.table(res.items, [
          { label: 'Job', value: (j) => pc.dim(j.id) },
          { label: 'Type', value: (j) => j.type },
          { label: 'Status', value: (j) => statusColor(j.status) },
          { label: 'Attempts', value: (j) => `${j.attempts}/${j.maxAttempts}` },
          { label: 'Run at', value: (j) => formatDate(j.runAt) },
          { label: 'Last error', value: (j) => j.lastError, max: 50 },
        ], 'The queue is empty.'),
      );
    }));
  queue
    .command('retry <id>')
    .action(run(async (ctx, id: string) => {
      const r = await ctx.client().system.retryJob(id);
      ctx.output.result(r, () => (r.ok ? ctx.output.success('Re-queued') : ctx.output.warn('That job cannot be retried')));
    }));

  const keys = program.command('api-keys').description('API keys for scripts and integrations');
  keys.command('list').action(run(async (ctx) => {
    const res = await ctx.client().workspace.apiKeys();
    ctx.output.result(res, () =>
      ctx.output.table(res.items, [
        { label: 'ID', value: (k) => pc.dim(k.id) },
        { label: 'Name', value: (k) => k.name },
        { label: 'Prefix', value: (k) => `mrw_${k.prefix}_…` },
        { label: 'Role', value: (k) => k.role },
        { label: 'Last used', value: (k) => formatDate(k.lastUsedAt) },
        { label: 'Expires', value: (k) => formatDate(k.expiresAt) },
        { label: 'Revoked', value: (k) => (k.revokedAt ? pc.red(formatDate(k.revokedAt)) : null) },
      ]),
    );
  }));
  keys
    .command('create <name>')
    .option('--role <role>', 'owner, admin, manager or analyst', 'manager')
    .option('--expires <days>', 'expire after this many days')
    .action(run(async (ctx, name: string, o: { role: Role; expires?: string }) => {
      const k = await ctx.client().workspace.createApiKey({ name, role: o.role, expiresInDays: o.expires ? Number(o.expires) : null });
      ctx.output.result(k, () => {
        ctx.output.success(`Created ${k.role} key "${k.name}"`);
        ctx.output.line(`\n  ${pc.bold(k.key)}\n\n${pc.dim('  Copy it now: it is not shown again.')}`);
      });
    }));
  keys
    .command('revoke <id>')
    .action(run(async (ctx, id: string) => {
      await ctx.client().workspace.revokeApiKey(id);
      ctx.output.result({ ok: true }, () => ctx.output.success('Revoked'));
    }));
};

import { writeFileSync } from 'node:fs';
import pc from 'picocolors';
import type { CampaignDTO, PreflightDTO } from '@morrow/sdk';
import { CliError, type CliContext } from '../context';
import { formatDate, formatPercent, statusColor } from '../output';
import { confirm } from '../prompt';
import type { Register } from './ops';

const REASONS: Record<string, string> = {
  no_email: 'no e-mail address',
  invalid_email: 'invalid or bouncing address',
  suppressed: 'suppressed (bounce/complaint/manual)',
  unsubscribed: 'unsubscribed or consent withdrawn',
  consent_missing: 'no consent for this kind of e-mail',
  frequency_cap: 'frequency cap reached',
  duplicate: 'duplicate address',
};

function printPreflight(ctx: CliContext, p: PreflightDTO): void {
  ctx.output.fields([
    ['Audience', p.audience],
    ['Will receive', pc.bold(String(p.eligible))],
  ]);
  const excluded = Object.entries(p.excluded).filter(([, n]) => n);
  if (excluded.length) {
    ctx.output.heading('Excluded');
    for (const [reason, n] of excluded) ctx.output.line(`  ${String(n).padStart(5)}  ${REASONS[reason] ?? reason}`);
  }
  for (const m of p.missingPersonalization) ctx.output.warn(`${m.contacts} contact(s) have no {{${m.variable}}} — ${m.handledBy === 'fallback' ? 'the fallback text is used' : m.handledBy === 'skip' ? 'they are skipped' : 'it is left blank'}`);
  for (const w of p.warnings) ctx.output.warn(w);
  for (const b of p.blockers) ctx.output.error(b);
}

function printCampaign(ctx: CliContext, c: CampaignDTO): void {
  const { counts, rates } = c.stats;
  ctx.output.heading(`${c.name}  ${statusColor(c.status)}`);
  ctx.output.fields([
    ['ID', c.id],
    ['Audience', c.segmentName],
    ['Template', c.templateName],
    ['From', c.sender ? `${c.sender.name} <${c.sender.email}>` : null],
    ['Category', c.category],
    ['Scheduled', c.scheduledAt ? `${formatDate(c.scheduledAt)} (${c.timezone ?? 'UTC'})` : null],
    ['Approval', c.requiresApproval ? c.approvalStatus : 'not required'],
    ['Recipients', c.recipientCount],
    ['Sent', counts.sent],
    ['Delivered', `${counts.delivered} (${formatPercent(rates.deliveryRate)})`],
    ['Bounced', `${counts.bounced} (${formatPercent(rates.bounceRate)})`],
    ['Opened (estimated)', `${counts.opened} (${formatPercent(rates.openRate)})`],
    ['Clicked', `${counts.clicked} (${formatPercent(rates.clickRate)})`],
    ['Unsubscribed', counts.unsubscribed],
    ['Skipped/suppressed', counts.suppressed],
  ]);
}

/** campaigns, segments and templates. */
export const registerCampaigns: Register = (program, run) => {
  const campaigns = program.command('campaigns').alias('campaign').description('one-off sends to a segment');

  campaigns
    .command('list')
    .option('--status <status>')
    .action(
      run(async (ctx, o: { status?: string }) => {
        const res = await ctx.client().campaigns.list({ status: o.status });
        ctx.output.result(res, () =>
          ctx.output.table(res.items, [
            { label: 'ID', value: (c) => pc.dim(c.id) },
            { label: 'Name', value: (c) => c.name, max: 30 },
            { label: 'Status', value: (c) => statusColor(c.status) },
            { label: 'Audience', value: (c) => c.segmentName, max: 24 },
            { label: 'Sent', value: (c) => c.stats.counts.sent, align: 'right' },
            { label: 'Delivered', value: (c) => formatPercent(c.stats.rates.deliveryRate), align: 'right' },
            { label: 'When', value: (c) => formatDate(c.launchedAt ?? c.scheduledAt) },
          ]),
        );
      }),
    );

  campaigns
    .command('show <id>')
    .alias('status')
    .description('campaign details and delivery results')
    .action(run(async (ctx, id: string) => {
      const c = await ctx.client().campaigns.get(id);
      ctx.output.result(c, () => printCampaign(ctx, c));
    }));

  campaigns
    .command('create')
    .requiredOption('--name <name>')
    .requiredOption('--segment <id>')
    .requiredOption('--template <id>')
    .option('--subject <subject>', 'override the template subject')
    .option('--sender <id>')
    .option('--category <category>', 'marketing (default) or relationship')
    .action(
      run(async (ctx, o: { name: string; segment: string; template: string; subject?: string; sender?: string; category?: 'marketing' | 'relationship' }) => {
        const c = await ctx.client().campaigns.create({ name: o.name, segmentId: o.segment, templateId: o.template, subject: o.subject, senderId: o.sender, category: o.category });
        ctx.output.result(c, () => ctx.output.success(`Created draft campaign ${c.name} (${c.id}). Next: morrow campaigns preflight ${c.id}`));
      }),
    );

  campaigns
    .command('preflight <id>')
    .description('who will receive it, who is excluded and why')
    .action(run(async (ctx, id: string) => {
      const p = await ctx.client().campaigns.preflight(id);
      ctx.output.result(p, () => printPreflight(ctx, p));
    }));

  campaigns
    .command('test <id>')
    .description('send a test to yourself or another workspace member')
    .option('--to <email>')
    .action(run(async (ctx, id: string, o: { to?: string }) => {
      const r = await ctx.client().campaigns.testSend(id, o.to);
      ctx.output.result(r, () => ctx.output.success(`Test sent to ${r.to}`));
    }));

  campaigns
    .command('schedule <id>')
    .requiredOption('--at <datetime>', 'ISO date-time, e.g. 2026-11-02T10:00:00+05:30')
    .option('--timezone <tz>')
    .action(run(async (ctx, id: string, o: { at: string; timezone?: string }) => {
      const c = await ctx.client().campaigns.schedule(id, { scheduledAt: o.at, timezone: o.timezone });
      ctx.output.result(c, () => ctx.output.success(`${c.name} ${statusColor(c.status)} for ${formatDate(c.scheduledAt)}`));
    }));

  campaigns
    .command('launch <id>')
    .description('run preflight, confirm, then send now')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      run(async (ctx, id: string, o: { yes?: boolean }) => {
        const client = ctx.client();
        const p = await client.campaigns.preflight(id);
        if (!ctx.output.json) printPreflight(ctx, p);
        if (!p.ok) throw new CliError('Fix the blockers above before launching.');
        if (!(await confirm(`Send to ${p.eligible} contact(s) now?`, { yes: o.yes || ctx.output.json }))) return;
        const c = await client.campaigns.launch(id);
        ctx.output.result(c, () => ctx.output.success(c.status === 'pending_approval' ? 'Submitted for approval' : `${c.name} is ${statusColor(c.status)}`));
      }),
    );

  for (const action of ['pause', 'resume', 'approve'] as const) {
    campaigns
      .command(`${action} <id>`)
      .action(run(async (ctx, id: string) => {
        const c = await ctx.client().campaigns[action](id);
        ctx.output.result(c, () => ctx.output.success(`${c.name} is ${statusColor(c.status)}`));
      }));
  }

  campaigns
    .command('cancel <id>')
    .option('-y, --yes')
    .action(run(async (ctx, id: string, o: { yes?: boolean }) => {
      if (!(await confirm('Cancel all unsent messages for this campaign?', { yes: o.yes || ctx.output.json }))) return;
      const r = await ctx.client().campaigns.cancel(id);
      ctx.output.result(r, () => ctx.output.success(`Cancelled ${r.cancelledMessages} unsent message(s). ${r.alreadySent} were already sent and cannot be recalled.`));
    }));

  // ------------------------------------------------------------ segments

  const segments = program.command('segments').alias('segment').description('saved audiences');
  segments.command('list').action(run(async (ctx) => {
    const res = await ctx.client().segments.list();
    ctx.output.result(res, () =>
      ctx.output.table(res.items, [
        { label: 'ID', value: (s) => pc.dim(s.id) },
        { label: 'Name', value: (s) => s.name, max: 30 },
        { label: 'Contacts', value: (s) => s.count, align: 'right' },
        { label: 'Rules', value: (s) => s.summary, max: 60 },
      ]),
    );
  }));
  segments
    .command('preview <id>')
    .description('count and sample the contacts in a segment')
    .action(run(async (ctx, id: string) => {
      const client = ctx.client();
      const seg = await client.segments.get(id);
      const p = await client.segments.preview(seg.criteria, 10);
      ctx.output.result(p, () => {
        ctx.output.heading(`${seg.name}: ${p.count} contact(s)`);
        ctx.output.table(p.sample, [
          { label: 'Name', value: (c) => c.name },
          { label: 'E-mail', value: (c) => c.email },
        ]);
      });
    }));

  // ------------------------------------------------------------ templates

  const templates = program.command('templates').alias('template').description('e-mail templates');
  templates
    .command('list')
    .option('--purpose <purpose>')
    .action(run(async (ctx, o: { purpose?: string }) => {
      const res = await ctx.client().templates.list({ purpose: o.purpose as never });
      ctx.output.result(res, () =>
        ctx.output.table(res.items, [
          { label: 'ID', value: (t) => pc.dim(t.id) },
          { label: 'Name', value: (t) => t.name, max: 30 },
          { label: 'Status', value: (t) => statusColor(t.status) + (t.hasUnpublishedChanges ? pc.yellow('*') : '') },
          { label: 'Category', value: (t) => t.category },
          { label: 'Subject', value: (t) => t.subject, max: 50 },
        ]),
      );
    }));
  templates
    .command('render <id>')
    .description('render with sample data or a real contact')
    .option('--contact <id>')
    .option('--draft', 'render the unpublished draft')
    .option('--html <file>', 'also write the HTML to a file')
    .action(run(async (ctx, id: string, o: { contact?: string; draft?: boolean; html?: string }) => {
      const r = await ctx.client().templates.render(id, { contactId: o.contact, which: o.draft ? 'draft' : 'published' });
      if (o.html) writeFileSync(o.html, r.html);
      ctx.output.result(r, () => {
        ctx.output.fields([
          ['Subject', r.subject],
          ['Preview', r.previewText],
          ['Fallbacks', r.fallbacksUsed],
          ['Eligible', r.eligibility ? (r.eligibility.eligible ? pc.green('yes') : `${pc.red('no')} — ${r.eligibility.reasons.join(', ')}`) : null],
        ]);
        ctx.output.line(`\n${r.text}`);
        for (const w of r.warnings) ctx.output.warn(w);
        for (const i of r.issues) (i.severity === 'error' ? ctx.output.error : ctx.output.warn).call(ctx.output, i.message);
      });
    }));
  templates
    .command('test <id>')
    .option('--to <email>', 'a workspace member (default: you)')
    .option('--draft')
    .action(run(async (ctx, id: string, o: { to?: string; draft?: boolean }) => {
      const r = await ctx.client().templates.testSend(id, { to: o.to, which: o.draft ? 'draft' : 'published' });
      ctx.output.result(r, () => ctx.output.success(`Test sent to ${r.to}`));
    }));
  templates
    .command('publish <id>')
    .action(run(async (ctx, id: string) => {
      const t = await ctx.client().templates.publish(id);
      ctx.output.result(t, () => ctx.output.success(`Published ${t.name} v${t.publishedVersion}`));
    }));
};

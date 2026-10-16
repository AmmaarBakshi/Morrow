import pc from 'picocolors';
import type { DryRunStepDTO } from '@morrow/sdk';
import { CliError } from '../context';
import { formatDate, statusColor } from '../output';
import { confirm } from '../prompt';
import type { Register } from './ops';

/** "plan=pro" "count=3" "vip=true" → typed properties. */
export function parseProps(pairs: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new CliError(`Property "${pair}" must look like key=value.`);
    const key = pair.slice(0, i).trim();
    const raw = pair.slice(i + 1);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

const outcome = (s: DryRunStepDTO) =>
  ({ would_run: pc.green('run'), would_skip: pc.yellow('skip'), would_wait: pc.cyan('wait'), would_end: pc.dim('end'), blocked: pc.red('blocked') })[s.outcome];

/** automations, birthdays, events and approvals. */
export const registerAutomations: Register = (program, run) => {
  const automations = program.command('automations').alias('automation').description('lifecycle automations');

  automations
    .command('list')
    .description('list automations')
    .option('--status <status>', 'draft, active, paused or archived')
    .action(
      run(async (ctx, o: { status?: string }) => {
        const res = await ctx.client().automations.list({ status: o.status });
        ctx.output.result(res, () =>
          ctx.output.table(res.items, [
            { label: 'ID', value: (a) => pc.dim(a.id) },
            { label: 'Name', value: (a) => a.name, max: 30 },
            { label: 'Status', value: (a) => statusColor(a.status) },
            { label: 'Delivery', value: (a) => (a.deliveryMode === 'auto' ? pc.magenta('auto') : 'review') },
            { label: 'Trigger', value: (a) => a.triggerSummary, max: 44 },
            { label: 'Runs', value: (a) => a.stats.runs, align: 'right' },
            { label: 'To review', value: (a) => a.stats.pendingApproval, align: 'right' },
          ]),
        );
      }),
    );

  automations
    .command('show <id>')
    .description('show an automation, its steps and any problems')
    .action(
      run(async (ctx, id: string) => {
        const a = await ctx.client().automations.get(id);
        ctx.output.result(a, () => {
          ctx.output.heading(`${a.name}  ${statusColor(a.status)}  v${a.version}`);
          ctx.output.fields([
            ['Trigger', a.triggerSummary],
            ['Delivery', a.deliveryMode === 'auto' ? `automatic (approved by ${a.autoApprovedBy ?? 'unknown'})` : 'each e-mail is reviewed first'],
            ['Last triggered', formatDate(a.lastTriggeredAt)],
            ['Runs', `${a.stats.runs} total, ${a.stats.active} active, ${a.stats.completed} completed, ${a.stats.failed} failed`],
          ]);
          ctx.output.heading('Steps');
          a.definition.steps.forEach((s, i) => ctx.output.line(`  ${i + 1}. ${pc.bold(s.type)} ${pc.dim(s.id)}`));
          for (const p of a.problems) (p.severity === 'error' ? ctx.output.error : ctx.output.warn).call(ctx.output, `${p.path}: ${p.message}`);
        });
      }),
    );

  automations
    .command('dry-run <id>')
    .description('simulate who would qualify and what each step would do — sends nothing')
    .option('--at <datetime>', 'simulate at this ISO time (default: now)')
    .option('--contact <id...>', 'only these contacts')
    .option('--limit <n>', 'maximum contacts', '20')
    .option('--show-email', 'print the rendered e-mails')
    .action(
      run(async (ctx, id: string, o: { at?: string; contact?: string[]; limit: string; showEmail?: boolean }) => {
        const res = await ctx.client().automations.dryRun(id, { at: o.at, contactIds: o.contact, limit: Number(o.limit) });
        ctx.output.result(res, () => {
          ctx.output.heading(`Dry run at ${formatDate(res.simulatedAt)} — ${res.triggerSummary}`);
          ctx.output.line(`${pc.bold(String(res.qualified))} of ${res.candidates} candidates qualify${res.truncated ? pc.dim(' (truncated)') : ''}\n`);
          for (const r of res.results) {
            ctx.output.line(`${r.qualified ? pc.green('●') : pc.dim('○')} ${pc.bold(r.contact.name)} ${pc.dim(r.contact.email ?? 'no e-mail')} ${pc.dim(r.eventKey)}`);
            if (!r.qualified) ctx.output.line(pc.dim(`    ${r.reasons.join('; ')}`));
            for (const s of r.steps) {
              ctx.output.line(`    ${outcome(s)} ${s.type} — ${s.detail}`);
              if (s.email && o.showEmail) ctx.output.line(pc.dim(`      Subject: ${s.email.subject}\n      ${s.email.text.split('\n').join('\n      ')}`));
            }
          }
        });
      }),
    );

  automations
    .command('run <id>')
    .description('start a manual automation for contacts or a segment')
    .option('--contact <id...>')
    .option('--segment <id>')
    .action(
      run(async (ctx, id: string, o: { contact?: string[]; segment?: string }) => {
        if (!o.contact?.length && !o.segment) throw new CliError('Choose who to run it for with --contact or --segment.');
        const res = await ctx.client().automations.run(id, { contactIds: o.contact, segmentId: o.segment });
        ctx.output.result(res, () => ctx.output.success(res.queued ? `Queued for the segment (${res.eventKey})` : `Started ${res.started} run(s)`));
      }),
    );

  automations
    .command('activate <id>')
    .description('turn an automation on (each e-mail is reviewed unless --auto)')
    .option('--auto', 'send without review (needs admin rights)')
    .option('-y, --yes', 'skip the confirmation for --auto')
    .action(
      run(async (ctx, id: string, o: { auto?: boolean; yes?: boolean }) => {
        if (o.auto && !(await confirm('E-mails from this automation will be sent without review. Continue?', { yes: o.yes || ctx.output.json }))) return;
        const a = await ctx.client().automations.activate(id, o.auto ? 'auto' : 'review');
        ctx.output.result(a, () => ctx.output.success(`${a.name} is ${statusColor(a.status)} (${a.deliveryMode === 'auto' ? 'automatic delivery' : 'review mode'})`));
      }),
    );

  for (const [name, verb] of [['pause', 'Paused'], ['resume', 'Resumed']] as const) {
    automations
      .command(`${name} <id>`)
      .description(`${name} an automation`)
      .action(
        run(async (ctx, id: string) => {
          const a = await ctx.client().automations[name](id);
          ctx.output.result(a, () => ctx.output.success(`${verb} ${a.name}`));
        }),
      );
  }

  automations
    .command('runs <id>')
    .description('recent runs of an automation')
    .option('--status <status>')
    .action(
      run(async (ctx, id: string, o: { status?: string }) => {
        const res = await ctx.client().automations.runs(id, { status: o.status, pageSize: 50 });
        ctx.output.result(res, () =>
          ctx.output.table(res.items, [
            { label: 'Run', value: (r) => pc.dim(r.id) },
            { label: 'Contact', value: (r) => r.contactName ?? r.contactEmail, max: 26 },
            { label: 'Occasion', value: (r) => r.eventKey, max: 26 },
            { label: 'Status', value: (r) => statusColor(r.status) },
            { label: 'Resumes', value: (r) => formatDate(r.resumeAt) },
            { label: 'Started', value: (r) => formatDate(r.startedAt) },
          ]),
        );
      }),
    );

  // ------------------------------------------------------------ birthdays

  const birthdays = program.command('birthdays').description('birthdays and work anniversaries');
  birthdays
    .command('upcoming')
    .description('who is celebrating soon (in the workspace time zone)')
    .option('--days <n>', 'look ahead this many days', '30')
    .option('--anniversaries', 'include work anniversaries')
    .action(
      run(async (ctx, o: { days: string; anniversaries?: boolean }) => {
        const res = await ctx.client().contacts.upcomingOccasions({ days: Number(o.days), kinds: o.anniversaries ? ['birthday', 'work_anniversary'] : ['birthday'] });
        ctx.output.result(res, () =>
          ctx.output.table(
            res.items,
            [
              { label: 'Date', value: (u) => u.date },
              { label: 'In', value: (u) => (u.daysAway === 0 ? pc.green('today') : u.daysAway === 1 ? 'tomorrow' : `${u.daysAway} days`) },
              { label: 'Who', value: (u) => u.name, max: 28 },
              { label: 'Occasion', value: (u) => (u.kind === 'birthday' ? (u.years ? `birthday (${u.years})` : 'birthday') : `work anniversary (${u.years ?? '?'} yr)`) },
              { label: 'Relationship', value: (u) => u.relationshipType },
              { label: 'E-mail', value: (u) => u.email, max: 30 },
            ],
            `No occasions in the next ${o.days} days.`,
          ),
        );
      }),
    );

  // ------------------------------------------------------------ events

  const events = program.command('events').description('custom events that trigger automations');
  events
    .command('send <name>')
    .description('record an event, e.g. `morrow events send proposal.sent --email lead@example.com --prop proposal_name="Atlas"`')
    .option('--email <email>', 'contact e-mail')
    .option('--contact <id>', 'contact ID')
    .option('--prop <key=value...>', 'event properties')
    .option('--dedupe <key>', 'idempotency key: the same key is recorded only once')
    .option('--create', 'create the contact if the e-mail is unknown')
    .action(
      run(async (ctx, name: string, o: { email?: string; contact?: string; prop?: string[]; dedupe?: string; create?: boolean }) => {
        if (!o.email && !o.contact) throw new CliError('Identify the contact with --email or --contact.');
        const res = await ctx.client().events.record({ name, email: o.email, contactId: o.contact, properties: parseProps(o.prop), dedupeKey: o.dedupe, contact: o.create && o.email ? { email: o.email } : undefined });
        ctx.output.result(res, () => ctx.output.success(res.duplicate ? `Already recorded (${o.dedupe})` : `Recorded ${name} for ${res.contactId}${res.contactCreated ? ' (new contact)' : ''}`));
      }),
    );

  // ------------------------------------------------------------ approvals

  const approvals = program.command('approvals').description('automation e-mail waiting for review');
  approvals
    .command('list')
    .option('--automation <id>')
    .action(
      run(async (ctx, o: { automation?: string }) => {
        const res = await ctx.client().approvals.list({ automationId: o.automation, pageSize: 100 });
        ctx.output.result(res, () =>
          ctx.output.table(
            res.items,
            [
              { label: 'Message', value: (m) => pc.dim(m.id) },
              { label: 'To', value: (m) => m.contactName ?? m.toEmail, max: 26 },
              { label: 'Subject', value: (m) => m.subject, max: 50 },
              { label: 'Send at', value: (m) => formatDate(m.scheduledFor) },
            ],
            'Nothing waiting for review.',
          ),
        );
      }),
    );
  approvals
    .command('approve <ids...>')
    .description('approve messages for sending')
    .action(
      run(async (ctx, ids: string[]) => {
        const res = await ctx.client().approvals.approve(ids);
        ctx.output.result(res, () => ctx.output.success(`Approved ${res.approved} message(s)`));
      }),
    );
  approvals
    .command('reject <ids...>')
    .option('--note <text>')
    .action(
      run(async (ctx, ids: string[], o: { note?: string }) => {
        const res = await ctx.client().approvals.reject(ids, o.note);
        ctx.output.result(res, () => ctx.output.success(`Rejected ${res.rejected} message(s)`));
      }),
    );
};

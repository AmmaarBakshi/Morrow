import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { ConsentStatus, ContactCreateInput, ContactDTO, DuplicateStrategy } from '@morrow/sdk';
import { CliError } from '../context';
import { formatDate, statusColor } from '../output';
import { confirm, readStdin } from '../prompt';
import type { Register } from './ops';

/** "03-07" or "1990-03-07" → birthday. */
export function parseBirthday(value: string): { month: number; day: number; year: number | null } {
  const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!m) throw new CliError(`Birthday "${value}" must look like MM-DD or YYYY-MM-DD.`);
  return { year: m[1] ? Number(m[1]) : null, month: Number(m[2]), day: Number(m[3]) };
}

interface ContactFlags {
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  type?: string;
  birthday?: string;
  anniversary?: string;
  tag?: string[];
  consent?: string;
  consentSource?: string;
  timezone?: string;
  language?: string;
}

function contactOptions(cmd: Command): Command {
  return cmd
    .option('--email <email>')
    .option('--first-name <name>')
    .option('--last-name <name>')
    .option('--company <company>')
    .option('--title <jobTitle>')
    .option('--type <relationship>', 'client, lead, developer, collaborator, subscriber, partner, investor, friend, team, other')
    .option('--birthday <date>', 'MM-DD or YYYY-MM-DD')
    .option('--anniversary <date>', 'work anniversary, YYYY-MM-DD')
    .option('--tag <tag...>', 'tags')
    .option('--consent <status>', 'granted, implied, unknown or withdrawn')
    .option('--consent-source <text>', 'where consent came from (required for granted/implied)')
    .option('--timezone <tz>', 'IANA time zone, e.g. Asia/Kolkata')
    .option('--language <code>', 'e.g. en, hi-IN');
}

function toInput(f: ContactFlags): Partial<ContactCreateInput> {
  const input: Partial<ContactCreateInput> = {};
  if (f.email !== undefined) input.email = f.email;
  if (f.firstName !== undefined) input.firstName = f.firstName;
  if (f.lastName !== undefined) input.lastName = f.lastName;
  if (f.company !== undefined) input.company = f.company;
  if (f.title !== undefined) input.jobTitle = f.title;
  if (f.type !== undefined) input.relationshipType = f.type as ContactCreateInput['relationshipType'];
  if (f.birthday !== undefined) input.birthday = parseBirthday(f.birthday);
  if (f.anniversary !== undefined) input.workAnniversary = f.anniversary;
  if (f.tag) input.tags = f.tag;
  if (f.consent !== undefined) input.consentStatus = f.consent as ConsentStatus;
  if (f.consentSource !== undefined) input.consentSource = f.consentSource;
  if (f.timezone !== undefined) input.timezone = f.timezone;
  if (f.language !== undefined) input.language = f.language;
  return input;
}

const birthday = (c: ContactDTO) => (c.birthday ? `${c.birthday.year ? `${c.birthday.year}-` : ''}${String(c.birthday.month).padStart(2, '0')}-${String(c.birthday.day).padStart(2, '0')}` : null);

export const registerContacts: Register = (program, run) => {
  const contacts = program.command('contacts').alias('contact').description('people and their relationship data');

  contacts
    .command('list')
    .description('list contacts')
    .option('-q, --query <text>', 'search name, e-mail, company')
    .option('--tag <tag>')
    .option('--segment <id>')
    .option('--type <relationship>')
    .option('--consent <status>')
    .option('--archived', 'show archived contacts')
    .option('--page <n>', 'page number', '1')
    .option('--limit <n>', 'page size', '50')
    .action(
      run(async (ctx, o: { query?: string; tag?: string; segment?: string; type?: string; consent?: ConsentStatus; archived?: boolean; page: string; limit: string }) => {
        const res = await ctx.client().contacts.list({ q: o.query, tag: o.tag, segmentId: o.segment, relationshipType: o.type, consent: o.consent, status: o.archived ? 'archived' : 'active', page: Number(o.page), pageSize: Number(o.limit) });
        ctx.output.result(res, () => {
          ctx.output.table(res.items, [
            { label: 'ID', value: (c) => pc.dim(c.id) },
            { label: 'Name', value: (c) => c.fullName, max: 28 },
            { label: 'E-mail', value: (c) => c.email, max: 32 },
            { label: 'Type', value: (c) => c.relationshipType },
            { label: 'Consent', value: (c) => statusColor(c.consentStatus) },
            { label: 'Birthday', value: birthday },
            { label: 'Tags', value: (c) => c.tags.map((t) => t.name), max: 30 },
          ], 'No contacts match.');
          ctx.output.line(pc.dim(`\n${res.items.length} of ${res.total} · page ${res.page}`));
        });
      }),
    );

  contacts
    .command('get <id>')
    .description('show one contact with recent activity')
    .action(
      run(async (ctx, id: string) => {
        const client = ctx.client();
        const [c, timeline] = await Promise.all([client.contacts.get(id), client.contacts.timeline(id, 10)]);
        ctx.output.result({ ...c, timeline: timeline.items }, () => {
          ctx.output.heading(c.fullName);
          ctx.output.fields([
            ['ID', c.id],
            ['E-mail', c.email ? `${c.email} (${c.emailStatus})` : null],
            ['Company', [c.jobTitle, c.company].filter(Boolean).join(' at ') || null],
            ['Relationship', c.relationshipType],
            ['Birthday', birthday(c)],
            ['Work anniversary', c.workAnniversary],
            ['Consent', `${statusColor(c.consentStatus)}${c.consentSource ? ` — ${c.consentSource}` : ''}`],
            ['Suppressed', c.suppression ? `${c.suppression.reason} (${c.suppression.scope})` : 'no'],
            ['Tags', c.tags.map((t) => t.name)],
            ['Last interaction', formatDate(c.lastInteractionAt)],
            ['Last e-mailed', formatDate(c.lastEmailedAt)],
          ]);
          if (timeline.items.length) {
            ctx.output.heading('Recent activity');
            ctx.output.table(timeline.items, [
              { label: 'When', value: (t) => formatDate(t.at) },
              { label: 'Type', value: (t) => t.type },
              { label: 'What', value: (t) => t.title, max: 70 },
            ]);
          }
        });
      }),
    );

  contactOptions(contacts.command('add').description('create a contact')).action(
    run(async (ctx, o: ContactFlags) => {
      const c = await ctx.client().contacts.create(toInput(o) as ContactCreateInput);
      ctx.output.result(c, () => ctx.output.success(`Created ${c.fullName} (${c.id})`));
    }),
  );

  contactOptions(contacts.command('update <id>').description('change a contact')).action(
    run(async (ctx, id: string, o: ContactFlags) => {
      const input = toInput(o);
      if (!Object.keys(input).length) throw new CliError('Nothing to change. Pass at least one option, e.g. --company "Northwind".');
      const c = await ctx.client().contacts.update(id, input);
      ctx.output.result(c, () => ctx.output.success(`Updated ${c.fullName}`));
    }),
  );

  contacts
    .command('consent <id> <status>')
    .description('record a consent change (granted, implied, unknown, withdrawn)')
    .option('--source <text>', 'where it came from')
    .option('--note <text>')
    .action(
      run(async (ctx, id: string, status: ConsentStatus, o: { source?: string; note?: string }) => {
        const c = await ctx.client().contacts.setConsent(id, { status, source: o.source, note: o.note });
        ctx.output.result(c, () => ctx.output.success(`${c.fullName}: consent ${statusColor(c.consentStatus)}`));
      }),
    );

  contacts
    .command('archive <id>')
    .description('archive a contact (keeps history; no e-mail is sent to archived contacts)')
    .action(
      run(async (ctx, id: string) => {
        const c = await ctx.client().contacts.archive(id);
        ctx.output.result(c, () => ctx.output.success(`Archived ${c.fullName}`));
      }),
    );

  contacts
    .command('import <file>')
    .description('import a CSV (use - for stdin): preview first, then confirm')
    .option('--tag <tag...>', 'add these tags to every imported contact')
    .option('--duplicates <strategy>', 'skip, update_empty or overwrite', 'update_empty')
    .option('--consent <status>', 'consent for rows without a consent column', 'unknown')
    .option('--consent-source <text>', 'where consent was collected')
    .option('--date-order <order>', 'DMY, MDY or YMD for ambiguous dates', 'DMY')
    .option('--trigger-automations', 'let new contacts start "contact created" automations')
    .option('-y, --yes', 'commit without asking')
    .action(
      run(async (ctx, file: string, o: { tag?: string[]; duplicates: DuplicateStrategy; consent: ConsentStatus; consentSource?: string; dateOrder: 'DMY' | 'MDY' | 'YMD'; triggerAutomations?: boolean; yes?: boolean }) => {
        const client = ctx.client();
        const csv = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
        const upload = await client.imports.upload(file === '-' ? 'stdin.csv' : basename(file), csv);
        const options = { duplicateStrategy: o.duplicates, defaultConsent: o.consent, consentSource: o.consentSource ?? null, dateOrder: o.dateOrder, addTags: o.tag ?? [] };
        const plan = { mapping: upload.suggestedMapping, options };
        const preview = await client.imports.preview(upload.id, plan);
        if (!ctx.output.json) {
          ctx.output.heading(`${upload.filename}: ${upload.rowCount} rows`);
          ctx.output.table(
            upload.headers.map((h, i) => ({ h, target: upload.suggestedMapping[i] })),
            [
              { label: 'Column', value: (r) => r.h },
              { label: 'Maps to', value: (r) => (r.target === 'ignore' ? pc.dim('ignored') : r.target) },
            ],
          );
          ctx.output.line();
          ctx.output.fields([
            ['Create', preview.willCreate],
            ['Update', preview.willUpdate],
            ['Skip', preview.willSkip],
            ['Invalid', preview.invalid],
            ['Duplicates in file', preview.duplicatesInFile],
            ['Suppressed addresses', preview.suppressed],
          ]);
          for (const issue of preview.issues.filter((i) => i.errors.length).slice(0, 10)) ctx.output.warn(`Row ${issue.row}: ${issue.errors.join('; ')}`);
        }
        if (!(await confirm('Import these contacts?', { yes: o.yes || ctx.output.json }))) {
          ctx.output.info('Nothing imported. The upload is kept for 7 days in the web app.');
          return;
        }
        const report = await client.imports.commit(upload.id, { ...plan, triggerAutomations: o.triggerAutomations });
        ctx.output.result(report, () => ctx.output.success(`Imported: ${report.created} created, ${report.updated} updated, ${report.skipped} skipped, ${report.failed} failed`));
      }),
    );

  contacts
    .command('export')
    .description('export contacts as CSV')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .option('--tag <tag>')
    .option('--segment <id>')
    .action(
      run(async (ctx, o: { output?: string; tag?: string; segment?: string }) => {
        const csv = await ctx.client().contacts.exportCsv({ tag: o.tag, segmentId: o.segment });
        if (o.output) {
          writeFileSync(o.output, csv, { mode: 0o600 });
          ctx.output.result({ file: o.output, rows: Math.max(0, csv.trim().split(/\r?\n/).length - 1) }, () => ctx.output.success(`Wrote ${o.output}`));
        } else {
          process.stdout.write(csv);
        }
      }),
    );
};

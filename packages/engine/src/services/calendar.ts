import {
  addDays,
  automationDefinitionSchema,
  completedYears,
  dateRange,
  fullName,
  isValidLocalDate,
  localDate,
  nextCelebration,
  occasionKeysInWindow,
  ordinal,
  parseLocalDate,
  startOfLocalDay,
  ValidationError,
  zonedParts,
  type CalendarEventDTO,
} from '@morrow/core';
import { fromJson } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

const MAX_DAYS = 62;

/** Calendar of upcoming occasions, scheduled sends, waiting automations and tasks. */
export class CalendarService {
  constructor(private readonly e: Engine) {}

  async events(ctx: WorkspaceContext, input: { from?: string; to?: string } = {}): Promise<CalendarEventDTO[]> {
    authorize(ctx, 'contacts:read');
    const ws = await this.e.workspaces.row(ctx.workspaceId);
    const tz = ws.timezone;
    const today = localDate(this.e.now(), tz);
    const from = input.from && isValidLocalDate(input.from) ? input.from : today;
    const to = input.to && isValidLocalDate(input.to) ? input.to : addDays(from, 34);
    const days = dateRange(from, to, MAX_DAYS + 1);
    if (days.length > MAX_DAYS || from > to) throw new ValidationError(`Choose a range of at most ${MAX_DAYS} days.`);
    const fromIso = startOfLocalDay(from, tz).toISOString();
    const toIso = startOfLocalDay(addDays(to, 1), tz).toISOString();
    const events: CalendarEventDTO[] = [];
    const time = (iso: string) => {
      const p = zonedParts(new Date(iso), tz);
      return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    };

    // Which calendar automations will act on these occasions?
    const calendarAutomations = (
      await this.e.db
        .selectFrom('automations')
        .innerJoin('automation_versions', 'automation_versions.id', 'automations.current_version_id')
        .select(['automations.name', 'automation_versions.definition'])
        .where('automations.workspace_id', '=', ctx.workspaceId)
        .where('automations.status', '=', 'active')
        .where('automations.trigger_type', '=', 'calendar')
        .execute()
    ).flatMap((r) => {
      const parsed = automationDefinitionSchema.safeParse(fromJson(r.definition, {}));
      return parsed.success && parsed.data.trigger.type === 'calendar' ? [{ name: r.name, trigger: parsed.data.trigger }] : [];
    });
    const automationNote = (field: string) => {
      const a = calendarAutomations.find((x) => x.trigger.field === field);
      return a ? `${a.name} at ${a.trigger.sendTime}` : null;
    };

    const keys = occasionKeysInWindow(from, days.length, 'feb28');
    if (keys.length) {
      const birthdays = await this.e.db
        .selectFrom('contacts')
        .select(['id', 'first_name', 'last_name', 'email', 'birthday_month', 'birthday_day'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where('birthday_md', 'in', keys)
        .limit(5000)
        .execute();
      const note = automationNote('birthday');
      for (const c of birthdays) {
        const date = nextCelebration({ month: c.birthday_month!, day: c.birthday_day! }, from, 'feb28');
        if (!date || date > to) continue;
        events.push({
          id: `bday:${c.id}:${date}`,
          date,
          time: null,
          kind: 'birthday',
          title: `${fullName({ firstName: c.first_name, lastName: c.last_name }) || c.email || 'Contact'}'s birthday`,
          subtitle: note,
          link: `/contacts/${c.id}`,
        });
      }
      const anniversaries = await this.e.db
        .selectFrom('contacts')
        .select(['id', 'first_name', 'last_name', 'email', 'work_anniversary'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where('anniversary_md', 'in', keys)
        .limit(5000)
        .execute();
      const aNote = automationNote('work_anniversary');
      for (const c of anniversaries) {
        const start = parseLocalDate(c.work_anniversary ?? '');
        if (!start) continue;
        const date = nextCelebration({ month: start.month, day: start.day }, from, 'feb28');
        if (!date || date > to) continue;
        const years = completedYears(c.work_anniversary!, date);
        if (years < 1) continue;
        events.push({
          id: `anniv:${c.id}:${date}`,
          date,
          time: null,
          kind: 'work_anniversary',
          title: `${fullName({ firstName: c.first_name, lastName: c.last_name }) || c.email || 'Contact'} — ${ordinal(years)} anniversary`,
          subtitle: aNote,
          link: `/contacts/${c.id}`,
        });
      }
    }

    const campaigns = await this.e.db
      .selectFrom('campaigns')
      .select(['id', 'name', 'status', 'scheduled_at', 'launched_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where((eb) =>
        eb.or([
          eb.and([eb('scheduled_at', '>=', fromIso), eb('scheduled_at', '<', toIso)]),
          eb.and([eb('launched_at', '>=', fromIso), eb('launched_at', '<', toIso)]),
        ]),
      )
      .execute();
    for (const c of campaigns) {
      const at = c.launched_at ?? c.scheduled_at!;
      events.push({ id: `cmp:${c.id}`, date: localDate(new Date(at), tz), time: time(at), kind: 'campaign', title: c.name, subtitle: c.status, link: `/campaigns/${c.id}` });
    }

    const resumes = await this.e.db
      .selectFrom('automation_runs')
      .innerJoin('automations', 'automations.id', 'automation_runs.automation_id')
      .select(['automations.id', 'automations.name', 'automation_runs.resume_at'])
      .where('automation_runs.workspace_id', '=', ctx.workspaceId)
      .where('automation_runs.status', '=', 'waiting')
      .where('automation_runs.resume_at', '>=', fromIso)
      .where('automation_runs.resume_at', '<', toIso)
      .limit(2000)
      .execute();
    const grouped = new Map<string, { name: string; id: string; count: number; first: string }>();
    for (const r of resumes) {
      const key = `${r.id}:${localDate(new Date(r.resume_at!), tz)}`;
      const g = grouped.get(key) ?? { name: r.name, id: r.id, count: 0, first: r.resume_at! };
      g.count++;
      if (r.resume_at! < g.first) g.first = r.resume_at!;
      grouped.set(key, g);
    }
    for (const [key, g] of grouped) {
      events.push({ id: `resume:${key}`, date: localDate(new Date(g.first), tz), time: time(g.first), kind: 'resume', title: g.name, subtitle: `${g.count} contact(s) continue`, link: `/automations/${g.id}` });
    }

    const tasks = await this.e.db
      .selectFrom('tasks')
      .select(['id', 'title', 'due_at', 'status'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'open')
      .where('due_at', '>=', fromIso)
      .where('due_at', '<', toIso)
      .limit(1000)
      .execute();
    for (const t of tasks) events.push({ id: `task:${t.id}`, date: localDate(new Date(t.due_at!), tz), time: null, kind: 'task', title: t.title, subtitle: 'Follow-up task', link: '/tasks' });

    return events.sort((a, b) => (a.date === b.date ? (a.time ?? '') < (b.time ?? '') ? -1 : 1 : a.date < b.date ? -1 : 1));
  }
}

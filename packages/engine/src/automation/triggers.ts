import {
  addDays,
  automationDefinitionSchema,
  calendarEventKey,
  compareLocalDates,
  completedYears,
  dateRange,
  emptyCriteria,
  localDate,
  localMinutesOfDay,
  monthDayKey,
  occasionsCelebratedOn,
  occurrencesBetween,
  pad2,
  parseTimeOfDay,
  type AutomationDefinition,
  type CriteriaGroup,
  type Trigger,
} from '@morrow/core';
import { fromJson, sql, type Db, type Row } from '@morrow/db';
import type { Engine } from '../engine';
import type { Job } from '../queue/queue';

export type ContactChangeKind = 'created' | 'updated' | 'consent' | 'tag_added' | 'event';

export interface ContactChange {
  contactId: string;
  change: ContactChangeKind;
  fields?: string[];
  consentTo?: string;
  tag?: string;
  eventId?: string;
  eventName?: string;
}

type CalendarTrigger = Extract<Trigger, { type: 'calendar' }>;

interface ActiveAutomation {
  automation: Row<'automations'>;
  versionId: string;
  definition: AutomationDefinition;
}

const CONTACT_TRIGGER_TYPES = ['contact_created', 'contact_updated', 'consent_changed', 'tag_added', 'event', 'segment_entered'];
const FANOUT_BATCH = 500;
const CACHE_MS = 10_000;

export interface CalendarReport {
  automations: number;
  datesProcessed: number;
  runsStarted: number;
  missedDates: number;
}

/**
 * Turns things that happen (contact changes, custom events, calendar dates,
 * schedules, inactivity, segment entry) into automation runs. Every path goes
 * through AutomationExecutor.startRun, whose unique constraint makes repeated
 * evaluation harmless.
 */
export class TriggerService {
  private readonly typeCache = new Map<string, { at: number; types: Set<string> }>();

  constructor(private readonly e: Engine) {}

  invalidate(workspaceId: string): void {
    this.typeCache.delete(workspaceId);
  }

  private async activeTriggerTypes(workspaceId: string, db: Db): Promise<Set<string>> {
    const hit = this.typeCache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.types;
    const rows = await db.selectFrom('automations').select('trigger_type').where('workspace_id', '=', workspaceId).where('status', '=', 'active').execute();
    const types = new Set(rows.map((r) => r.trigger_type));
    this.typeCache.set(workspaceId, { at: Date.now(), types });
    return types;
  }

  private async active(workspaceId: string | null, types: string[]): Promise<ActiveAutomation[]> {
    let q = this.e.db
      .selectFrom('automations')
      .selectAll()
      .where('status', '=', 'active')
      .where('trigger_type', 'in', types)
      .where('current_version_id', 'is not', null);
    if (workspaceId) q = q.where('workspace_id', '=', workspaceId);
    const rows = await q.execute();
    const out: ActiveAutomation[] = [];
    for (const automation of rows) {
      try {
        const loaded = await this.e.executor.loadVersion(automation.current_version_id!);
        out.push({ automation, versionId: automation.current_version_id!, definition: loaded.definition });
      } catch (err) {
        this.e.log.error('automation version could not be loaded', { automationId: automation.id, error: err as Error });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ contact changes

  /** Record a contact change for asynchronous trigger evaluation (cheap no-op when nothing listens). */
  async contactChanged(workspaceId: string, change: ContactChange, db: Db = this.e.db): Promise<void> {
    const types = await this.activeTriggerTypes(workspaceId, db);
    if (!CONTACT_TRIGGER_TYPES.some((t) => types.has(t))) return;
    await this.e.queue.enqueue('contact.changed', { workspaceId, ...change, at: this.e.nowIso() } as unknown as Record<string, unknown>, { workspaceId, maxAttempts: 5 }, db);
  }

  /** Job handler for `contact.changed`. */
  async handleContactChanged(job: Job): Promise<void> {
    const p = job.payload as unknown as ContactChange & { workspaceId: string; at: string };
    const contact = await this.e.db.selectFrom('contacts').selectAll().where('id', '=', p.contactId).where('workspace_id', '=', p.workspaceId).executeTakeFirst();
    if (!contact || contact.status !== 'active') return;
    const automations = await this.active(p.workspaceId, CONTACT_TRIGGER_TYPES);
    const event =
      p.change === 'event' && p.eventId
        ? await this.e.db.selectFrom('contact_events').selectAll().where('id', '=', p.eventId).where('workspace_id', '=', p.workspaceId).executeTakeFirst()
        : undefined;
    for (const a of automations) {
      const t = a.definition.trigger;
      let eventKey: string | null = null;
      let eventData: Record<string, unknown> = {};
      switch (t.type) {
        case 'contact_created':
          if (p.change === 'created') eventKey = 'created';
          break;
        case 'contact_updated':
          if (p.change === 'updated' && (t.fields.length === 0 || (p.fields ?? []).some((f) => t.fields.includes(f)))) eventKey = `updated:${p.at}`;
          break;
        case 'consent_changed':
          if (p.change === 'consent' && p.consentTo && (t.to as string[]).includes(p.consentTo)) eventKey = `consent:${p.consentTo}:${p.at}`;
          break;
        case 'tag_added':
          if (p.change === 'tag_added' && p.tag && p.tag.trim().toLowerCase() === t.tag.trim().toLowerCase()) eventKey = `tag:${p.tag.trim().toLowerCase()}:${p.at}`;
          break;
        case 'event':
          if (p.change === 'event' && event && event.name === t.name) {
            eventKey = `event:${event.id}`;
            eventData = { event: fromJson(event.properties, {}), event_name: event.name, occurred_at: event.occurred_at };
          }
          break;
        case 'segment_entered': {
          const entered = await this.e.segments.syncContactMembership(p.workspaceId, t.segmentId, contact.id);
          if (entered) eventKey = `segment:${t.segmentId}:${p.at}`;
          break;
        }
        default:
          break;
      }
      if (eventKey) {
        await this.e.executor.startRun({ workspaceId: p.workspaceId, automationId: a.automation.id, versionId: a.versionId, contactId: contact.id, eventKey, eventData });
      }
    }
  }

  // ------------------------------------------------------------ scheduler state

  async stateGet(key: string): Promise<string | null> {
    const r = await this.e.db.selectFrom('scheduler_state').select('value').where('key', '=', key).executeTakeFirst();
    return r?.value ?? null;
  }

  async stateSet(key: string, value: string): Promise<void> {
    const now = this.e.nowIso();
    await this.e.db
      .insertInto('scheduler_state')
      .values({ key, value, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
      .execute();
  }

  // ------------------------------------------------------------ calendar (birthdays, anniversaries)

  /** Contacts whose occasion is celebrated on `occasionDate` (optionally within one time zone). */
  async calendarCandidates(
    workspaceId: string,
    workspaceTz: string,
    trigger: CalendarTrigger,
    occasionDate: string,
    zone: string | null,
    afterId: string,
    limit: number,
  ): Promise<Array<{ contact: Row<'contacts'>; years: number | null }>> {
    const keys = occasionsCelebratedOn(occasionDate, trigger.leapDayPolicy).map(monthDayKey);
    let q = this.e.db.selectFrom('contacts').selectAll().where('workspace_id', '=', workspaceId).where('status', '=', 'active').where('id', '>', afterId);
    if (zone) q = q.where(sql<boolean>`coalesce(timezone, ${workspaceTz}) = ${zone}`);
    if (trigger.field === 'birthday') q = q.where('birthday_md', 'in', keys);
    else if (trigger.field === 'work_anniversary') q = q.where('anniversary_md', 'in', keys);
    else {
      const key = trigger.field.slice(7);
      const mmdd = keys.map((k) => `${pad2(Math.floor(k / 100))}-${pad2(k % 100)}`);
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom('contact_field_values as v')
            .innerJoin('custom_fields as f', 'f.id', 'v.field_id')
            .select(sql`1`.as('one'))
            .whereRef('v.contact_id', '=', 'contacts.id')
            .where('f.key', '=', key)
            .where('f.workspace_id', '=', workspaceId)
            .where(sql<boolean>`substr(v.value_text, 6, 5) in (${sql.join(mmdd)})`),
        ),
      );
    }
    const rows = await q.orderBy('id', 'asc').limit(limit).execute();
    const out: Array<{ contact: Row<'contacts'>; years: number | null }> = [];
    for (const contact of rows) {
      let years: number | null = null;
      if (trigger.field === 'work_anniversary') {
        if (!contact.work_anniversary) continue;
        years = completedYears(contact.work_anniversary, occasionDate);
        if (years < 1) continue; // the start date itself is not an anniversary
      }
      out.push({ contact, years });
    }
    return out;
  }

  private async zonesFor(a: ActiveAutomation, workspaceTz: string): Promise<string[]> {
    const t = a.definition.trigger as CalendarTrigger;
    if (t.timezoneMode === 'workspace') return [workspaceTz];
    const rows = await this.e.db
      .selectFrom('contacts')
      .select(sql<string>`coalesce(timezone, ${workspaceTz})`.as('tz'))
      .where('workspace_id', '=', a.automation.workspace_id)
      .where('status', '=', 'active')
      .distinct()
      .execute();
    return [...new Set([workspaceTz, ...rows.map((r) => r.tz)])];
  }

  /**
   * Evaluate calendar automations. For every automation and time zone a cursor
   * stores the last local date processed. Dates between the cursor and today
   * (after the send time) are processed in order; dates older than the
   * catch-up window are recorded as missed instead of sending stale greetings.
   */
  async evaluateCalendar(now: Date = this.e.now()): Promise<CalendarReport> {
    const report: CalendarReport = { automations: 0, datesProcessed: 0, runsStarted: 0, missedDates: 0 };
    for (const a of await this.active(null, ['calendar'])) {
      report.automations++;
      const t = a.definition.trigger as CalendarTrigger;
      const ws = await this.e.workspaces.row(a.automation.workspace_id);
      const send = parseTimeOfDay(t.sendTime);
      for (const zone of await this.zonesFor(a, ws.timezone)) {
        const key = `cal:${a.automation.id}:${zone}`;
        const today = localDate(now, zone);
        const pastSendTime = localMinutesOfDay(now, zone) >= send.hour * 60 + send.minute;
        const lastEligible = pastSendTime ? today : addDays(today, -1);
        const cursor = await this.stateGet(key);
        const earliest = addDays(lastEligible, -t.catchUpDays);
        let start: string;
        if (cursor) {
          start = addDays(cursor, 1);
        } else {
          // First evaluation for this automation/zone: begin at activation, never before the catch-up window.
          const activated = localDate(new Date(a.automation.activated_at ?? a.automation.updated_at), zone);
          start = compareLocalDates(activated, earliest) > 0 ? activated : earliest;
        }
        if (compareLocalDates(start, lastEligible) > 0) continue;
        const missed = cursor ? dateRange(start, addDays(earliest, -1)) : [];
        if (missed.length) {
          report.missedDates += missed.length;
          await this.e.notifications.notifyAdmins(a.automation.workspace_id, {
            kind: 'automation.missed',
            title: `"${a.automation.name}" skipped ${missed.length} past date(s)`,
            body: `Morrow was not running from ${missed[0]} to ${missed[missed.length - 1]} (${zone}). These dates are outside the ${t.catchUpDays}-day catch-up window, so no messages were sent for them.`,
            link: `/automations/${a.automation.id}`,
            dedupeKey: `missed:${a.automation.id}:${zone}:${missed[0]}`,
          });
        }
        const from = compareLocalDates(start, earliest) > 0 ? start : earliest;
        for (const d of dateRange(from, lastEligible, 31)) {
          const occasionDate = addDays(d, -t.offsetDays);
          let after = '';
          for (;;) {
            const batch = await this.calendarCandidates(a.automation.workspace_id, ws.timezone, t, occasionDate, t.timezoneMode === 'contact' ? zone : null, after, FANOUT_BATCH);
            for (const { contact, years } of batch) {
              const res = await this.e.executor.startRun({
                workspaceId: a.automation.workspace_id,
                automationId: a.automation.id,
                versionId: a.versionId,
                contactId: contact.id,
                eventKey: calendarEventKey(t.field, occasionDate),
                eventData: { field: t.field, occasion_date: occasionDate, ...(years !== null ? { years } : {}) },
              });
              if (res.created) report.runsStarted++;
            }
            if (batch.length < FANOUT_BATCH) break;
            after = batch[batch.length - 1]!.contact.id;
          }
          report.datesProcessed++;
          await this.stateSet(key, d);
        }
        await this.stateSet(key, lastEligible);
      }
    }
    return report;
  }

  // ------------------------------------------------------------ schedules, inactivity, segments

  async evaluateSchedules(now: Date = this.e.now()): Promise<number> {
    let fanouts = 0;
    for (const a of await this.active(null, ['schedule'])) {
      const t = a.definition.trigger as Extract<Trigger, { type: 'schedule' }>;
      const ws = await this.e.workspaces.row(a.automation.workspace_id);
      const key = `sched:${a.automation.id}`;
      const cursor = (await this.stateGet(key)) ?? a.automation.activated_at ?? now.toISOString();
      const occurrences = occurrencesBetween(t.recurrence, new Date(cursor), now, ws.timezone, 50);
      for (const occ of occurrences) {
        if (now.getTime() - occ.getTime() > 24 * 3_600_000) continue; // outside the catch-up window
        const eventKey = `schedule:${occ.toISOString()}`;
        await this.e.queue.enqueue(
          'automation.fanout',
          { automationId: a.automation.id, versionId: a.versionId, mode: 'audience', segmentId: t.segmentId ?? null, eventKey, afterId: '' },
          { workspaceId: a.automation.workspace_id, dedupeKey: `fanout:${a.automation.id}:${eventKey}:` },
        );
        fanouts++;
      }
      await this.stateSet(key, now.toISOString());
    }
    return fanouts;
  }

  async evaluateInactivity(now: Date = this.e.now()): Promise<number> {
    let fanouts = 0;
    for (const a of await this.active(null, ['inactivity'])) {
      const t = a.definition.trigger as Extract<Trigger, { type: 'inactivity' }>;
      const ws = await this.e.workspaces.row(a.automation.workspace_id);
      const today = localDate(now, ws.timezone);
      const send = parseTimeOfDay(t.sendTime);
      if (localMinutesOfDay(now, ws.timezone) < send.hour * 60 + send.minute) continue;
      const key = `inact:${a.automation.id}`;
      if ((await this.stateGet(key)) === today) continue;
      await this.e.queue.enqueue(
        'automation.fanout',
        { automationId: a.automation.id, versionId: a.versionId, mode: 'inactivity', days: t.days, eventKey: `inactive:${today}`, afterId: '' },
        { workspaceId: a.automation.workspace_id, dedupeKey: `fanout:${a.automation.id}:inactive:${today}:` },
      );
      await this.stateSet(key, today);
      fanouts++;
    }
    return fanouts;
  }

  /** Periodic sweep for "enters segment" triggers (catches time-based criteria). */
  async sweepSegments(): Promise<number> {
    let started = 0;
    for (const a of await this.active(null, ['segment_entered'])) {
      const t = a.definition.trigger as Extract<Trigger, { type: 'segment_entered' }>;
      const entered = await this.e.segments.refreshMemberships(a.automation.workspace_id, t.segmentId);
      const at = this.e.nowIso();
      for (const contactId of entered) {
        const res = await this.e.executor.startRun({
          workspaceId: a.automation.workspace_id,
          automationId: a.automation.id,
          versionId: a.versionId,
          contactId,
          eventKey: `segment:${t.segmentId}:${at}`,
        });
        if (res.created) started++;
      }
    }
    return started;
  }

  /**
   * Job handler for `automation.fanout`: start runs for one batch of an
   * audience and enqueue the next batch, keeping memory bounded.
   */
  async handleFanout(job: Job): Promise<void> {
    const p = job.payload as {
      automationId: string;
      versionId: string;
      mode: 'audience' | 'inactivity' | 'contacts';
      segmentId?: string | null;
      criteria?: CriteriaGroup;
      contactIds?: string[];
      days?: number;
      eventKey: string;
      eventData?: Record<string, unknown>;
      afterId: string;
    };
    const automation = await this.e.db.selectFrom('automations').selectAll().where('id', '=', p.automationId).executeTakeFirst();
    if (!automation || automation.status !== 'active') return;
    const ws = automation.workspace_id;
    let batch: Row<'contacts'>[];
    if (p.mode === 'inactivity') {
      const cutoff = new Date(this.e.now().getTime() - (p.days ?? 90) * 86_400_000).toISOString();
      batch = await this.e.db
        .selectFrom('contacts')
        .selectAll()
        .where('workspace_id', '=', ws)
        .where('status', '=', 'active')
        .where(sql<boolean>`coalesce(last_interaction_at, created_at) < ${cutoff}`)
        .where('id', '>', p.afterId)
        .orderBy('id', 'asc')
        .limit(FANOUT_BATCH)
        .execute();
    } else if (p.mode === 'contacts') {
      const ids = (p.contactIds ?? []).filter((id) => id > p.afterId).sort().slice(0, FANOUT_BATCH);
      batch = ids.length ? await this.e.db.selectFrom('contacts').selectAll().where('workspace_id', '=', ws).where('id', 'in', ids).orderBy('id', 'asc').execute() : [];
    } else {
      const criteria = p.criteria ?? (await this.e.segments.criteriaFor(ws, p.segmentId ?? null).catch(() => emptyCriteria()));
      batch = await this.e.segments.contactBatch(ws, criteria, p.afterId, FANOUT_BATCH);
    }
    for (const contact of batch) {
      const eventKey = p.mode === 'inactivity' ? `inactive:${(contact.last_interaction_at ?? contact.created_at).slice(0, 10)}` : p.eventKey;
      await this.e.executor.startRun({ workspaceId: ws, automationId: automation.id, versionId: p.versionId, contactId: contact.id, eventKey, eventData: p.eventData });
    }
    if (batch.length === FANOUT_BATCH) {
      const afterId = batch[batch.length - 1]!.id;
      await this.e.queue.enqueue('automation.fanout', { ...p, afterId } as unknown as Record<string, unknown>, {
        workspaceId: ws,
        dedupeKey: `fanout:${automation.id}:${p.eventKey}:${afterId}`,
      });
    }
  }

  /** Parse a stored definition (used by callers that only have the row). */
  parseDefinition(json: string): AutomationDefinition {
    return automationDefinitionSchema.parse(fromJson(json, {}));
  }
}

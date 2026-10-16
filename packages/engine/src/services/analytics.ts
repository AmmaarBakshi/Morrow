import {
  addDays,
  computeRates,
  dateRange,
  emptyCounts,
  isValidLocalDate,
  localDate,
  maskEmail,
  OPEN_TRACKING_DISCLAIMER,
  startOfLocalDay,
  toCsv,
  ValidationError,
  type AnalyticsOverviewDTO,
  type AutomationPerformanceDTO,
  type CampaignComparisonDTO,
  type CampaignStatus,
  type FailureReasonDTO,
  type MessageCounts,
  type MessageRates,
  type ProviderReporting,
  type TimeseriesPointDTO,
} from '@morrow/core';
import { chunk, sql } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export interface RangeInput {
  from?: string;
  to?: string;
}

export interface ResolvedRange {
  fromDate: string;
  toDate: string;
  fromIso: string;
  toIso: string;
  timezone: string;
}

const COUNTED_KINDS = ['campaign', 'automation'];

/** Conditional aggregates producing MessageCounts in one pass (portable SQL). */
const COUNT_COLUMNS = sql<Record<string, number>>`
  count(*) as total,
  sum(case when status = 'queued' then 1 else 0 end) as queued,
  sum(case when status = 'pending_approval' then 1 else 0 end) as pending_approval,
  sum(case when sent_at is not null then 1 else 0 end) as sent,
  sum(case when delivered_at is not null then 1 else 0 end) as delivered,
  sum(case when bounced_at is not null then 1 else 0 end) as bounced,
  sum(case when bounce_type = 'hard' then 1 else 0 end) as hard_bounced,
  sum(case when bounce_type = 'soft' then 1 else 0 end) as soft_bounced,
  sum(case when status in ('failed', 'uncertain') then 1 else 0 end) as failed,
  sum(case when status = 'rejected' then 1 else 0 end) as rejected,
  sum(case when complained_at is not null then 1 else 0 end) as complained,
  sum(case when unsubscribed_at is not null then 1 else 0 end) as unsubscribed,
  sum(case when opened_at is not null then 1 else 0 end) as opened,
  sum(case when clicked_at is not null then 1 else 0 end) as clicked,
  sum(case when status = 'suppressed' then 1 else 0 end) as suppressed,
  sum(case when status = 'cancelled' then 1 else 0 end) as cancelled`;

function toCounts(r: Record<string, unknown> | undefined): MessageCounts {
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    total: n('total'),
    queued: n('queued'),
    pendingApproval: n('pending_approval'),
    sent: n('sent'),
    delivered: n('delivered'),
    bounced: n('bounced'),
    hardBounced: n('hard_bounced'),
    softBounced: n('soft_bounced'),
    failed: n('failed'),
    rejected: n('rejected'),
    complained: n('complained'),
    unsubscribed: n('unsubscribed'),
    opened: n('opened'),
    clicked: n('clicked'),
    suppressed: n('suppressed'),
    cancelled: n('cancelled'),
  };
}

/**
 * Reporting built only from recorded provider events and Morrow's own
 * records. Provider acceptance is never reported as delivery, and rates the
 * provider cannot measure are null.
 */
export class AnalyticsService {
  constructor(private readonly e: Engine) {}

  async range(workspaceId: string, input: RangeInput = {}): Promise<ResolvedRange> {
    const ws = await this.e.workspaces.row(workspaceId);
    const today = localDate(this.e.now(), ws.timezone);
    const toDate = input.to && isValidLocalDate(input.to) ? input.to : today;
    const fromDate = input.from && isValidLocalDate(input.from) ? input.from : addDays(toDate, -29);
    if (fromDate > toDate) throw new ValidationError('The start date must be before the end date.');
    if (dateRange(fromDate, toDate, 400).length > 366) throw new ValidationError('Choose a range of at most one year.');
    return {
      fromDate,
      toDate,
      fromIso: startOfLocalDay(fromDate, ws.timezone).toISOString(),
      toIso: startOfLocalDay(addDays(toDate, 1), ws.timezone).toISOString(),
      timezone: ws.timezone,
    };
  }

  /** What the active provider (plus Morrow's own tracking) can measure. */
  async reporting(workspaceId: string): Promise<ProviderReporting> {
    const [{ settings }, resolved] = await Promise.all([this.e.workspaces.settings(workspaceId), this.e.integrations.resolveEmailProvider(workspaceId)]);
    const caps = resolved?.provider.capabilities;
    return {
      deliveryEvents: Boolean(caps?.deliveryEvents),
      openTracking: settings.tracking.opens || Boolean(caps?.openTracking),
      clickTracking: settings.tracking.clicks || Boolean(caps?.clickTracking),
    };
  }

  rates(counts: MessageCounts, reporting: ProviderReporting): MessageRates {
    return computeRates(counts, reporting);
  }

  /** Counts grouped by campaign or automation. */
  async groupedCounts(workspaceId: string, column: 'campaign_id' | 'automation_id', ids: string[], range?: ResolvedRange): Promise<Map<string, MessageCounts>> {
    const out = new Map<string, MessageCounts>();
    for (const batch of chunk(ids, 500)) {
      if (!batch.length) continue;
      const rangeSql = range ? sql`and created_at >= ${range.fromIso} and created_at < ${range.toIso}` : sql``;
      const rows = await sql<Record<string, unknown>>`
        select ${sql.ref(column)} as group_id, ${COUNT_COLUMNS}
        from messages
        where workspace_id = ${workspaceId}
          and kind in ('campaign', 'automation')
          and ${sql.ref(column)} in (${sql.join(batch)})
          ${rangeSql}
        group by ${sql.ref(column)}`.execute(this.e.db);
      for (const r of rows.rows) out.set(String(r.group_id), toCounts(r));
    }
    return out;
  }

  async rangeCounts(workspaceId: string, range: ResolvedRange, extra: { campaignId?: string; automationId?: string } = {}): Promise<MessageCounts> {
    const rows = await sql<Record<string, unknown>>`
      select ${COUNT_COLUMNS}
      from messages
      where workspace_id = ${workspaceId}
        and kind in ('campaign', 'automation')
        and created_at >= ${range.fromIso} and created_at < ${range.toIso}
        ${extra.campaignId ? sql`and campaign_id = ${extra.campaignId}` : sql``}
        ${extra.automationId ? sql`and automation_id = ${extra.automationId}` : sql``}`.execute(this.e.db);
    return toCounts(rows.rows[0]);
  }

  async overview(ctx: WorkspaceContext, input: RangeInput & { campaignId?: string; automationId?: string } = {}): Promise<AnalyticsOverviewDTO> {
    authorize(ctx, 'analytics:read');
    const range = await this.range(ctx.workspaceId, input);
    const counts = await this.rangeCounts(ctx.workspaceId, range, input);
    const reporting = await this.reporting(ctx.workspaceId);
    return { from: range.fromDate, to: range.toDate, counts, rates: this.rates(counts, reporting), reporting, openDisclaimer: OPEN_TRACKING_DISCLAIMER };
  }

  /**
   * Daily series in the workspace time zone. Day boundaries are computed in
   * JS and bucketed with a CASE expression, so half-hour zones (IST) are exact.
   */
  async timeseries(ctx: WorkspaceContext, input: RangeInput = {}): Promise<TimeseriesPointDTO[]> {
    authorize(ctx, 'analytics:read');
    const range = await this.range(ctx.workspaceId, input);
    const days = dateRange(range.fromDate, range.toDate);
    const bounds = [...days, addDays(range.toDate, 1)].map((d) => startOfLocalDay(d, range.timezone).toISOString());
    const points: TimeseriesPointDTO[] = days.map((date) => ({ date, sent: 0, delivered: 0, bounced: 0, failed: 0, opened: 0, clicked: 0, complained: 0, unsubscribed: 0 }));
    const metrics: Array<[keyof Omit<TimeseriesPointDTO, 'date'>, string, string | null]> = [
      ['sent', 'sent_at', null],
      ['delivered', 'delivered_at', null],
      ['bounced', 'bounced_at', null],
      ['failed', 'failed_at', null],
      ['opened', 'opened_at', null],
      ['clicked', 'clicked_at', null],
      ['complained', 'complained_at', null],
      ['unsubscribed', 'unsubscribed_at', null],
    ];
    for (const [metric, column] of metrics) {
      const col = sql.ref(column);
      const cases = sql.join(
        bounds.slice(1).map((b, i) => sql`when ${col} < ${b} then ${sql.lit(i)}`),
        sql` `,
      );
      const res = await sql<{ bucket: number; n: number }>`
        select case ${cases} end as bucket, count(*) as n
        from messages
        where workspace_id = ${ctx.workspaceId}
          and kind in ('campaign', 'automation')
          and ${col} >= ${bounds[0]!} and ${col} < ${bounds[bounds.length - 1]!}
        group by bucket`.execute(this.e.db);
      for (const r of res.rows) {
        const idx = Number(r.bucket);
        if (points[idx]) points[idx]![metric] = Number(r.n);
      }
    }
    return points;
  }

  async campaigns(ctx: WorkspaceContext, input: RangeInput = {}): Promise<CampaignComparisonDTO[]> {
    authorize(ctx, 'analytics:read');
    const range = await this.range(ctx.workspaceId, input);
    const rows = await this.e.db
      .selectFrom('campaigns')
      .select(['id', 'name', 'status', 'launched_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('launched_at', 'is not', null)
      .where('launched_at', '>=', range.fromIso)
      .where('launched_at', '<', range.toIso)
      .orderBy('launched_at', 'desc')
      .limit(100)
      .execute();
    const counts = await this.groupedCounts(ctx.workspaceId, 'campaign_id', rows.map((r) => r.id));
    const reporting = await this.reporting(ctx.workspaceId);
    return rows.map((r) => {
      const c = counts.get(r.id) ?? emptyCounts();
      return { id: r.id, name: r.name, status: r.status as CampaignStatus, launchedAt: r.launched_at, counts: c, rates: this.rates(c, reporting) };
    });
  }

  async automations(ctx: WorkspaceContext, input: RangeInput = {}): Promise<AutomationPerformanceDTO[]> {
    authorize(ctx, 'analytics:read');
    const range = await this.range(ctx.workspaceId, input);
    const rows = await this.e.db
      .selectFrom('automations')
      .select(['id', 'name', 'status', 'trigger_type'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '!=', 'archived')
      .execute();
    const counts = await this.groupedCounts(ctx.workspaceId, 'automation_id', rows.map((r) => r.id), range);
    const reporting = await this.reporting(ctx.workspaceId);
    return rows.map((r) => {
      const c = counts.get(r.id) ?? emptyCounts();
      return { id: r.id, name: r.name, status: r.status, triggerType: r.trigger_type, counts: c, rates: this.rates(c, reporting) };
    });
  }

  /** Why messages did not go out, grouped by reason (addresses are masked). */
  async failures(ctx: WorkspaceContext, input: RangeInput = {}): Promise<FailureReasonDTO[]> {
    authorize(ctx, 'analytics:read');
    const range = await this.range(ctx.workspaceId, input);
    const rows = await this.e.db
      .selectFrom('messages')
      .select([
        'status',
        'error_code',
        'error_class',
        (eb) => eb.fn.countAll<number>().as('n'),
        (eb) => eb.fn.max('updated_at').as('last_at'),
        (eb) => eb.fn.max('error_message').as('sample'),
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', 'in', COUNTED_KINDS)
      .where('created_at', '>=', range.fromIso)
      .where('created_at', '<', range.toIso)
      .where('status', 'in', ['failed', 'rejected', 'bounced', 'complained', 'suppressed', 'uncertain'])
      .groupBy(['status', 'error_code', 'error_class'])
      .orderBy((eb) => eb.fn.countAll(), 'desc')
      .limit(25)
      .execute();
    const mask = (s: string) => s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => maskEmail(m));
    return rows.map((r) => ({
      reason: mask(String(r.sample ?? r.error_code ?? r.status)).slice(0, 300),
      errorClass: r.error_class,
      status: r.status,
      count: Number(r.n),
      lastAt: String(r.last_at),
    }));
  }

  async exportCsv(ctx: WorkspaceContext, input: RangeInput = {}): Promise<string> {
    authorize(ctx, 'analytics:read');
    const [series, campaigns, automations] = await Promise.all([this.timeseries(ctx, input), this.campaigns(ctx, input), this.automations(ctx, input)]);
    const pct = (v: number | null) => (v === null ? '' : (v * 100).toFixed(2));
    const parts = [
      toCsv([['date', 'sent', 'delivered', 'bounced', 'failed', 'opened_estimated', 'clicked', 'complained', 'unsubscribed'], ...series.map((p) => [p.date, p.sent, p.delivered, p.bounced, p.failed, p.opened, p.clicked, p.complained, p.unsubscribed])]),
      toCsv([
        ['campaign', 'launched_at', 'sent', 'delivered', 'bounced', 'opened_estimated', 'clicked', 'unsubscribed', 'delivery_rate_%', 'open_rate_estimated_%', 'click_rate_%'],
        ...campaigns.map((c) => [c.name, c.launchedAt, c.counts.sent, c.counts.delivered, c.counts.bounced, c.counts.opened, c.counts.clicked, c.counts.unsubscribed, pct(c.rates.deliveryRate), pct(c.rates.openRate), pct(c.rates.clickRate)]),
      ]),
      toCsv([
        ['automation', 'trigger', 'sent', 'delivered', 'bounced', 'opened_estimated', 'clicked', 'unsubscribed'],
        ...automations.map((a) => [a.name, a.triggerType, a.counts.sent, a.counts.delivered, a.counts.bounced, a.counts.opened, a.counts.clicked, a.counts.unsubscribed]),
      ]),
    ];
    await this.e.audit.record(ctx, 'analytics.exported', null, {});
    return parts.join('\r\n');
  }
}

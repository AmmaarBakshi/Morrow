import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Download } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { AutomationPerformanceDTO, CampaignComparisonDTO } from '@morrow/core';
import { BarList } from '../components/charts/BarList';
import { LineChart } from '../components/charts/LineChart';
import { buttonClass } from '../components/ui/button';
import { Card, CardHeader, ErrorState, Loading, Notice, PageHeader, Stat, StatusBadge } from '../components/ui/display';
import { Input } from '../components/ui/field';
import { DataTable } from '../components/ui/table';
import { api } from '../lib/api';
import { formatNumber, formatPercent, humanize, todayIn } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useWorkspace } from '../lib/session';

const PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

export default function AnalyticsPage() {
  useDocumentTitle('Analytics');
  const { workspace } = useWorkspace();
  const [preset, setPreset] = useState<number | null>(30);
  const [custom, setCustom] = useState({ from: todayIn(workspace.timezone, -29), to: todayIn(workspace.timezone) });
  const range = preset ? { from: todayIn(workspace.timezone, -(preset - 1)), to: todayIn(workspace.timezone) } : custom;

  const overview = useQuery({ queryKey: ['analytics', 'overview', range], queryFn: () => api.analytics.overview(range) });
  const series = useQuery({ queryKey: ['analytics', 'series', range], queryFn: () => api.analytics.timeseries(range) });
  const campaigns = useQuery({ queryKey: ['analytics', 'campaigns', range], queryFn: () => api.analytics.campaigns(range) });
  const automations = useQuery({ queryKey: ['analytics', 'automations', range], queryFn: () => api.analytics.automations(range) });
  const failures = useQuery({ queryKey: ['analytics', 'failures', range], queryFn: () => api.analytics.failures(range) });
  const fetching = overview.isFetching || series.isFetching;

  const rateColumns = <T extends { counts: { sent: number }; rates: CampaignComparisonDTO['rates'] }>() => [
    { key: 'sent', header: 'Sent', align: 'right' as const, cell: (r: T) => formatNumber(r.counts.sent) },
    { key: 'delivered', header: 'Delivered', align: 'right' as const, cell: (r: T) => formatPercent(r.rates.deliveryRate) },
    { key: 'bounced', header: 'Bounced', align: 'right' as const, cell: (r: T) => formatPercent(r.rates.bounceRate) },
    { key: 'clicked', header: 'Clicked', align: 'right' as const, cell: (r: T) => formatPercent(r.rates.clickRate) },
    { key: 'unsub', header: 'Unsubscribed', align: 'right' as const, cell: (r: T) => formatPercent(r.rates.unsubscribeRate) },
  ];

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Delivery and engagement by local day in ${workspace.timezone}. Numbers come from your provider’s events; opens are estimates.`}
        actions={
          <a href={`/api/v1/analytics/export?from=${range.from}&to=${range.to}`} className={buttonClass('secondary')} download>
            <Download className="size-4" /> Export CSV
          </a>
        }
      />
      {/* One filter row scopes everything below it. */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.days} onClick={() => setPreset(p.days)} className={clsx('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm', preset === p.days ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-line bg-surface text-ink-2 hover:bg-surface-2')} aria-pressed={preset === p.days}>
            {preset === p.days ? <Check className="size-4" /> : null}
            {p.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        <Input type="date" className="w-auto" aria-label="From" value={preset ? range.from : custom.from} onChange={(e) => (setPreset(null), setCustom({ ...range, from: e.target.value }))} />
        <span className="text-muted">to</span>
        <Input type="date" className="w-auto" aria-label="To" value={preset ? range.to : custom.to} onChange={(e) => (setPreset(null), setCustom({ ...range, to: e.target.value }))} />
      </div>

      {overview.isError ? <ErrorState error={overview.error} retry={() => overview.refetch()} /> : null}
      {overview.data ? (
        <div className={clsx('grid gap-4 sm:grid-cols-2 xl:grid-cols-5', fetching && 'opacity-60 transition-opacity')}>
          <Stat label="Sent" value={formatNumber(overview.data.counts.sent, { compact: true })} sub={`${formatNumber(overview.data.counts.failed)} failed · ${formatNumber(overview.data.counts.suppressed)} suppressed`} />
          <Stat label="Delivery rate" value={formatPercent(overview.data.rates.deliveryRate)} sub={`${formatNumber(overview.data.counts.delivered)} delivered`} />
          <Stat label="Bounce rate" value={formatPercent(overview.data.rates.bounceRate)} sub={`${formatNumber(overview.data.counts.hardBounced)} hard · ${formatNumber(overview.data.counts.softBounced)} soft`} />
          <Stat label="Click rate" value={formatPercent(overview.data.rates.clickRate)} sub={`Opens (est.) ${formatPercent(overview.data.rates.openRate)}`} />
          <Stat label="Unsubscribe rate" value={formatPercent(overview.data.rates.unsubscribeRate, 2)} sub={`${formatNumber(overview.data.counts.complained)} spam complaints`} />
        </div>
      ) : overview.isLoading ? (
        <Loading />
      ) : null}
      {overview.data && !overview.data.reporting.deliveryEvents ? (
        <div className="mt-4"><Notice tone="warn">Your e-mail provider only confirms acceptance, so delivery and bounce rates are unavailable. Configure webhooks in Settings → Sending.</Notice></div>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Delivery" description="Accepted, delivered and bounced per day." />
          {series.data ? (
            <LineChart
              title="Sent, delivered and bounced e-mails per day"
              data={series.data.items.map((p) => ({ date: p.date, sent: p.sent, delivered: p.delivered, bounced: p.bounced }))}
              series={[
                { key: 'sent', label: 'Sent', color: 'var(--series-1)' },
                { key: 'delivered', label: 'Delivered', color: 'var(--series-2)' },
                { key: 'bounced', label: 'Bounced', color: 'var(--series-3)' },
              ]}
              dim={series.isFetching}
            />
          ) : <Loading />}
        </Card>
        <Card>
          <CardHeader title="Engagement" description="Unique clicks, estimated opens and unsubscribes per day." />
          {series.data ? (
            <LineChart
              title="Clicks, estimated opens and unsubscribes per day"
              data={series.data.items.map((p) => ({ date: p.date, clicked: p.clicked, opened: p.opened, unsubscribed: p.unsubscribed }))}
              series={[
                { key: 'clicked', label: 'Clicked', color: 'var(--series-1)' },
                { key: 'opened', label: 'Opened (est.)', color: 'var(--series-2)' },
                { key: 'unsubscribed', label: 'Unsubscribed', color: 'var(--series-3)' },
              ]}
              dim={series.isFetching}
            />
          ) : <Loading />}
          {overview.data ? <p className="mt-3 text-xs text-muted">{overview.data.openDisclaimer}</p> : null}
        </Card>
      </div>

      <Card padded={false} className="mt-6">
        <div className="p-5 pb-2"><CardHeader title="Campaigns" description="Launched in this period." /></div>
        <DataTable<CampaignComparisonDTO>
          rows={campaigns.data?.items ?? []}
          rowKey={(c) => c.id}
          dim={campaigns.isFetching}
          empty={<p className="pb-8 text-center text-sm text-muted">No campaigns in this period.</p>}
          columns={[{ key: 'name', header: 'Campaign', cell: (c) => <Link to={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link> }, { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> }, ...rateColumns<CampaignComparisonDTO>()]}
        />
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card padded={false}>
          <div className="p-5 pb-2"><CardHeader title="Automations" /></div>
          <DataTable<AutomationPerformanceDTO>
            rows={automations.data?.items ?? []}
            rowKey={(a) => a.id}
            dim={automations.isFetching}
            empty={<p className="pb-8 text-center text-sm text-muted">No automation e-mail in this period.</p>}
            columns={[{ key: 'name', header: 'Automation', cell: (a) => <Link to={`/automations/${a.id}`} className="font-medium hover:underline">{a.name}</Link> }, ...rateColumns<AutomationPerformanceDTO>()]}
          />
        </Card>
        <Card>
          <CardHeader title="Why messages failed" description="Bounces, rejections and send failures, grouped by reason." />
          {failures.data?.items.length ? (
            <BarList
              label="Failure reasons"
              color="var(--series-2)"
              items={failures.data.items.slice(0, 8).map((f, i) => ({ key: `${i}`, label: f.reason, value: f.count, detail: `${humanize(f.status)}${f.errorClass ? ` · ${f.errorClass}` : ''}` }))}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted">No failures in this period.</p>
          )}
        </Card>
      </div>
    </>
  );
}

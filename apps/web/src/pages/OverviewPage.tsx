import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cake, CalendarClock, Check, CheckCircle2, Circle, ClipboardCheck, Mail, Users } from 'lucide-react';
import { Link } from 'react-router';
import { LineChart } from '../components/charts/LineChart';
import { ButtonLink } from '../components/ui/button';
import { Card, CardHeader, EmptyState, ErrorState, Loading, PageHeader, Stat, StatusBadge } from '../components/ui/display';
import { api } from '../lib/api';
import { formatDateTime, formatNumber, formatPercent, formatRelative, humanize, todayIn } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useWorkspace } from '../lib/session';

function SetupChecklist({ setup }: { setup: Record<string, boolean> }) {
  const steps = [
    { key: 'providerConfigured', label: 'Connect an e-mail provider', to: '/settings/sending' },
    { key: 'senderVerified', label: 'Verify a sender address', to: '/settings/sending' },
    { key: 'hasContacts', label: 'Add or import contacts', to: '/contacts/import' },
    { key: 'hasTemplates', label: 'Publish a template', to: '/templates' },
    { key: 'hasAutomations', label: 'Turn on the birthday automation', to: '/automations' },
  ];
  const done = steps.filter((s) => setup[s.key]).length;
  if (done === steps.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader title="Get Morrow ready" description={`${done} of ${steps.length} done. Nothing is sent until you turn it on.`} />
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => (
          <li key={s.key}>
            <Link to={s.to} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-[13px] hover:bg-surface-2">
              {setup[s.key] ? <CheckCircle2 className="size-4 shrink-0 text-good" /> : <Circle className="size-4 shrink-0 text-muted" />}
              <span className={setup[s.key] ? 'text-muted line-through' : 'text-ink'}>{s.label}</span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function OverviewPage() {
  useDocumentTitle('Overview');
  const { workspace, user } = useWorkspace();
  const from = todayIn(workspace.timezone, -29);
  const to = todayIn(workspace.timezone);
  const dash = useQuery({ queryKey: ['dashboard', from, to], queryFn: () => api.workspace.dashboard({ from, to }) });
  const series = useQuery({ queryKey: ['timeseries', from, to], queryFn: () => api.analytics.timeseries({ from, to }) });

  if (dash.isLoading) return <Loading />;
  if (dash.isError || !dash.data) return <ErrorState error={dash.error} retry={() => dash.refetch()} />;
  const d = dash.data;
  const { counts, rates } = d.messages;
  const reviews = d.approvals.messages + d.approvals.campaigns;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: workspace.timezone }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader title={`${greeting}, ${user.name.split(' ')[0]}`} description={`Here is ${workspace.name} over the last 30 days (${workspace.timezone}).`} actions={<ButtonLink to="/campaigns" variant="primary" icon={<Mail className="size-4" />}>New campaign</ButtonLink>} />
      <SetupChecklist setup={d.setup} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active contacts" value={formatNumber(d.contacts.active, { compact: true })} sub={`${formatNumber(d.contacts.newInRange)} new · ${formatNumber(d.contacts.marketingEligible)} can receive marketing`} icon={<Users className="size-4" />} />
        <Stat label="E-mails sent" value={formatNumber(counts.sent, { compact: true })} sub={`${formatNumber(counts.delivered)} delivered · ${formatNumber(counts.bounced)} bounced`} icon={<Mail className="size-4" />} />
        <Stat label="Delivery rate" value={formatPercent(rates.deliveryRate)} sub={d.messages.reporting.deliveryEvents ? `Bounce rate ${formatPercent(rates.bounceRate)}` : 'Your provider does not report deliveries'} icon={<Check className="size-4" />} />
        <Stat
          label="Waiting for review"
          value={formatNumber(reviews)}
          sub={reviews ? <Link to="/approvals" className="text-accent-text hover:underline">Review now</Link> : 'Nothing waiting'}
          icon={<ClipboardCheck className="size-4" />}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Delivery over time" description="Messages accepted by your provider, confirmed deliveries and bounces per day." />
          {series.data ? (
            <LineChart
              title="Sent, delivered and bounced e-mails per day for the last 30 days"
              data={series.data.items.map((p) => ({ date: p.date, sent: p.sent, delivered: p.delivered, bounced: p.bounced }))}
              series={[
                { key: 'sent', label: 'Sent', color: 'var(--series-1)' },
                { key: 'delivered', label: 'Delivered', color: 'var(--series-2)' },
                { key: 'bounced', label: 'Bounced', color: 'var(--series-3)' },
              ]}
              dim={series.isFetching}
            />
          ) : (
            <Loading />
          )}
        </Card>

        <Card>
          <CardHeader title="Coming up" description="Birthdays and anniversaries in the next two weeks." action={<Link to="/calendar" className="text-xs text-accent-text hover:underline">Calendar</Link>} />
          {d.upcomingOccasions.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {d.upcomingOccasions.slice(0, 7).map((o) => (
                <li key={`${o.contactId}-${o.kind}`} className="flex items-center gap-3 py-2.5">
                  <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent-text">
                    {o.kind === 'birthday' ? <Cake className="size-4" /> : <CalendarClock className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to={`/contacts/${o.contactId}`} className="block truncate text-sm font-medium text-ink hover:underline">
                      {o.name}
                    </Link>
                    <p className="text-xs text-muted">
                      {o.kind === 'birthday' ? 'Birthday' : `${o.years ?? ''} year work anniversary`} · {humanize(o.relationshipType)}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-ink-2">{o.daysAway === 0 ? 'Today' : o.daysAway === 1 ? 'Tomorrow' : `in ${o.daysAway} days`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Cake className="size-5" />} title="No occasions soon" description="Add birthdays to contacts and Morrow will remember them for you." />
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent campaigns" action={<Link to="/campaigns" className="text-xs text-accent-text hover:underline">All campaigns</Link>} />
          {d.recentCampaigns.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {d.recentCampaigns.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link to={`/campaigns/${c.id}`} className="block truncate text-sm font-medium hover:underline">
                      {c.name}
                    </Link>
                    <p className="text-xs text-muted">{c.launchedAt ? formatRelative(c.launchedAt) : 'Not launched'}</p>
                  </div>
                  <div className="tabular text-right text-xs text-ink-2">
                    <p>{formatNumber(c.counts.sent)} sent</p>
                    <p>{formatPercent(c.rates.deliveryRate)} delivered</p>
                  </div>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No campaigns yet" action={<ButtonLink to="/campaigns" size="sm">Create one</ButtonLink>} />
          )}
        </Card>

        <Card>
          <CardHeader title="Needs attention" description="Scheduled sends, failures and open tasks." />
          <ul className="flex flex-col divide-y divide-line text-sm">
            {d.scheduled.slice(0, 4).map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <CalendarClock className="size-4 shrink-0 text-accent-text" />
                <Link to={s.link} className="min-w-0 flex-1 truncate hover:underline">
                  {s.title}
                </Link>
                <span className="text-xs text-muted">{formatDateTime(s.at, workspace.timezone)}</span>
              </li>
            ))}
            {d.failures.slice(0, 4).map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-2.5">
                <AlertTriangle className="size-4 shrink-0 text-bad" />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{f.title}</p>
                  <p className="truncate text-xs text-muted">{f.detail}</p>
                </div>
                <span className="text-xs text-muted">{formatRelative(f.at)}</span>
              </li>
            ))}
            {d.tasks.items.slice(0, 4).map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <Circle className="size-4 shrink-0 text-warn" />
                <Link to="/tasks" className="min-w-0 flex-1 truncate hover:underline">
                  {t.title}
                </Link>
                {t.dueAt ? <span className="text-xs text-muted">due {formatRelative(t.dueAt)}</span> : null}
              </li>
            ))}
            {!d.scheduled.length && !d.failures.length && !d.tasks.items.length ? <li className="py-8 text-center text-muted">All clear.</li> : null}
          </ul>
        </Card>
      </div>
    </>
  );
}

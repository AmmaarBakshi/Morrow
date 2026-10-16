import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Cake, CalendarClock, CheckSquare, ChevronLeft, ChevronRight, Megaphone, Workflow } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { CalendarEventDTO } from '@morrow/core';
import { Button } from '../components/ui/button';
import { Card, ErrorState, PageHeader } from '../components/ui/display';
import { api } from '../lib/api';
import { monthName, todayIn } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useWorkspace } from '../lib/session';

const KIND: Record<CalendarEventDTO['kind'], { icon: ReactNode; label: string; className: string }> = {
  birthday: { icon: <Cake className="size-3" />, label: 'Birthday', className: 'bg-accent-soft text-accent-text' },
  work_anniversary: { icon: <CalendarClock className="size-3" />, label: 'Work anniversary', className: 'bg-good-soft text-good' },
  campaign: { icon: <Megaphone className="size-3" />, label: 'Campaign', className: 'bg-warn-soft text-warn' },
  automation: { icon: <Workflow className="size-3" />, label: 'Automation send', className: 'bg-surface-3 text-ink-2' },
  resume: { icon: <Workflow className="size-3" />, label: 'Automation step', className: 'bg-surface-3 text-ink-2' },
  task: { icon: <CheckSquare className="size-3" />, label: 'Task due', className: 'bg-bad-soft text-bad' },
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function EventChip({ e }: { e: CalendarEventDTO }) {
  const k = KIND[e.kind];
  const body = (
    <span className={clsx('flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium', k.className)} title={`${k.label}: ${e.title}${e.subtitle ? ` — ${e.subtitle}` : ''}`}>
      {k.icon}
      <span className="truncate">{e.time ? `${e.time} ` : ''}{e.title}</span>
    </span>
  );
  return e.link ? <Link to={e.link} className="block hover:opacity-80">{body}</Link> : body;
}

export default function CalendarPage() {
  useDocumentTitle('Calendar');
  const { workspace } = useWorkspace();
  const today = todayIn(workspace.timezone);
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const daysInMonth = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate();
  const from = iso(ym.y, ym.m, 1);
  const to = iso(ym.y, ym.m, daysInMonth);
  const events = useQuery({ queryKey: ['calendar', from, to], queryFn: () => api.calendar.events({ from, to }) });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventDTO[]>();
    for (const e of events.data?.items ?? []) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [events.data]);
  // Monday-first grid.
  const lead = (new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay() + 6) % 7;
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const shift = (delta: number) => setYm(({ y, m }) => {
    const n = m + delta;
    return { y: y + Math.floor((n - 1) / 12), m: ((((n - 1) % 12) + 12) % 12) + 1 };
  });
  const upcoming = (events.data?.items ?? []).filter((e) => e.date >= today).slice(0, 30);

  return (
    <>
      <PageHeader
        title="Calendar"
        description={`Birthdays, anniversaries, scheduled campaigns and automation sends, in ${workspace.timezone}.`}
        actions={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="size-4" /></Button>
            <span className="min-w-36 text-center text-sm font-semibold">{monthName(ym.m)} {ym.y}</span>
            <Button variant="ghost" size="sm" onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="size-4" /></Button>
            <Button size="sm" onClick={() => setYm({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) })}>Today</Button>
          </div>
        }
      />
      {events.isError ? <ErrorState error={events.error} retry={() => events.refetch()} /> : null}
      <Card padded={false} className={clsx('hidden md:block', events.isFetching && 'opacity-70 transition-opacity')}>
        <div className="grid grid-cols-7 border-b border-line text-xs font-medium text-muted">
          {WEEKDAYS.map((d) => <div key={d} className="px-2 py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            const date = day ? iso(ym.y, ym.m, day) : null;
            const list = date ? (byDay.get(date) ?? []) : [];
            return (
              <div key={i} className={clsx('min-h-28 border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0', !day && 'bg-surface-2/50')}>
                {day ? (
                  <>
                    <p className={clsx('mb-1 flex size-6 items-center justify-center rounded-full text-xs', date === today ? 'bg-accent font-semibold text-accent-ink' : 'text-ink-2')}>{day}</p>
                    <div className="flex flex-col gap-0.5">
                      {list.slice(0, 3).map((e) => <EventChip key={e.id} e={e} />)}
                      {list.length > 3 ? <p className="px-1 text-[11px] text-muted">+{list.length - 3} more</p> : null}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="md:hidden">
        <ul className="flex flex-col divide-y divide-line">
          {(events.data?.items ?? []).map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5">
              <span className="w-12 shrink-0 text-xs text-muted">{e.date.slice(8)} {monthName(ym.m).slice(0, 3)}</span>
              <div className="min-w-0 flex-1"><EventChip e={e} /></div>
            </li>
          ))}
          {!events.data?.items.length ? <li className="py-8 text-center text-sm text-muted">Nothing this month.</li> : null}
        </ul>
      </Card>
      <div className="mt-4 flex flex-wrap gap-3 text-xs text-ink-2" aria-label="Legend">
        {Object.values(KIND).filter((k, i, a) => a.findIndex((x) => x.label === k.label) === i).map((k) => (
          <span key={k.label} className="flex items-center gap-1.5"><span className={clsx('flex items-center rounded px-1 py-0.5', k.className)}>{k.icon}</span>{k.label}</span>
        ))}
      </div>
      {upcoming.length ? <p className="sr-only">{upcoming.length} upcoming events this month.</p> : null}
    </>
  );
}

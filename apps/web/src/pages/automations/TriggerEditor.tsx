import { useQuery } from '@tanstack/react-query';
import { CONSENT_STATUSES, TRIGGER_LABELS, type Trigger, type TriggerType } from '@morrow/core';
import { Checkbox, Field, Input, Select } from '../../components/ui/field';
import { api } from '../../lib/api';

export function defaultTrigger(type: TriggerType): Trigger {
  switch (type) {
    case 'calendar': return { type, field: 'birthday', sendTime: '09:00', timezoneMode: 'workspace', leapDayPolicy: 'feb28', offsetDays: 0, catchUpDays: 1 };
    case 'contact_created': return { type };
    case 'contact_updated': return { type, fields: [] };
    case 'segment_entered': return { type, segmentId: '' };
    case 'consent_changed': return { type, to: ['granted'] };
    case 'tag_added': return { type, tag: '' };
    case 'event': return { type, name: 'project.completed' };
    case 'inactivity': return { type, days: 90, sendTime: '10:00' };
    case 'schedule': return { type, recurrence: { frequency: 'weekly', time: '09:00', daysOfWeek: [1] }, segmentId: null };
    case 'manual': return { type, segmentId: null };
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function TriggerEditor({ value, onChange, disabled }: { value: Trigger; onChange(t: Trigger): void; disabled?: boolean }) {
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.segments.list() });
  const fields = useQuery({ queryKey: ['fields'], queryFn: () => api.fields.list() });
  const segmentSelect = (segmentId: string | null | undefined, set: (id: string | null) => void, optional: boolean) => (
    <Field label={optional ? 'Audience (optional)' : 'Segment'}>
      {(id) => (
        <Select id={id} value={segmentId ?? ''} disabled={disabled} onChange={(e) => set(e.target.value || null)}>
          <option value="">{optional ? 'All active contacts' : 'Choose a segment'}</option>
          {segments.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-4">
      <Field label="Starts when">
        {(id) => (
          <Select id={id} value={value.type} disabled={disabled} onChange={(e) => onChange(defaultTrigger(e.target.value as TriggerType))}>
            {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
          </Select>
        )}
      </Field>

      {value.type === 'calendar' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            {(id) => (
              <Select id={id} value={value.field} disabled={disabled} onChange={(e) => onChange({ ...value, field: e.target.value })}>
                <option value="birthday">Birthday</option>
                <option value="work_anniversary">Work anniversary</option>
                {fields.data?.items.filter((f) => f.type === 'date').map((f) => <option key={f.id} value={`custom:${f.key}`}>{f.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Send at" hint="Local time">{(id) => <Input id={id} type="time" value={value.sendTime} disabled={disabled} onChange={(e) => onChange({ ...value, sendTime: e.target.value })} />}</Field>
          <Field label="Days before (−) or after (+)" hint="0 = on the day">
            {(id) => <Input id={id} type="number" min={-30} max={30} value={value.offsetDays} disabled={disabled} onChange={(e) => onChange({ ...value, offsetDays: Number(e.target.value) })} />}
          </Field>
          <Field label="Time zone" hint="Contact zones fall back to the workspace zone.">
            {(id) => (
              <Select id={id} value={value.timezoneMode} disabled={disabled} onChange={(e) => onChange({ ...value, timezoneMode: e.target.value as 'workspace' | 'contact' })}>
                <option value="workspace">Workspace time zone</option>
                <option value="contact">Each contact’s time zone</option>
              </Select>
            )}
          </Field>
          <Field label="29 February birthdays in other years">
            {(id) => (
              <Select id={id} value={value.leapDayPolicy} disabled={disabled} onChange={(e) => onChange({ ...value, leapDayPolicy: e.target.value as 'feb28' })}>
                <option value="feb28">Celebrate on 28 February</option>
                <option value="mar1">Celebrate on 1 March</option>
                <option value="skip">Only in leap years</option>
              </Select>
            )}
          </Field>
          <Field label="Catch up after downtime" hint="Days late Morrow may still send. Older ones are reported as missed.">
            {(id) => <Input id={id} type="number" min={0} max={7} value={value.catchUpDays} disabled={disabled} onChange={(e) => onChange({ ...value, catchUpDays: Number(e.target.value) })} />}
          </Field>
        </div>
      ) : null}

      {value.type === 'contact_updated' ? (
        <Field label="Only when these fields change" hint="Comma separated, e.g. company, job_title. Empty = any change.">
          {(id) => <Input id={id} value={value.fields.join(', ')} disabled={disabled} onChange={(e) => onChange({ ...value, fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}
        </Field>
      ) : null}
      {value.type === 'segment_entered' ? segmentSelect(value.segmentId, (id) => onChange({ ...value, segmentId: id ?? '' }), false) : null}
      {value.type === 'consent_changed' ? (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1.5 text-[13px] font-medium">Changes to</legend>
          {CONSENT_STATUSES.map((s) => (
            <Checkbox key={s} label={s} disabled={disabled} checked={value.to.includes(s)} onChange={(e) => onChange({ ...value, to: e.target.checked ? [...value.to, s] : value.to.filter((x) => x !== s) })} />
          ))}
        </fieldset>
      ) : null}
      {value.type === 'tag_added' ? <Field label="Tag">{(id) => <Input id={id} value={value.tag} disabled={disabled} onChange={(e) => onChange({ ...value, tag: e.target.value })} />}</Field> : null}
      {value.type === 'event' ? (
        <Field label="Event name" hint="Send it with the API, the SDK or `morrow events send`.">
          {(id) => <Input id={id} className="font-mono" value={value.name} disabled={disabled} onChange={(e) => onChange({ ...value, name: e.target.value })} />}
        </Field>
      ) : null}
      {value.type === 'inactivity' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Days without interaction">{(id) => <Input id={id} type="number" min={7} value={value.days} disabled={disabled} onChange={(e) => onChange({ ...value, days: Number(e.target.value) })} />}</Field>
          <Field label="Send at">{(id) => <Input id={id} type="time" value={value.sendTime} disabled={disabled} onChange={(e) => onChange({ ...value, sendTime: e.target.value })} />}</Field>
        </div>
      ) : null}
      {value.type === 'schedule' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repeats">
            {(id) => (
              <Select
                id={id}
                value={value.recurrence.frequency}
                disabled={disabled}
                onChange={(e) => {
                  const f = e.target.value;
                  const time = value.recurrence.time;
                  const recurrence =
                    f === 'once' ? { frequency: 'once' as const, date: new Date().toISOString().slice(0, 10), time } : f === 'daily' ? { frequency: 'daily' as const, time } : f === 'weekly' ? { frequency: 'weekly' as const, time, daysOfWeek: [1] } : { frequency: 'monthly' as const, time, dayOfMonth: 1 };
                  onChange({ ...value, recurrence });
                }}
              >
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </Select>
            )}
          </Field>
          <Field label="At">{(id) => <Input id={id} type="time" value={value.recurrence.time} disabled={disabled} onChange={(e) => onChange({ ...value, recurrence: { ...value.recurrence, time: e.target.value } })} />}</Field>
          {value.recurrence.frequency === 'once' ? (
            <Field label="Date">{(id) => <Input id={id} type="date" value={value.recurrence.frequency === 'once' ? value.recurrence.date : ''} disabled={disabled} onChange={(e) => onChange({ ...value, recurrence: { frequency: 'once', time: value.recurrence.time, date: e.target.value } })} />}</Field>
          ) : null}
          {value.recurrence.frequency === 'weekly' ? (
            <fieldset className="flex flex-wrap gap-3 sm:col-span-2">
              <legend className="mb-1.5 text-[13px] font-medium">On</legend>
              {WEEKDAYS.map((w, i) => {
                const r = value.recurrence as { frequency: 'weekly'; time: string; daysOfWeek: number[] };
                return <Checkbox key={w} label={w} disabled={disabled} checked={r.daysOfWeek.includes(i)} onChange={(e) => onChange({ ...value, recurrence: { ...r, daysOfWeek: e.target.checked ? [...r.daysOfWeek, i].sort() : r.daysOfWeek.filter((d) => d !== i) } })} />;
              })}
            </fieldset>
          ) : null}
          {value.recurrence.frequency === 'monthly' ? (
            <Field label="Day of month" hint="Shorter months use their last day.">
              {(id) => <Input id={id} type="number" min={1} max={31} value={(value.recurrence as { dayOfMonth: number }).dayOfMonth} disabled={disabled} onChange={(e) => onChange({ ...value, recurrence: { frequency: 'monthly', time: value.recurrence.time, dayOfMonth: Number(e.target.value) } })} />}
            </Field>
          ) : null}
          {segmentSelect(value.segmentId, (id) => onChange({ ...value, segmentId: id }), true)}
        </div>
      ) : null}
      {value.type === 'manual' ? segmentSelect(value.segmentId, (id) => onChange({ ...value, segmentId: id }), true) : null}
    </div>
  );
}

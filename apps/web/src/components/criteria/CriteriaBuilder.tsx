import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, Trash2 } from 'lucide-react';
import {
  CONSENT_STATUSES,
  DATE_FIELDS,
  DATE_OPS,
  MAX_CRITERIA_DEPTH,
  RELATIONSHIP_LABELS,
  RELATIONSHIP_TYPES,
  TEXT_FIELDS,
  TEXT_OPS,
  type CriteriaGroup,
  type Rule,
} from '@morrow/core';
import { api } from '../../lib/api';
import { monthName } from '../../lib/format';
import { Input, Select } from '../ui/field';

const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', email: 'E-mail', email_domain: 'E-mail domain', company: 'Company', job_title: 'Job title',
  relationship_type: 'Relationship', language: 'Language', timezone: 'Time zone', source: 'Source', consent_status: 'Consent',
  created_at: 'Added', updated_at: 'Updated', last_interaction_at: 'Last interaction', last_emailed_at: 'Last e-mailed', consent_updated_at: 'Consent changed', work_anniversary: 'Work anniversary',
};
const OP_LABELS: Record<string, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', ends_with: 'ends with', in: 'is any of', not_in: 'is none of',
  is_empty: 'is empty', is_not_empty: 'is not empty', before: 'is before', after: 'is after', on: 'is on', within_last_days: 'within the last … days', more_than_days_ago: 'more than … days ago',
  gt: '>', gte: '≥', lt: '<', lte: '≤', is_true: 'is yes', is_false: 'is no',
};
const KIND_LABELS: Record<Rule['kind'], string> = {
  field: 'Contact field', date: 'Date', tag: 'Tag', custom_field: 'Custom field', suppression: 'Suppression', segment: 'Another segment', engagement: 'E-mail engagement', birthday: 'Birthday', event: 'Custom event',
};

function defaultRule(kind: Rule['kind']): Rule {
  switch (kind) {
    case 'field': return { kind, field: 'relationship_type', op: 'eq', value: 'client' };
    case 'date': return { kind, field: 'last_interaction_at', op: 'more_than_days_ago', value: 90 };
    case 'tag': return { kind, op: 'has', tag: '' };
    case 'custom_field': return { kind, key: '', op: 'is_not_empty' } as Rule;
    case 'suppression': return { kind, op: 'is_not_suppressed' };
    case 'segment': return { kind, op: 'in', segmentId: '' };
    case 'engagement': return { kind, event: 'opened', op: 'did_not', withinDays: 90 };
    case 'birthday': return { kind, op: 'in_next_days', value: 30 };
    case 'event': return { kind, name: '', op: 'did', withinDays: 30 };
  }
}

const isGroup = (r: Rule | CriteriaGroup): r is CriteriaGroup => r.kind === 'group';

function RuleEditor({ rule, onChange }: { rule: Rule; onChange(r: Rule): void }) {
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api.tags.list(), enabled: rule.kind === 'tag' });
  const fields = useQuery({ queryKey: ['fields'], queryFn: () => api.fields.list(), enabled: rule.kind === 'custom_field' });
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.segments.list(), enabled: rule.kind === 'segment' });
  const sel = 'w-auto min-w-0';

  switch (rule.kind) {
    case 'field': {
      const noValue = rule.op === 'is_empty' || rule.op === 'is_not_empty';
      const multi = rule.op === 'in' || rule.op === 'not_in';
      const choices = rule.field === 'relationship_type' ? RELATIONSHIP_TYPES.map((t) => [t, RELATIONSHIP_LABELS[t]] as const) : rule.field === 'consent_status' ? CONSENT_STATUSES.map((s) => [s, s] as const) : null;
      const text = Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value ?? '');
      return (
        <>
          <Select className={sel} aria-label="Field" value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value as typeof rule.field })}>
            {TEXT_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </Select>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
            {TEXT_OPS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
          </Select>
          {noValue ? null : choices && !multi ? (
            <Select className={sel} aria-label="Value" value={String(rule.value ?? '')} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
              {choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          ) : (
            <Input className="w-48" aria-label="Value" placeholder={multi ? 'a, b, c' : 'value'} value={text} onChange={(e) => onChange({ ...rule, value: multi ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value })} />
          )}
        </>
      );
    }
    case 'date': {
      const relative = rule.op === 'within_last_days' || rule.op === 'more_than_days_ago';
      const noValue = rule.op === 'is_empty' || rule.op === 'is_not_empty';
      return (
        <>
          <Select className={sel} aria-label="Date field" value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value as typeof rule.field })}>
            {DATE_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </Select>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op, value: undefined })}>
            {DATE_OPS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
          </Select>
          {noValue ? null : relative ? (
            <Input className="w-24" type="number" min={0} aria-label="Days" value={Number(rule.value ?? 30)} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })} />
          ) : (
            <Input className="w-40" type="date" aria-label="Date" value={String(rule.value ?? '')} onChange={(e) => onChange({ ...rule, value: e.target.value })} />
          )}
        </>
      );
    }
    case 'tag':
      return (
        <>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'has' | 'not_has' })}>
            <option value="has">has tag</option>
            <option value="not_has">does not have tag</option>
          </Select>
          <Input className="w-44" list="criteria-tags" aria-label="Tag" placeholder="tag" value={rule.tag} onChange={(e) => onChange({ ...rule, tag: e.target.value })} />
          <datalist id="criteria-tags">{tags.data?.items.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        </>
      );
    case 'custom_field': {
      const noValue = ['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(rule.op);
      return (
        <>
          <Select className={sel} aria-label="Custom field" value={rule.key} onChange={(e) => onChange({ ...rule, key: e.target.value })}>
            <option value="">Choose a field</option>
            {fields.data?.items.map((f) => <option key={f.id} value={f.key}>{f.label}</option>)}
          </Select>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
            {['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'before', 'after', 'is_true', 'is_false', 'is_empty', 'is_not_empty'].map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
          </Select>
          {noValue ? null : <Input className="w-40" aria-label="Value" value={String(rule.value ?? '')} onChange={(e) => onChange({ ...rule, value: e.target.value })} />}
        </>
      );
    }
    case 'suppression':
      return (
        <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
          <option value="is_not_suppressed">is not suppressed</option>
          <option value="is_suppressed">is suppressed</option>
        </Select>
      );
    case 'segment':
      return (
        <>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'in' | 'not_in' })}>
            <option value="in">is in segment</option>
            <option value="not_in">is not in segment</option>
          </Select>
          <Select className={sel} aria-label="Segment" value={rule.segmentId} onChange={(e) => onChange({ ...rule, segmentId: e.target.value })}>
            <option value="">Choose a segment</option>
            {segments.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </>
      );
    case 'engagement':
      return (
        <>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'did' | 'did_not' })}>
            <option value="did">did</option>
            <option value="did_not">did not</option>
          </Select>
          <Select className={sel} aria-label="Engagement" value={rule.event} onChange={(e) => onChange({ ...rule, event: e.target.value as typeof rule.event })}>
            {['received', 'delivered', 'opened', 'clicked', 'bounced', 'replied'].map((v) => <option key={v} value={v}>{v === 'received' ? 'receive an e-mail' : v === 'replied' ? 'reply' : `${v.replace(/ed$/, '')}`}</option>)}
          </Select>
          <span className="text-sm text-muted">in the last</span>
          <Input className="w-20" type="number" min={1} aria-label="Days" value={rule.withinDays ?? 90} onChange={(e) => onChange({ ...rule, withinDays: Number(e.target.value) || undefined })} />
          <span className="text-sm text-muted">days</span>
        </>
      );
    case 'birthday':
      return (
        <>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op, value: e.target.value === 'in_month' ? 1 : e.target.value === 'in_next_days' ? 30 : undefined })}>
            <option value="is_set">is known</option>
            <option value="is_not_set">is missing</option>
            <option value="in_month">is in month</option>
            <option value="in_next_days">is in the next … days</option>
            <option value="year_known">includes the year</option>
          </Select>
          {rule.op === 'in_month' ? (
            <Select className={sel} aria-label="Month" value={rule.value ?? 1} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{monthName(i + 1)}</option>)}
            </Select>
          ) : rule.op === 'in_next_days' ? (
            <Input className="w-20" type="number" min={0} max={366} aria-label="Days" value={rule.value ?? 30} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })} />
          ) : null}
        </>
      );
    case 'event':
      return (
        <>
          <Select className={sel} aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'did' | 'did_not' })}>
            <option value="did">had event</option>
            <option value="did_not">did not have event</option>
          </Select>
          <Input className="w-44 font-mono text-xs" aria-label="Event name" placeholder="proposal.sent" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
          <span className="text-sm text-muted">in the last</span>
          <Input className="w-20" type="number" min={1} aria-label="Days" value={rule.withinDays ?? 30} onChange={(e) => onChange({ ...rule, withinDays: Number(e.target.value) || undefined })} />
          <span className="text-sm text-muted">days</span>
        </>
      );
  }
}

/** Visual editor for the segment criteria language (used by segments, entry conditions and branches). */
export function CriteriaBuilder({ value, onChange, depth = 0 }: { value: CriteriaGroup; onChange(v: CriteriaGroup): void; depth?: number }) {
  const update = (i: number, r: Rule | CriteriaGroup) => onChange({ ...value, rules: value.rules.map((x, j) => (j === i ? r : x)) });
  const remove = (i: number) => onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) });
  return (
    <div className={clsx('flex flex-col gap-2', depth > 0 && 'rounded-lg border border-line bg-surface-2/60 p-3')}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        Match
        <Select className="w-auto" aria-label="Match" value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'all' | 'any' })}>
          <option value="all">all</option>
          <option value="any">any</option>
        </Select>
        of these {depth === 0 ? 'conditions' : ''}
      </div>
      {value.rules.map((r, i) =>
        isGroup(r) ? (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <CriteriaBuilder value={r} onChange={(g) => update(i, g)} depth={depth + 1} />
            </div>
            <button type="button" onClick={() => remove(i)} className="mt-2 text-muted hover:text-bad" aria-label="Remove group">
              <Trash2 className="size-4" />
            </button>
          </div>
        ) : (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="w-28 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">{KIND_LABELS[r.kind]}</span>
            <RuleEditor rule={r} onChange={(nr) => update(i, nr)} />
            <button type="button" onClick={() => remove(i)} className="ml-auto text-muted hover:text-bad" aria-label="Remove condition">
              <Trash2 className="size-4" />
            </button>
          </div>
        ),
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-auto"
          aria-label="Add condition"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ ...value, rules: [...value.rules, defaultRule(e.target.value as Rule['kind'])] });
          }}
        >
          <option value="">+ Add condition…</option>
          {(Object.keys(KIND_LABELS) as Rule['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </Select>
        {depth < MAX_CRITERIA_DEPTH - 1 ? (
          <button type="button" className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline" onClick={() => onChange({ ...value, rules: [...value.rules, { kind: 'group', match: 'any', rules: [] }] })}>
            <Plus className="size-3.5" /> Add group
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Segment criteria: a small, typed rule language shared by segments,
 * automation entry conditions and automation branches. The engine compiles
 * it to SQL so segments are evaluated in the database, never in memory.
 */
import { z } from 'zod';
import { CONSENT_STATUSES } from './consent';
import { RELATIONSHIP_LABELS } from './contacts';
import { isValidLocalDate } from './time/tz';

export const TEXT_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'email_domain',
  'company',
  'job_title',
  'relationship_type',
  'language',
  'timezone',
  'source',
  'consent_status',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export const DATE_FIELDS = [
  'created_at',
  'updated_at',
  'last_interaction_at',
  'last_emailed_at',
  'consent_updated_at',
  'work_anniversary',
] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export const TEXT_OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_empty', 'is_not_empty'] as const;
export type TextOp = (typeof TEXT_OPS)[number];

export const DATE_OPS = ['before', 'after', 'on', 'within_last_days', 'more_than_days_ago', 'is_empty', 'is_not_empty'] as const;
export type DateOp = (typeof DATE_OPS)[number];

export const NUMBER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;

const textValue = z.union([z.string().max(500), z.array(z.string().max(200)).max(200)]).optional();

const textRule = z.object({
  kind: z.literal('field'),
  field: z.enum(TEXT_FIELDS),
  op: z.enum(TEXT_OPS),
  value: textValue,
});

const dateRule = z.object({
  kind: z.literal('date'),
  field: z.enum(DATE_FIELDS),
  op: z.enum(DATE_OPS),
  /** ISO date for before/after/on, a day count for the relative operators. */
  value: z.union([z.string().max(40), z.number().int().min(0).max(36500)]).optional(),
});

const tagRule = z.object({
  kind: z.literal('tag'),
  op: z.enum(['has', 'not_has']),
  tag: z.string().min(1).max(50),
});

const customFieldRule = z.object({
  kind: z.literal('custom_field'),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'before', 'after', 'is_true', 'is_false', 'is_empty', 'is_not_empty']),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
});

const suppressionRule = z.object({
  kind: z.literal('suppression'),
  op: z.enum(['is_suppressed', 'is_not_suppressed']),
});

const segmentRule = z.object({
  kind: z.literal('segment'),
  op: z.enum(['in', 'not_in']),
  segmentId: z.string().min(1).max(64),
});

const engagementRule = z.object({
  kind: z.literal('engagement'),
  event: z.enum(['received', 'delivered', 'opened', 'clicked', 'bounced', 'replied']),
  op: z.enum(['did', 'did_not']),
  withinDays: z.number().int().min(1).max(3650).optional(),
  campaignId: z.string().max(64).optional(),
});

const birthdayRule = z.object({
  kind: z.literal('birthday'),
  op: z.enum(['is_set', 'is_not_set', 'in_month', 'in_next_days', 'year_known']),
  value: z.number().int().min(0).max(366).optional(),
});

const eventRule = z.object({
  kind: z.literal('event'),
  name: z.string().min(1).max(100),
  op: z.enum(['did', 'did_not']),
  withinDays: z.number().int().min(1).max(3650).optional(),
});

export const ruleSchema = z.discriminatedUnion('kind', [
  textRule,
  dateRule,
  tagRule,
  customFieldRule,
  suppressionRule,
  segmentRule,
  engagementRule,
  birthdayRule,
  eventRule,
]);

export type Rule = z.infer<typeof ruleSchema>;

export interface CriteriaGroup {
  kind: 'group';
  match: 'all' | 'any';
  rules: Array<Rule | CriteriaGroup>;
}

export const criteriaGroupSchema: z.ZodType<CriteriaGroup> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    match: z.enum(['all', 'any']),
    rules: z.array(z.union([ruleSchema, criteriaGroupSchema])).max(50),
  }),
);

export const MAX_CRITERIA_DEPTH = 4;
export const MAX_CRITERIA_RULES = 60;

export function emptyCriteria(): CriteriaGroup {
  return { kind: 'group', match: 'all', rules: [] };
}

export interface CriteriaProblem {
  path: string;
  message: string;
}

/** Semantic checks beyond the schema (depth, size, value shapes). */
export function checkCriteria(group: CriteriaGroup): CriteriaProblem[] {
  const problems: CriteriaProblem[] = [];
  let count = 0;
  const visit = (g: CriteriaGroup, path: string, depth: number) => {
    if (depth > MAX_CRITERIA_DEPTH) problems.push({ path, message: `Groups can be nested at most ${MAX_CRITERIA_DEPTH} levels deep.` });
    g.rules.forEach((r, i) => {
      const p = `${path}.rules.${i}`;
      if (r.kind === 'group') return visit(r, p, depth + 1);
      count++;
      switch (r.kind) {
        case 'field': {
          const needsValue = !['is_empty', 'is_not_empty'].includes(r.op);
          const isList = r.op === 'in' || r.op === 'not_in';
          if (needsValue && (r.value === undefined || (typeof r.value === 'string' && r.value === '' && r.op !== 'eq' && r.op !== 'neq'))) {
            problems.push({ path: p, message: 'This rule needs a value.' });
          } else if (isList && !Array.isArray(r.value)) {
            problems.push({ path: p, message: 'Choose one or more values.' });
          } else if (!isList && Array.isArray(r.value)) {
            problems.push({ path: p, message: 'This operator takes a single value.' });
          }
          break;
        }
        case 'date':
          if (['before', 'after', 'on'].includes(r.op) && !(typeof r.value === 'string' && isValidLocalDate(r.value))) {
            problems.push({ path: p, message: 'Use a YYYY-MM-DD date.' });
          }
          if (['within_last_days', 'more_than_days_ago'].includes(r.op) && typeof r.value !== 'number') {
            problems.push({ path: p, message: 'Enter a number of days.' });
          }
          break;
        case 'custom_field':
          if (!['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(r.op) && r.value === undefined) {
            problems.push({ path: p, message: 'This rule needs a value.' });
          }
          break;
        case 'birthday':
          if ((r.op === 'in_month' && !(typeof r.value === 'number' && r.value >= 1 && r.value <= 12)) ||
              (r.op === 'in_next_days' && !(typeof r.value === 'number' && r.value >= 1))) {
            problems.push({ path: p, message: r.op === 'in_month' ? 'Choose a month.' : 'Enter a number of days.' });
          }
          break;
        default:
          break;
      }
    });
  };
  visit(group, 'criteria', 1);
  if (count > MAX_CRITERIA_RULES) problems.push({ path: 'criteria', message: `A segment can have at most ${MAX_CRITERIA_RULES} rules.` });
  return problems;
}

/** Segment IDs referenced (directly) by criteria. */
export function referencedSegments(group: CriteriaGroup): string[] {
  const out = new Set<string>();
  const visit = (g: CriteriaGroup) =>
    g.rules.forEach((r) => {
      if (r.kind === 'group') visit(r);
      else if (r.kind === 'segment') out.add(r.segmentId);
    });
  visit(group);
  return [...out];
}

export function referencedTags(group: CriteriaGroup): string[] {
  const out = new Set<string>();
  const visit = (g: CriteriaGroup) =>
    g.rules.forEach((r) => {
      if (r.kind === 'group') visit(r);
      else if (r.kind === 'tag') out.add(r.tag);
    });
  visit(group);
  return [...out];
}

const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'E-mail',
  email_domain: 'E-mail domain',
  company: 'Company',
  job_title: 'Job title',
  relationship_type: 'Relationship',
  language: 'Language',
  timezone: 'Time zone',
  source: 'Source',
  consent_status: 'Consent',
  created_at: 'Created',
  updated_at: 'Updated',
  last_interaction_at: 'Last interaction',
  last_emailed_at: 'Last e-mailed',
  consent_updated_at: 'Consent updated',
  work_anniversary: 'Work anniversary',
};

const OP_LABELS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  in: 'is any of',
  not_in: 'is none of',
  is_empty: 'is empty',
  is_not_empty: 'is set',
  before: 'is before',
  after: 'is after',
  on: 'is on',
  within_last_days: 'is within the last',
  more_than_days_ago: 'is more than',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_true: 'is yes',
  is_false: 'is no',
};

function fmt(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => `"${v}"`).join(', ');
  if (typeof value === 'string') return `"${value}"`;
  return String(value ?? '');
}

export function describeRule(rule: Rule, segmentNames: Record<string, string> = {}): string {
  switch (rule.kind) {
    case 'field': {
      const v = rule.field === 'relationship_type' && typeof rule.value === 'string'
        ? `"${RELATIONSHIP_LABELS[rule.value as keyof typeof RELATIONSHIP_LABELS] ?? rule.value}"`
        : fmt(rule.value);
      return `${FIELD_LABELS[rule.field]} ${OP_LABELS[rule.op]}${['is_empty', 'is_not_empty'].includes(rule.op) ? '' : ` ${v}`}`;
    }
    case 'date':
      if (rule.op === 'within_last_days') return `${FIELD_LABELS[rule.field]} within the last ${rule.value} days`;
      if (rule.op === 'more_than_days_ago') return `${FIELD_LABELS[rule.field]} more than ${rule.value} days ago`;
      return `${FIELD_LABELS[rule.field]} ${OP_LABELS[rule.op]}${rule.value !== undefined ? ` ${rule.value}` : ''}`;
    case 'tag':
      return rule.op === 'has' ? `Has tag "${rule.tag}"` : `Does not have tag "${rule.tag}"`;
    case 'custom_field':
      return `${rule.key} ${OP_LABELS[rule.op]}${rule.value !== undefined ? ` ${fmt(rule.value)}` : ''}`;
    case 'suppression':
      return rule.op === 'is_suppressed' ? 'Is suppressed' : 'Is not suppressed';
    case 'segment':
      return `${rule.op === 'in' ? 'In' : 'Not in'} segment "${segmentNames[rule.segmentId] ?? rule.segmentId}"`;
    case 'engagement': {
      const verb = rule.op === 'did' ? 'Has' : 'Has not';
      const past = { received: 'received', delivered: 'had delivered', opened: 'opened', clicked: 'clicked', bounced: 'bounced', replied: 'replied to' }[rule.event];
      return `${verb} ${past} an e-mail${rule.withinDays ? ` in the last ${rule.withinDays} days` : ''}${rule.campaignId ? ' from this campaign' : ''}`;
    }
    case 'birthday':
      switch (rule.op) {
        case 'is_set':
          return 'Birthday is known';
        case 'is_not_set':
          return 'Birthday is unknown';
        case 'year_known':
          return 'Birth year is known';
        case 'in_month':
          return `Birthday is in month ${rule.value}`;
        case 'in_next_days':
          return `Birthday is in the next ${rule.value} days`;
      }
      break;
    case 'event':
      return `${rule.op === 'did' ? 'Had' : 'Did not have'} event "${rule.name}"${rule.withinDays ? ` in the last ${rule.withinDays} days` : ''}`;
  }
  return '';
}

export function describeCriteria(group: CriteriaGroup, segmentNames: Record<string, string> = {}): string {
  if (group.rules.length === 0) return 'All active contacts';
  const parts = group.rules.map((r) => (r.kind === 'group' ? `(${describeCriteria(r, segmentNames)})` : describeRule(r, segmentNames)));
  return parts.join(group.match === 'all' ? ' and ' : ' or ');
}

export { CONSENT_STATUSES };

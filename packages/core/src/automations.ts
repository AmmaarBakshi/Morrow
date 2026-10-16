/**
 * Automation definitions: trigger → entry conditions → steps (with branches).
 *
 * Definitions are versioned and immutable once a run starts, so editing an
 * active automation never changes what in-flight runs execute. Steps are
 * compiled into a jump graph keyed by stable step IDs; a run's cursor is
 * simply the ID of the next step to execute.
 */
import { z } from 'zod';
import { CONSENT_STATUSES, MESSAGE_CATEGORIES } from './consent';
import { AUTOMATION_UPDATABLE_FIELDS } from './contacts';
import { criteriaGroupSchema, type CriteriaGroup } from './segments';
import { LEAP_DAY_POLICIES } from './time/calendar';
import { recurrenceSchema } from './time/recurrence';
import { isValidTimeOfDay } from './time/tz';

const timeOfDay = z.string().refine(isValidTimeOfDay, 'Use 24-hour HH:MM time.');
const stepId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Step IDs use letters, numbers, - and _.');

export const CALENDAR_FIELDS = ['birthday', 'work_anniversary'] as const;

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('calendar'),
    /** birthday, work_anniversary or a custom date field (`custom:<key>`). */
    field: z.union([z.enum(CALENDAR_FIELDS), z.string().regex(/^custom:[a-z][a-z0-9_]{0,47}$/)]),
    sendTime: timeOfDay.default('09:00'),
    /** Evaluate the date in the workspace zone or in each contact's own zone. */
    timezoneMode: z.enum(['workspace', 'contact']).default('workspace'),
    leapDayPolicy: z.enum(LEAP_DAY_POLICIES).default('feb28'),
    /** Negative = before the occasion (e.g. -1 sends the day before). */
    offsetDays: z.number().int().min(-30).max(30).default(0),
    /** How many days late Morrow may still act after downtime. */
    catchUpDays: z.number().int().min(0).max(7).default(1),
  }),
  z.object({ type: z.literal('contact_created') }),
  z.object({
    type: z.literal('contact_updated'),
    /** Only fire when one of these fields changed (empty = any field). */
    fields: z.array(z.string().max(60)).max(30).default([]),
  }),
  z.object({ type: z.literal('segment_entered'), segmentId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('consent_changed'),
    to: z.array(z.enum(CONSENT_STATUSES)).min(1).default(['granted']),
  }),
  z.object({ type: z.literal('tag_added'), tag: z.string().min(1).max(50) }),
  z.object({
    type: z.literal('event'),
    /** Custom event name sent through the API, e.g. `project.completed`. */
    name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/, 'Event names use letters, numbers and . _ : -'),
  }),
  z.object({
    type: z.literal('inactivity'),
    days: z.number().int().min(7).max(3650),
    sendTime: timeOfDay.default('10:00'),
  }),
  z.object({
    type: z.literal('schedule'),
    recurrence: recurrenceSchema,
    /** Audience for each occurrence; all active contacts when omitted. */
    segmentId: z.string().max(64).nullish(),
  }),
  z.object({ type: z.literal('manual'), segmentId: z.string().max(64).nullish() }),
]);

export type Trigger = z.infer<typeof triggerSchema>;
export type TriggerType = Trigger['type'];

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  calendar: 'Calendar date (birthday, anniversary)',
  contact_created: 'Contact is created',
  contact_updated: 'Contact is updated',
  segment_entered: 'Contact enters a segment',
  consent_changed: 'Consent status changes',
  tag_added: 'Tag is added',
  event: 'Custom event (project, proposal, …)',
  inactivity: 'No interaction for a period',
  schedule: 'Recurring or one-off schedule',
  manual: 'Run manually',
};

export interface SendEmailStep {
  id: string;
  type: 'send_email';
  templateId: string;
  category?: (typeof MESSAGE_CATEGORIES)[number];
  senderId?: string | null;
  subjectOverride?: string | null;
}
export interface WaitStep {
  id: string;
  type: 'wait';
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
}
export interface TagStep {
  id: string;
  type: 'add_tag' | 'remove_tag';
  tag: string;
}
export interface UpdateFieldStep {
  id: string;
  type: 'update_field';
  field: string;
  value: string | number | boolean | null;
}
export interface CreateTaskStep {
  id: string;
  type: 'create_task';
  title: string;
  description?: string | null;
  dueInDays: number;
  assigneeUserId?: string | null;
}
export interface NotifyStep {
  id: string;
  type: 'notify';
  title: string;
  body?: string | null;
  /** Also e-mail workspace admins (transactional, internal). */
  email?: boolean;
}
export interface BranchStep {
  id: string;
  type: 'branch';
  condition: CriteriaGroup;
  then: Step[];
  else: Step[];
}
export interface EndStep {
  id: string;
  type: 'end';
}

export type Step = SendEmailStep | WaitStep | TagStep | UpdateFieldStep | CreateTaskStep | NotifyStep | BranchStep | EndStep;
export type StepType = Step['type'];

export const STEP_LABELS: Record<StepType, string> = {
  send_email: 'Send e-mail',
  wait: 'Wait',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  update_field: 'Update field',
  create_task: 'Create follow-up task',
  notify: 'Notify team',
  branch: 'Branch (if / else)',
  end: 'End',
};

const updatableField = z.union([z.enum(AUTOMATION_UPDATABLE_FIELDS), z.string().regex(/^custom:[a-z][a-z0-9_]{0,47}$/)]);

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      id: stepId,
      type: z.literal('send_email'),
      templateId: z.string().min(1).max(64),
      category: z.enum(MESSAGE_CATEGORIES).optional(),
      senderId: z.string().max(64).nullish(),
      subjectOverride: z.string().max(300).nullish(),
    }),
    z.object({
      id: stepId,
      type: z.literal('wait'),
      amount: z.number().int().min(1).max(10000),
      unit: z.enum(['minutes', 'hours', 'days']),
    }),
    z.object({ id: stepId, type: z.literal('add_tag'), tag: z.string().min(1).max(50) }),
    z.object({ id: stepId, type: z.literal('remove_tag'), tag: z.string().min(1).max(50) }),
    z.object({
      id: stepId,
      type: z.literal('update_field'),
      field: updatableField,
      value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    }),
    z.object({
      id: stepId,
      type: z.literal('create_task'),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).nullish(),
      dueInDays: z.number().int().min(0).max(365),
      assigneeUserId: z.string().max(64).nullish(),
    }),
    z.object({
      id: stepId,
      type: z.literal('notify'),
      title: z.string().min(1).max(200),
      body: z.string().max(2000).nullish(),
      email: z.boolean().optional(),
    }),
    z.object({
      id: stepId,
      type: z.literal('branch'),
      condition: criteriaGroupSchema,
      then: z.array(stepSchema).max(50),
      else: z.array(stepSchema).max(50),
    }),
    z.object({ id: stepId, type: z.literal('end') }),
  ]) as unknown as z.ZodType<Step>,
);

export const automationSettingsSchema = z.object({
  /** Do not start another run for a contact within this many days. 0 = no cooldown. */
  cooldownDays: z.number().int().min(0).max(3650).default(0),
  /** Allow the same contact to enter again for a new event (birthdays every year). */
  allowReentry: z.boolean().default(true),
  /** Maximum lifetime runs per contact. 0 = unlimited. */
  maxRunsPerContact: z.number().int().min(0).max(1000).default(0),
});

export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

export const automationDefinitionSchema = z.object({
  trigger: triggerSchema,
  conditions: criteriaGroupSchema.nullish(),
  settings: automationSettingsSchema.default({ cooldownDays: 0, allowReentry: true, maxRunsPerContact: 0 }),
  steps: z.array(stepSchema).min(1, 'Add at least one step.').max(50),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationDefinitionInput = z.input<typeof automationDefinitionSchema>;

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompiledNode {
  step: Step;
  /** Step to run after this one (for branches: after either side finishes). */
  next: string | null;
  thenEntry?: string | null;
  elseEntry?: string | null;
  depth: number;
}

export interface CompiledAutomation {
  entry: string | null;
  nodes: Record<string, CompiledNode>;
  order: string[];
}

export const MAX_STEPS = 100;
export const MAX_BRANCH_DEPTH = 5;

export function compileSteps(steps: Step[]): CompiledAutomation {
  const nodes: Record<string, CompiledNode> = {};
  const order: string[] = [];
  const build = (list: Step[], continuation: string | null, depth: number): string | null => {
    for (let i = 0; i < list.length; i++) {
      const step = list[i]!;
      if (nodes[step.id]) throw new Error(`Duplicate step id "${step.id}"`);
      nodes[step.id] = { step, next: null, depth };
      order.push(step.id);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const step = list[i]!;
      const next = step.type === 'end' ? null : (list[i + 1]?.id ?? continuation);
      const node = nodes[step.id]!;
      node.next = next;
      if (step.type === 'branch') {
        if (depth >= MAX_BRANCH_DEPTH) throw new Error(`Branches can be nested at most ${MAX_BRANCH_DEPTH} levels deep`);
        node.thenEntry = build(step.then, next, depth + 1);
        node.elseEntry = build(step.else, next, depth + 1);
      }
    }
    return list[0]?.id ?? continuation;
  };
  const entry = build(steps, null, 0);
  if (order.length > MAX_STEPS) throw new Error(`Automations can have at most ${MAX_STEPS} steps`);
  return { entry, nodes, order };
}

export interface DefinitionProblem {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export function checkDefinition(def: AutomationDefinition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  try {
    compileSteps(def.steps);
  } catch (err) {
    problems.push({ path: 'steps', message: (err as Error).message, severity: 'error' });
    return problems;
  }
  const walk = (list: Step[], path: string) => {
    list.forEach((step, i) => {
      const p = `${path}.${i}`;
      if (step.type === 'end' && i < list.length - 1) {
        problems.push({ path: p, message: 'Steps after "End" will never run.', severity: 'warning' });
      }
      if (step.type === 'branch') {
        if (step.then.length === 0 && step.else.length === 0) {
          problems.push({ path: p, message: 'This branch has no steps on either side.', severity: 'warning' });
        }
        walk(step.then, `${p}.then`);
        walk(step.else, `${p}.else`);
      }
    });
  };
  walk(def.steps, 'steps');
  if (!collectSteps(def.steps).some((s) => s.type === 'send_email' || s.type === 'create_task' || s.type === 'notify')) {
    problems.push({ path: 'steps', message: 'This automation does not send e-mail or create tasks.', severity: 'warning' });
  }
  if (def.trigger.type === 'calendar' && def.trigger.offsetDays > 0) {
    problems.push({ path: 'trigger.offsetDays', message: 'Positive offsets send after the occasion.', severity: 'warning' });
  }
  return problems;
}

export function collectSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  const visit = (list: Step[]) =>
    list.forEach((s) => {
      out.push(s);
      if (s.type === 'branch') {
        visit(s.then);
        visit(s.else);
      }
    });
  visit(steps);
  return out;
}

export function referencedTemplates(def: Pick<AutomationDefinition, 'steps'>): string[] {
  return [...new Set(collectSteps(def.steps).filter((s): s is SendEmailStep => s.type === 'send_email').map((s) => s.templateId))];
}

export function waitDurationMs(step: WaitStep): number {
  const unit = step.unit === 'minutes' ? 60_000 : step.unit === 'hours' ? 3_600_000 : 86_400_000;
  return step.amount * unit;
}

/** Stable, human-readable event key used for run de-duplication. */
export function calendarEventKey(field: string, occasionDate: string): string {
  return `${field}:${occasionDate}`;
}

export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'calendar': {
      const what = t.field === 'birthday' ? 'birthday' : t.field === 'work_anniversary' ? 'work anniversary' : t.field.slice(7);
      const when =
        t.offsetDays === 0 ? `On the contact's ${what}` : t.offsetDays < 0 ? `${-t.offsetDays} day(s) before the contact's ${what}` : `${t.offsetDays} day(s) after the contact's ${what}`;
      return `${when} at ${t.sendTime} (${t.timezoneMode === 'contact' ? "contact's time zone" : 'workspace time zone'})`;
    }
    case 'contact_created':
      return 'When a contact is created';
    case 'contact_updated':
      return t.fields.length ? `When ${t.fields.join(', ')} changes` : 'When a contact is updated';
    case 'segment_entered':
      return 'When a contact enters a segment';
    case 'consent_changed':
      return `When consent changes to ${t.to.join(' or ')}`;
    case 'tag_added':
      return `When tag "${t.tag}" is added`;
    case 'event':
      return `When event "${t.name}" is received`;
    case 'inactivity':
      return `When a contact has had no interaction for ${t.days} days`;
    case 'schedule':
      return 'On a schedule';
    case 'manual':
      return 'When started manually';
  }
}

/** Template definitions to start from in the builder. */
export function blankDefinition(): AutomationDefinitionInput {
  return {
    trigger: { type: 'manual' },
    conditions: null,
    settings: { cooldownDays: 0, allowReentry: true, maxRunsPerContact: 0 },
    steps: [],
  };
}

export function newStepId(prefix = 'step'): string {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `${prefix}_${rand}`;
}

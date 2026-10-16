import { describe, expect, it } from 'vitest';
import {
  automationDefinitionSchema,
  checkDefinition,
  compileSteps,
  describeTrigger,
  referencedTemplates,
  type Step,
} from '../src/automations';
import { checkCriteria, criteriaGroupSchema, describeCriteria, referencedSegments, type CriteriaGroup } from '../src/segments';
import { contactCreateSchema, contactUpdateSchema } from '../src/contacts';
import { parseWorkspaceSettings } from '../src/settings';
import { computeRates, emptyCounts, rate } from '../src/analytics';

describe('segment criteria', () => {
  const criteria: CriteriaGroup = {
    kind: 'group',
    match: 'all',
    rules: [
      { kind: 'field', field: 'relationship_type', op: 'in', value: ['client', 'partner'] },
      { kind: 'tag', op: 'has', tag: 'vip' },
      {
        kind: 'group',
        match: 'any',
        rules: [
          { kind: 'engagement', event: 'opened', op: 'did', withinDays: 90 },
          { kind: 'segment', op: 'in', segmentId: 'seg_1' },
        ],
      },
    ],
  };

  it('validates and describes nested criteria', () => {
    expect(criteriaGroupSchema.safeParse(criteria).success).toBe(true);
    expect(checkCriteria(criteria)).toEqual([]);
    expect(referencedSegments(criteria)).toEqual(['seg_1']);
    expect(describeCriteria(criteria, { seg_1: 'Engaged' })).toBe(
      'Relationship is any of "client", "partner" and Has tag "vip" and (Has opened an e-mail in the last 90 days or In segment "Engaged")',
    );
  });

  it('rejects unknown fields and operators', () => {
    expect(criteriaGroupSchema.safeParse({ kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'password', op: 'eq', value: 'x' }] }).success).toBe(false);
    expect(criteriaGroupSchema.safeParse({ kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'email', op: 'regex', value: 'x' }] }).success).toBe(false);
  });

  it('reports semantic problems', () => {
    const problems = checkCriteria({
      kind: 'group',
      match: 'all',
      rules: [
        { kind: 'field', field: 'company', op: 'in', value: 'Acme' },
        { kind: 'date', field: 'created_at', op: 'before', value: 'yesterday' },
        { kind: 'birthday', op: 'in_month', value: 13 },
      ],
    });
    expect(problems.map((p) => p.message)).toEqual(['Choose one or more values.', 'Use a YYYY-MM-DD date.', 'Choose a month.']);
  });

  it('limits nesting depth', () => {
    let g: CriteriaGroup = { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'x' }] };
    for (let i = 0; i < 5; i++) g = { kind: 'group', match: 'all', rules: [g] };
    expect(checkCriteria(g).some((p) => p.message.includes('nested'))).toBe(true);
  });
});

describe('automation definitions', () => {
  const steps: Step[] = [
    { id: 'send', type: 'send_email', templateId: 'tpl_birthday' },
    {
      id: 'check',
      type: 'branch',
      condition: { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'relationship_type', op: 'eq', value: 'client' }] },
      then: [
        { id: 'wait', type: 'wait', amount: 2, unit: 'days' },
        { id: 'task', type: 'create_task', title: 'Call {{first_name}}', dueInDays: 1 },
      ],
      else: [{ id: 'tag', type: 'add_tag', tag: 'birthday-greeted' }],
    },
    { id: 'notify', type: 'notify', title: 'Birthday handled' },
  ];

  it('applies defaults to triggers and settings', () => {
    const def = automationDefinitionSchema.parse({ trigger: { type: 'calendar', field: 'birthday' }, steps });
    expect(def.trigger).toEqual({
      type: 'calendar',
      field: 'birthday',
      sendTime: '09:00',
      timezoneMode: 'workspace',
      leapDayPolicy: 'feb28',
      offsetDays: 0,
      catchUpDays: 1,
    });
    expect(def.settings).toEqual({ cooldownDays: 0, allowReentry: true, maxRunsPerContact: 0 });
    expect(describeTrigger(def.trigger)).toBe("On the contact's birthday at 09:00 (workspace time zone)");
  });

  it('compiles branches into a jump graph that rejoins after the branch', () => {
    const c = compileSteps(steps);
    expect(c.entry).toBe('send');
    expect(c.nodes.send!.next).toBe('check');
    expect(c.nodes.check!.thenEntry).toBe('wait');
    expect(c.nodes.check!.elseEntry).toBe('tag');
    expect(c.nodes.wait!.next).toBe('task');
    expect(c.nodes.task!.next).toBe('notify');
    expect(c.nodes.tag!.next).toBe('notify');
    expect(c.nodes.notify!.next).toBeNull();
    expect(c.order).toHaveLength(6);
  });

  it('treats end as terminal and empty branch sides as pass-through', () => {
    const c = compileSteps([
      { id: 'b', type: 'branch', condition: { kind: 'group', match: 'all', rules: [] }, then: [{ id: 'stop', type: 'end' }], else: [] },
      { id: 'after', type: 'add_tag', tag: 'x' },
    ]);
    expect(c.nodes.stop!.next).toBeNull();
    expect(c.nodes.b!.elseEntry).toBe('after');
  });

  it('rejects duplicate step IDs', () => {
    expect(() => compileSteps([{ id: 'a', type: 'end' }, { id: 'a', type: 'end' }])).toThrow(/Duplicate/);
  });

  it('warns about unreachable steps and lists referenced templates', () => {
    const def = automationDefinitionSchema.parse({
      trigger: { type: 'manual' },
      steps: [
        { id: 'e', type: 'end' },
        { id: 's', type: 'send_email', templateId: 'tpl_x' },
      ],
    });
    expect(checkDefinition(def).map((p) => p.message)).toContain('Steps after "End" will never run.');
    expect(referencedTemplates(def)).toEqual(['tpl_x']);
  });

  it('refuses to let automations update consent', () => {
    const r = automationDefinitionSchema.safeParse({
      trigger: { type: 'manual' },
      steps: [{ id: 'u', type: 'update_field', field: 'consent_status', value: 'granted' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('contact schemas', () => {
  it('applies defaults and validates birthdays without a year', () => {
    const c = contactCreateSchema.parse({ email: 'rahul@example.com', firstName: ' Rahul ', birthday: { month: 3, day: 7 } });
    expect(c.firstName).toBe('Rahul');
    expect(c.relationshipType).toBe('subscriber');
    expect(c.consentStatus).toBe('unknown');
    expect(c.birthday).toEqual({ month: 3, day: 7 });
  });

  it('rejects impossible birthdays', () => {
    expect(contactCreateSchema.safeParse({ email: 'a@b.co', birthday: { month: 2, day: 30 } }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ email: 'a@b.co', birthday: { month: 2, day: 29, year: 1997 } }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ email: 'a@b.co', birthday: { month: 2, day: 29 } }).success).toBe(true);
  });

  it('requires an e-mail address or a name', () => {
    expect(contactCreateSchema.safeParse({}).success).toBe(false);
    expect(contactCreateSchema.safeParse({ firstName: 'Rahul' }).success).toBe(true);
  });

  it('validates time zones and allows partial updates', () => {
    expect(contactUpdateSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(contactUpdateSchema.parse({ company: 'Cyphen' })).toEqual({ company: 'Cyphen' });
  });
});

describe('workspace settings', () => {
  it('fills defaults and survives corrupt data', () => {
    const s = parseWorkspaceSettings({ companyName: 'Cyphen' });
    expect(s.companyName).toBe('Cyphen');
    expect(s.fallbackFirstName).toBe('there');
    expect(s.sending.weeklyCapPerContact).toBe(4);
    expect(parseWorkspaceSettings({ brandColor: 'red' }).brandColor).toBe('#4f46e5');
    expect(parseWorkspaceSettings(null).consent.allowImpliedForMarketing).toBe(false);
  });
});

describe('analytics rates', () => {
  it('returns null instead of fabricating rates', () => {
    expect(rate(1, 0)).toBeNull();
    const counts = { ...emptyCounts(), sent: 100, delivered: 95, bounced: 5, opened: 40, clicked: 10 };
    const withEvents = computeRates(counts, { deliveryEvents: true, openTracking: true, clickTracking: true });
    expect(withEvents.deliveryRate).toBeCloseTo(0.95);
    expect(withEvents.openRate).toBeCloseTo(40 / 95);
    expect(withEvents.clickToOpenRate).toBeCloseTo(0.25);
    const smtp = computeRates(counts, { deliveryEvents: false, openTracking: false, clickTracking: true });
    expect(smtp.deliveryRate).toBeNull();
    expect(smtp.openRate).toBeNull();
    expect(smtp.clickRate).toBeCloseTo(0.1);
  });
});

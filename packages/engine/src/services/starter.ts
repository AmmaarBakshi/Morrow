import { newId, type AutomationDefinitionInput, type MessageCategory, type TemplatePurpose } from '@morrow/core';
import { actorUserId, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Responsive, table-based layout that renders well in Gmail, Outlook and Apple Mail. */
export function emailLayout(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{{company_name}}</title>
<style>
  body { margin: 0; padding: 0; background: #f4f4f5; }
  a { color: {{brand_color}}; }
  @media (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;">
{{> header}}
<tr><td class="px" style="padding:8px 40px 32px 40px;font-family:${FONT};font-size:16px;line-height:1.65;color:#1f2937;">
${body.trim()}
{{> signature}}
</td></tr>
</table>
{{> footer}}
</td></tr>
</table>
</body>
</html>
`;
}

export function button(href: string, label: string): string {
  return `<p style="margin:28px 0;"><a href="${href}" style="display:inline-block;background:{{brand_color}};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">${label}</a></p>`;
}

export const STARTER_SNIPPETS = [
  {
    key: 'header',
    name: 'Header',
    kind: 'header' as const,
    html: `<tr><td class="px" style="padding:32px 40px 8px 40px;font-family:${FONT};">{{#if logo_url}}<img src="{{logo_url}}" alt="{{company_name}}" height="32" style="height:32px;border:0;display:block;">{{else}}<span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:{{brand_color}};">{{company_name}}</span>{{/if}}</td></tr>`,
    text: '',
  },
  {
    key: 'signature',
    name: 'Signature',
    kind: 'signature' as const,
    html: `<p style="margin:28px 0 0 0;">Warm regards,<br><strong>{{sender_name | default: "The team"}}</strong><br><span style="color:#6b7280;">{{company_name}}</span></p>`,
    text: 'Warm regards,\n{{sender_name | default: "The team"}}\n{{company_name}}',
  },
  {
    key: 'footer',
    name: 'Footer',
    kind: 'footer' as const,
    html: `<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tr><td class="px" style="padding:20px 40px;font-family:${FONT};font-size:12px;line-height:1.6;color:#71717a;text-align:center;">{{company_name}}{{#if company_address}} &middot; {{company_address}}{{/if}}{{#if unsubscribe_url}}<br>You're receiving this because of your relationship with {{company_name}}. <a href="{{unsubscribe_url}}" style="color:#71717a;">Unsubscribe</a>{{/if}}</td></tr></table>`,
    text: '--\n{{company_name}}{{#if company_address}} · {{company_address}}{{/if}}{{#if unsubscribe_url}}\nUnsubscribe: {{unsubscribe_url}}{{/if}}',
  },
];

interface StarterTemplate {
  key: string;
  name: string;
  description: string;
  category: MessageCategory;
  purpose: TemplatePurpose;
  subject: string;
  previewText: string;
  body: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: 'birthday_personal',
    name: 'Birthday — personal',
    description: 'A warm, purely personal birthday greeting with no promotion.',
    category: 'relationship',
    purpose: 'birthday',
    subject: 'Happy birthday, {{first_name}}! 🎉',
    previewText: 'Wishing you a wonderful year ahead.',
    body: `<p>Hi {{first_name}},</p>
<p>Happy birthday from all of us at {{company_name}}! We hope today brings good food, good company and a little time away from the keyboard.</p>
<p>Thank you for being part of our story. Here's to a brilliant year ahead.</p>`,
  },
  {
    key: 'birthday_business',
    name: 'Birthday — client',
    description: 'A birthday greeting for clients that acknowledges the working relationship.',
    category: 'relationship',
    purpose: 'birthday',
    subject: 'Happy birthday from {{company_name}}',
    previewText: 'A quick note to celebrate you today.',
    body: `<p>Hi {{first_name}},</p>
<p>Wishing you a very happy birthday! It has been a real pleasure working with you{{#if company}} and the team at {{company}}{{/if}}.</p>
<p>We hope you get to celebrate properly today.</p>`,
  },
  {
    key: 'birthday_collaboration',
    name: 'Birthday — with collaboration note',
    description: 'Birthday wishes with a light mention of recent work. Treated as marketing, so consent rules apply.',
    category: 'marketing',
    purpose: 'birthday',
    subject: 'Happy birthday, {{first_name}} 🎂',
    previewText: 'Celebrating you — and a small note from the team.',
    body: `<p>Hi {{first_name}},</p>
<p>Happy birthday from everyone at {{company_name}}! We hope the year ahead is full of good things.</p>
{{#if latest_project_name}}<p>We have been busy too — we recently shipped {{#if latest_project_url}}<a href="{{latest_project_url}}">{{latest_project_name}}</a>{{else}}{{latest_project_name}}{{/if}}. If you are planning something new this year, we would love to hear about it.</p>{{/if}}
{{#if collaboration_url}}${button('{{collaboration_url}}', 'Start a conversation')}{{/if}}`,
  },
  {
    key: 'welcome',
    name: 'Welcome',
    description: 'Sent when someone subscribes or becomes a new contact.',
    category: 'relationship',
    purpose: 'welcome',
    subject: 'Welcome to {{company_name}}, {{first_name}}',
    previewText: "Here's what to expect from us.",
    body: `<p>Hi {{first_name}},</p>
<p>Thanks for connecting with {{company_name}}. We build software with care, and we only send e-mail when we have something genuinely useful to share.</p>
<p>Expect the occasional update on what we are working on, lessons from recent projects, and the odd invitation to collaborate.</p>
{{#if website_url}}${button('{{website_url}}', 'See what we do')}{{/if}}`,
  },
  {
    key: 'proposal_follow_up',
    name: 'Proposal follow-up',
    description: 'A gentle follow-up when a proposal has not received a response.',
    category: 'relationship',
    purpose: 'follow_up',
    subject: 'Following up on {{event.proposal_name | default: "our proposal"}}',
    previewText: 'Happy to answer any questions.',
    body: `<p>Hi {{first_name}},</p>
<p>I wanted to follow up on {{event.proposal_name | default: "the proposal we sent over"}}. Have you had a chance to look through it?</p>
<p>If anything is unclear, or the scope needs adjusting, just reply to this e-mail — I am happy to set up a short call.</p>`,
  },
  {
    key: 'newsletter',
    name: 'Newsletter',
    description: 'A simple, readable newsletter layout for opted-in subscribers.',
    category: 'marketing',
    purpose: 'newsletter',
    subject: "What's new at {{company_name}}",
    previewText: 'Projects, lessons and a few things worth reading.',
    body: `<p>Hi {{first_name}},</p>
<h2 style="font-size:20px;margin:24px 0 8px 0;">What we shipped</h2>
<p>Write a short summary of recent work here.</p>
<h2 style="font-size:20px;margin:24px 0 8px 0;">What we learned</h2>
<p>Share one practical lesson your readers can use.</p>
<h2 style="font-size:20px;margin:24px 0 8px 0;">Worth reading</h2>
<p>Link to two or three things you found useful.</p>`,
  },
  {
    key: 'project_announcement',
    name: 'Project announcement',
    description: 'Announce a newly launched app, website or product.',
    category: 'marketing',
    purpose: 'announcement',
    subject: 'Introducing {{latest_project_name | default: "our latest project"}}',
    previewText: 'Something new we think you will like.',
    body: `<p>Hi {{first_name}},</p>
<p>We have just launched <strong>{{latest_project_name | default: "something new"}}</strong>, and we wanted you to be among the first to know.</p>
<p>Tell readers what it does, who it is for, and why it matters.</p>
{{#if latest_project_url}}${button('{{latest_project_url}}', 'Take a look')}{{/if}}`,
  },
  {
    key: 'project_feedback',
    name: 'Project completed — feedback',
    description: 'Thank a client when a project ships and ask how it went.',
    category: 'relationship',
    purpose: 'feedback',
    subject: '{{event.project_name | default: "Your project"}} is live — how did we do?',
    previewText: 'Two minutes of feedback helps us a lot.',
    body: `<p>Hi {{first_name}},</p>
<p>Thank you for trusting us with {{event.project_name | default: "your project"}}. It was a pleasure to build it with you.</p>
<p>Would you share how the project went for you? What worked well, and what should we do better next time? Simply reply to this e-mail.</p>
{{#if event.feedback_url}}${button('{{event.feedback_url}}', 'Share feedback')}{{/if}}`,
  },
  {
    key: 'collaboration_invite',
    name: 'Collaboration invitation',
    description: 'Invite developers, partners or collaborators to work together.',
    category: 'marketing',
    purpose: 'collaboration',
    subject: '{{first_name}}, want to build something together?',
    previewText: 'We are looking for people to collaborate with.',
    body: `<p>Hi {{first_name}},</p>
<p>We are taking on new work at {{company_name}} and would love to collaborate with people we already know and trust{{#if job_title}} — especially experienced {{job_title}}s{{/if}}.</p>
<p>If you are open to a conversation, pick a time that works for you.</p>
{{#if collaboration_url}}${button('{{collaboration_url}}', "Let's talk")}{{/if}}`,
  },
  {
    key: 'work_anniversary',
    name: 'Work anniversary',
    description: 'Celebrate the anniversary of working together.',
    category: 'relationship',
    purpose: 'work_anniversary',
    subject: '{{years | ordinal}} anniversary — thank you, {{first_name}}',
    previewText: 'Celebrating another year of working together.',
    body: `<p>Hi {{first_name}},</p>
<p>It has been {{years}} {{#if years == 1}}year{{else}}years{{/if}} since we started working together{{#if company}} with {{company}}{{/if}}. Thank you for your trust along the way.</p>
<p>Here's to the next chapter.</p>`,
  },
  {
    key: 're_engagement',
    name: 'Re-engagement',
    description: 'Reconnect with contacts you have not heard from in a while.',
    category: 'marketing',
    purpose: 're_engagement',
    subject: "It's been a while, {{first_name}}",
    previewText: 'A quick hello from us.',
    body: `<p>Hi {{first_name}},</p>
<p>We have not been in touch for a while, so we wanted to say hello and share what we have been up to at {{company_name}}.</p>
<p>If you would rather not hear from us, no hard feelings — the unsubscribe link is below.</p>
{{#if website_url}}${button('{{website_url}}', 'See our latest work')}{{/if}}`,
  },
];

export function starterAutomations(templateIds: Record<string, string>): Array<{ name: string; description: string; definition: AutomationDefinitionInput }> {
  return [
    {
      name: 'Birthday greetings',
      description: 'Send a personal birthday greeting at 9:00 in the workspace time zone, and remind the team to reach out to clients personally.',
      definition: {
        trigger: { type: 'calendar', field: 'birthday', sendTime: '09:00', timezoneMode: 'workspace', leapDayPolicy: 'feb28', offsetDays: 0, catchUpDays: 1 },
        conditions: null,
        settings: { cooldownDays: 300, allowReentry: true, maxRunsPerContact: 0 },
        steps: [
          { id: 'send_greeting', type: 'send_email', templateId: templateIds.birthday_personal! },
          {
            id: 'is_client',
            type: 'branch',
            condition: { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'relationship_type', op: 'eq', value: 'client' }] },
            then: [{ id: 'personal_note', type: 'create_task', title: 'Send {{first_name}} a personal birthday message', dueInDays: 0 }],
            else: [],
          },
        ],
      },
    },
    {
      name: 'Welcome new subscribers',
      description: 'Welcome contacts the moment they opt in.',
      definition: {
        trigger: { type: 'consent_changed', to: ['granted'] },
        conditions: null,
        settings: { cooldownDays: 0, allowReentry: false, maxRunsPerContact: 1 },
        steps: [{ id: 'send_welcome', type: 'send_email', templateId: templateIds.welcome! }],
      },
    },
    {
      name: 'Proposal follow-up',
      description: 'When a proposal is sent (event "proposal.sent"), wait five days; if there is no response, follow up and create a call task.',
      definition: {
        trigger: { type: 'event', name: 'proposal.sent' },
        conditions: null,
        settings: { cooldownDays: 0, allowReentry: true, maxRunsPerContact: 0 },
        steps: [
          { id: 'wait_five_days', type: 'wait', amount: 5, unit: 'days' },
          {
            id: 'responded',
            type: 'branch',
            condition: { kind: 'group', match: 'all', rules: [{ kind: 'event', name: 'proposal.responded', op: 'did', withinDays: 6 }] },
            then: [{ id: 'stop', type: 'end' }],
            else: [
              { id: 'send_follow_up', type: 'send_email', templateId: templateIds.proposal_follow_up! },
              { id: 'call_task', type: 'create_task', title: 'Call {{first_name}} about the proposal', dueInDays: 2 },
            ],
          },
        ],
      },
    },
  ];
}

/** Seeds a new workspace with snippets, published starter templates and draft automations. */
export class StarterService {
  constructor(private readonly e: Engine) {}

  async seed(ctx: WorkspaceContext): Promise<void> {
    const existing = await this.e.db.selectFrom('templates').select('id').where('workspace_id', '=', ctx.workspaceId).limit(1).executeTakeFirst();
    if (existing) return;
    const now = this.e.nowIso();
    const userId = actorUserId(ctx);
    const templateIds: Record<string, string> = {};
    await this.e.db.transaction().execute(async (trx) => {
      for (const s of STARTER_SNIPPETS) {
        await trx
          .insertInto('snippets')
          .values({ id: newId('snp'), workspace_id: ctx.workspaceId, key: s.key, name: s.name, kind: s.kind, html: s.html, text: s.text, created_at: now, updated_at: now })
          .execute();
      }
      for (const t of STARTER_TEMPLATES) {
        const id = newId('tpl');
        const versionId = newId('tpv');
        templateIds[t.key] = id;
        await trx
          .insertInto('templates')
          .values({
            id,
            workspace_id: ctx.workspaceId,
            name: t.name,
            description: t.description,
            category: t.category,
            purpose: t.purpose,
            status: 'published',
            draft_version_id: versionId,
            published_version_id: versionId,
            created_by: userId,
            created_at: now,
            updated_at: now,
            archived_at: null,
          })
          .execute();
        await trx
          .insertInto('template_versions')
          .values({
            id: versionId,
            workspace_id: ctx.workspaceId,
            template_id: id,
            version: 1,
            subject: t.subject,
            preview_text: t.previewText,
            html: emailLayout(t.body),
            text: null,
            missing_policy: 'fallback',
            created_by: userId,
            created_at: now,
            published_at: now,
          })
          .execute();
      }
    });
    for (const a of starterAutomations(templateIds)) {
      await this.e.automations.createInternal(ctx, a.name, a.description, a.definition);
    }
  }
}

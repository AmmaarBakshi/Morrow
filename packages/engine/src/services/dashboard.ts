import { fullName, maskEmail, type DashboardDTO } from '@morrow/core';
import { sql } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';
import type { RangeInput } from './analytics';

/** The operational overview. Every number comes from the database. */
export class DashboardService {
  constructor(private readonly e: Engine) {}

  async summary(ctx: WorkspaceContext, input: RangeInput = {}): Promise<DashboardDTO> {
    authorize(ctx, 'analytics:read');
    const ws = ctx.workspaceId;
    const range = await this.e.analytics.range(ws, input);
    const { settings } = await this.e.workspaces.settings(ws);
    const now = this.e.nowIso();
    const n = async (q: Promise<{ n: unknown } | undefined>) => Number((await q)?.n ?? 0);
    const contacts = this.e.db.selectFrom('contacts').where('workspace_id', '=', ws);

    const marketingConsent = settings.consent.allowImpliedForMarketing ? ['granted', 'implied'] : ['granted'];
    const [total, active, marketingEligible, newInRange, withBirthday] = await Promise.all([
      n(contacts.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
      n(contacts.where('status', '=', 'active').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
      n(
        contacts
          .where('status', '=', 'active')
          .where('email_normalized', 'is not', null)
          .where('email_status', 'not in', ['invalid', 'bounced', 'complained'])
          .where('consent_status', 'in', marketingConsent)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('suppressions')
                  .select(sql`1`.as('one'))
                  .whereRef('suppressions.email_normalized', '=', 'contacts.email_normalized')
                  .where('suppressions.workspace_id', '=', ws)
                  .where('suppressions.lifted_at', 'is', null),
              ),
            ),
          )
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirst(),
      ),
      n(contacts.where('created_at', '>=', range.fromIso).where('created_at', '<', range.toIso).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
      n(contacts.where('status', '=', 'active').where('birthday_md', 'is not', null).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
    ]);

    const counts = await this.e.analytics.rangeCounts(ws, range);
    const reporting = await this.e.analytics.reporting(ws);

    const upcomingOccasions = await this.e.contacts.upcomingOccasions(ctx, { days: 14, limit: 8 });

    const scheduledCampaigns = await this.e.db
      .selectFrom('campaigns')
      .select(['id', 'name', 'scheduled_at'])
      .where('workspace_id', '=', ws)
      .where('status', '=', 'scheduled')
      .orderBy('scheduled_at', 'asc')
      .limit(5)
      .execute();
    const resumes = await this.e.db
      .selectFrom('automation_runs')
      .innerJoin('automations', 'automations.id', 'automation_runs.automation_id')
      .select(['automations.id', 'automations.name', (eb) => eb.fn.min('automation_runs.resume_at').as('at'), (eb) => eb.fn.countAll<number>().as('n')])
      .where('automation_runs.workspace_id', '=', ws)
      .where('automation_runs.status', '=', 'waiting')
      .groupBy(['automations.id', 'automations.name'])
      .limit(5)
      .execute();
    const scheduled: DashboardDTO['scheduled'] = [
      ...scheduledCampaigns.map((c) => ({ kind: 'campaign' as const, id: c.id, title: c.name, at: c.scheduled_at ?? now, link: `/campaigns/${c.id}` })),
      ...resumes.map((r) => ({ kind: 'automation_resume' as const, id: r.id, title: `${r.name} (${Number(r.n)} waiting)`, at: String(r.at ?? now), link: `/automations/${r.id}` })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1));

    const autoRows = await this.e.db
      .selectFrom('automations')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('workspace_id', '=', ws)
      .groupBy('status')
      .execute();
    const autoCount = (s: string) => Number(autoRows.find((r) => r.status === s)?.n ?? 0);

    const recentCampaigns = (await this.e.analytics.campaigns(ctx, { from: undefined, to: undefined })).slice(0, 5);

    const since = new Date(this.e.now().getTime() - 7 * 86_400_000).toISOString();
    const failedMessages = await this.e.db
      .selectFrom('messages')
      .select(['id', 'subject', 'to_email', 'status', 'error_message', 'updated_at'])
      .where('workspace_id', '=', ws)
      .where('kind', 'in', ['campaign', 'automation', 'system'])
      .where('status', 'in', ['failed', 'rejected', 'bounced', 'uncertain', 'complained'])
      .where('updated_at', '>=', since)
      .orderBy('updated_at', 'desc')
      .limit(6)
      .execute();
    const deadJobs = await this.e.db
      .selectFrom('jobs')
      .select(['id', 'type', 'last_error', 'updated_at'])
      .where('workspace_id', '=', ws)
      .where('status', '=', 'dead')
      .orderBy('updated_at', 'desc')
      .limit(4)
      .execute();
    const failures: DashboardDTO['failures'] = [
      ...failedMessages.map((m) => ({
        id: m.id,
        kind: 'message' as const,
        title: `${m.status === 'bounced' ? 'Bounced' : m.status === 'complained' ? 'Spam complaint' : m.status === 'uncertain' ? 'Needs review' : 'Failed'}: ${m.subject}`,
        detail: `${maskEmail(m.to_email)}${m.error_message ? ` — ${m.error_message.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (x) => maskEmail(x)).slice(0, 160)}` : ''}`,
        at: m.updated_at,
        link: `/messages/${m.id}`,
      })),
      ...deadJobs.map((j) => ({ id: j.id, kind: 'job' as const, title: `Job failed after retries: ${j.type}`, detail: (j.last_error ?? '').slice(0, 160), at: j.updated_at, link: '/settings/system' })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    const approvals = {
      messages: await n(this.e.db.selectFrom('messages').where('workspace_id', '=', ws).where('status', '=', 'pending_approval').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
      campaigns: await n(this.e.db.selectFrom('campaigns').where('workspace_id', '=', ws).where('status', '=', 'pending_approval').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
    };

    const taskCounts = await this.e.tasks.counts(ws);
    const taskItems = (await this.e.tasks.list(ctx, { status: 'open', pageSize: 5 })).items;

    const provider = await this.e.integrations.resolveEmailProvider(ws);
    const setup = {
      senderVerified: Boolean(await this.e.senders.defaultSender(ws)),
      providerConfigured: Boolean(provider),
      hasContacts: total > 0,
      hasTemplates: Boolean(await this.e.db.selectFrom('templates').select('id').where('workspace_id', '=', ws).where('status', '=', 'published').executeTakeFirst()),
      hasAutomations: autoCount('active') > 0,
    };

    return {
      range: { from: range.fromDate, to: range.toDate },
      contacts: { total, active, marketingEligible, newInRange, withBirthday },
      messages: { counts, rates: this.e.analytics.rates(counts, reporting), reporting },
      upcomingOccasions,
      scheduled,
      automations: { active: autoCount('active'), paused: autoCount('paused'), draft: autoCount('draft') },
      recentCampaigns,
      failures,
      approvals,
      tasks: { ...taskCounts, items: taskItems },
      setup,
    };
  }

  /** Display name helper shared by summary widgets. */
  name(first: string | null, last: string | null, email: string | null): string {
    return fullName({ firstName: first, lastName: last }) || email || 'Unnamed contact';
  }
}

import {
  AUTOMATION_UPDATABLE_FIELDS,
  automationDefinitionSchema,
  compileSteps,
  fullName,
  newId,
  RELATIONSHIP_TYPES,
  renderString,
  STEP_LABELS,
  waitDurationMs,
  type AutomationDefinition,
  type CompiledAutomation,
  type DryRunStepDTO,
  type MessageCategory,
  type Step,
} from '@morrow/core';
import { fromJson, toJson, type Db, type Row } from '@morrow/db';
import type { Engine } from '../engine';
import type { Job } from '../queue/queue';
import type { Reschedule } from '../queue/worker';

export interface LoadedVersion {
  definition: AutomationDefinition;
  compiled: CompiledAutomation;
}

type StepOutcome =
  | { kind: 'continue'; next: string | null; status: 'ok' | 'skipped'; detail: string }
  | { kind: 'wait'; resumeAt: Date; detail: string }
  | { kind: 'end'; detail: string }
  | { kind: 'fail'; detail: string };

const MAX_STEPS_PER_EXECUTION = 200;
const TERMINAL = new Set(['completed', 'skipped', 'failed', 'cancelled']);

/**
 * Executes automation runs. A run is a single contact moving through an
 * immutable automation version. Every step is idempotent, and the cursor is
 * persisted after each step, so a crash or retry resumes safely without
 * repeating side effects (e-mails are de-duplicated by idempotency key).
 */
export class AutomationExecutor {
  private readonly versions = new Map<string, LoadedVersion>();

  constructor(private readonly e: Engine) {}

  async loadVersion(versionId: string, db: Db = this.e.db): Promise<LoadedVersion> {
    const hit = this.versions.get(versionId);
    if (hit) return hit;
    const row = await db.selectFrom('automation_versions').selectAll().where('id', '=', versionId).executeTakeFirstOrThrow();
    const definition = automationDefinitionSchema.parse(fromJson(row.definition, {}));
    const loaded = { definition, compiled: compileSteps(definition.steps) };
    if (this.versions.size > 500) this.versions.clear();
    this.versions.set(versionId, loaded);
    return loaded;
  }

  /** Start a run unless one already exists for this automation, contact and event. */
  async startRun(params: {
    workspaceId: string;
    automationId: string;
    versionId: string;
    contactId: string;
    eventKey: string;
    eventData?: Record<string, unknown>;
    db?: Db;
  }): Promise<{ runId: string | null; created: boolean }> {
    const db = params.db ?? this.e.db;
    const now = this.e.nowIso();
    const id = newId('run');
    const inserted = await db
      .insertInto('automation_runs')
      .values({
        id,
        workspace_id: params.workspaceId,
        automation_id: params.automationId,
        version_id: params.versionId,
        contact_id: params.contactId,
        event_key: params.eventKey.slice(0, 300),
        event_data: toJson(params.eventData ?? {}),
        status: 'running',
        cursor: null,
        resume_at: null,
        error: null,
        started_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return { runId: null, created: false };
    await this.e.queue.enqueue('automation.execute', { runId: id }, { workspaceId: params.workspaceId, dedupeKey: `run:${id}:start`, maxAttempts: 6 }, db);
    await db.updateTable('automations').set({ last_triggered_at: now }).where('id', '=', params.automationId).execute();
    return { runId: id, created: true };
  }

  private async log(run: Row<'automation_runs'>, stepId: string, stepType: string, status: 'ok' | 'skipped' | 'waiting' | 'failed', detail: string) {
    await this.e.db
      .insertInto('automation_run_steps')
      .values({ id: newId('rst'), workspace_id: run.workspace_id, run_id: run.id, step_id: stepId, step_type: stepType, status, detail: detail.slice(0, 2000), created_at: this.e.nowIso() })
      .execute();
  }

  private async finish(run: Row<'automation_runs'>, status: 'completed' | 'skipped' | 'failed' | 'cancelled', error: string | null = null) {
    const now = this.e.nowIso();
    await this.e.db
      .updateTable('automation_runs')
      .set({ status, error, cursor: null, resume_at: null, completed_at: now, updated_at: now })
      .where('id', '=', run.id)
      .execute();
  }

  /** Data available to task titles and notifications ({{first_name}}, {{event.x}}…). */
  private textData(contact: Row<'contacts'>, eventData: Record<string, unknown>): Record<string, unknown> {
    return {
      first_name: contact.first_name,
      last_name: contact.last_name,
      full_name: fullName({ firstName: contact.first_name, lastName: contact.last_name }),
      email: contact.email,
      company: contact.company,
      job_title: contact.job_title,
      relationship_type: contact.relationship_type,
      occasion_date: eventData.occasion_date ?? null,
      years: eventData.years ?? null,
      event: eventData.event ?? {},
    };
  }

  private renderText(source: string, data: Record<string, unknown>): string {
    try {
      return renderString(source, data, { mode: 'subject', fallbacks: { first_name: 'this contact' } }).output;
    } catch {
      return source;
    }
  }

  /** Entry checks evaluated once, when a run starts. Returns a skip reason or null. */
  async entryCheck(workspaceId: string, automation: Row<'automations'>, def: AutomationDefinition, contact: Row<'contacts'>, runId: string | null, startedAt: string): Promise<string | null> {
    if (contact.status !== 'active') return 'Contact is archived';
    if (def.conditions && def.conditions.rules.length) {
      const ok = await this.e.segments.matches(workspaceId, def.conditions, contact.id);
      if (!ok) return 'Contact does not meet the entry conditions';
    }
    const others = this.e.db
      .selectFrom('automation_runs')
      .where('automation_id', '=', automation.id)
      .where('contact_id', '=', contact.id)
      .where('status', 'not in', ['skipped', 'cancelled'])
      .where('id', '!=', runId ?? '');
    const s = def.settings;
    if (!s.allowReentry) {
      const prior = await others.select('id').executeTakeFirst();
      if (prior) return 'Contact already went through this automation (re-entry is off)';
    }
    if (s.maxRunsPerContact > 0) {
      const n = Number((await others.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
      if (n >= s.maxRunsPerContact) return `Contact reached the limit of ${s.maxRunsPerContact} run(s)`;
    }
    if (s.cooldownDays > 0) {
      const since = new Date(Date.parse(startedAt) - s.cooldownDays * 86_400_000).toISOString();
      const recent = await others.select('id').where('started_at', '>=', since).executeTakeFirst();
      if (recent) return `Cooldown: contact entered within the last ${s.cooldownDays} day(s)`;
    }
    return null;
  }

  private async runStep(
    run: Row<'automation_runs'>,
    automation: Row<'automations'>,
    contact: Row<'contacts'>,
    loaded: LoadedVersion,
    step: Step,
    eventData: Record<string, unknown>,
  ): Promise<StepOutcome> {
    const node = loaded.compiled.nodes[step.id]!;
    const ws = run.workspace_id;
    switch (step.type) {
      case 'send_email': {
        const tpl = await this.e.templates.publishedSource(ws, step.templateId);
        if (!tpl) return { kind: 'fail', detail: 'The e-mail template is not published (or was archived).' };
        const sender = await this.e.senders.resolve(ws, step.senderId);
        if (!sender) return { kind: 'fail', detail: 'No verified sender is available. Verify a sender in Settings → Sending.' };
        const category = (step.category ?? tpl.category) as MessageCategory;
        const result = await this.e.delivery.prepare({
          workspaceId: ws,
          kind: 'automation',
          category,
          idempotencyKey: `auto:${automation.id}:${contact.id}:${run.event_key}:${step.id}`,
          contact,
          template: { ...tpl, subject: step.subjectOverride || tpl.subject },
          sender: { email: sender.email, name: sender.name, replyTo: sender.reply_to },
          automationId: automation.id,
          automationRunId: run.id,
          data: eventData,
          requireApproval: automation.delivery_mode !== 'auto',
        });
        switch (result.outcome) {
          case 'queued':
            return { kind: 'continue', next: node.next, status: 'ok', detail: `Queued "${tpl.name}" (${result.messageId})` };
          case 'pending_approval':
            return { kind: 'continue', next: node.next, status: 'ok', detail: `Waiting for approval: "${tpl.name}" (${result.messageId})` };
          case 'duplicate':
            return { kind: 'continue', next: node.next, status: 'ok', detail: `Already created (${result.messageId}, ${result.status})` };
          case 'skipped':
            return { kind: 'continue', next: node.next, status: 'skipped', detail: `Not sent: ${result.reasons.join(', ')}` };
        }
        break;
      }
      case 'wait': {
        const resumeAt = new Date(this.e.now().getTime() + waitDurationMs(step));
        return { kind: 'wait', resumeAt, detail: `Waiting ${step.amount} ${step.unit} until ${resumeAt.toISOString()}` };
      }
      case 'add_tag': {
        const added = await this.e.tags.attach(ws, contact.id, [step.tag]);
        return { kind: 'continue', next: node.next, status: 'ok', detail: added.length ? `Added tag "${step.tag}"` : `Already tagged "${step.tag}"` };
      }
      case 'remove_tag': {
        const removed = await this.e.tags.detach(ws, contact.id, [step.tag]);
        return { kind: 'continue', next: node.next, status: 'ok', detail: removed.length ? `Removed tag "${step.tag}"` : `Tag "${step.tag}" was not present` };
      }
      case 'update_field': {
        if (step.field.startsWith('custom:')) {
          await this.e.fields.setValues(ws, contact.id, { [step.field.slice(7)]: step.value });
        } else {
          if (!(AUTOMATION_UPDATABLE_FIELDS as readonly string[]).includes(step.field)) return { kind: 'fail', detail: `Field ${step.field} cannot be updated by automations.` };
          if (step.field === 'relationship_type' && !(RELATIONSHIP_TYPES as readonly string[]).includes(String(step.value))) {
            return { kind: 'fail', detail: `Invalid relationship type "${String(step.value)}".` };
          }
          const value = step.value === null ? null : String(step.value).slice(0, 150);
          if (step.field === 'relationship_type' && value === null) return { kind: 'fail', detail: 'Relationship type cannot be empty.' };
          await this.e.db
            .updateTable('contacts')
            .set({ [step.field]: value, updated_at: this.e.nowIso() } as Partial<Row<'contacts'>>)
            .where('id', '=', contact.id)
            .execute();
        }
        return { kind: 'continue', next: node.next, status: 'ok', detail: `Set ${step.field} to ${JSON.stringify(step.value)}` };
      }
      case 'create_task': {
        const data = this.textData(contact, eventData);
        const due = new Date(this.e.now().getTime() + step.dueInDays * 86_400_000).toISOString();
        const id = await this.e.tasks.createInternal(ws, {
          title: this.renderText(step.title, data),
          description: step.description ? this.renderText(step.description, data) : `Created by automation "${automation.name}".`,
          contactId: contact.id,
          dueAt: due,
          assigneeId: step.assigneeUserId ?? null,
          source: 'automation',
          automationRunId: run.id,
          dedupeKey: `run:${run.id}:${step.id}`,
        });
        return { kind: 'continue', next: node.next, status: 'ok', detail: id ? `Created task ${id}` : 'Task already created' };
      }
      case 'notify': {
        const data = this.textData(contact, eventData);
        const n = await this.e.notifications.notifyTeam(ws, {
          kind: 'automation.notify',
          title: this.renderText(step.title, data),
          body: step.body ? this.renderText(step.body, data) : null,
          link: `/contacts/${contact.id}`,
          dedupeKey: `run:${run.id}:${step.id}`,
          email: Boolean(step.email),
        });
        return { kind: 'continue', next: node.next, status: 'ok', detail: `Notified ${n} team member(s)` };
      }
      case 'branch': {
        const yes = await this.e.segments.matches(ws, step.condition, contact.id);
        const next = (yes ? node.thenEntry : node.elseEntry) ?? node.next;
        return { kind: 'continue', next, status: 'ok', detail: yes ? 'Condition met → "then" path' : 'Condition not met → "else" path' };
      }
      case 'end':
        return { kind: 'end', detail: 'Reached end step' };
    }
    return { kind: 'fail', detail: 'Unknown step type' };
  }

  /** Job handler for `automation.execute`. */
  async execute(job: Job): Promise<void | Reschedule> {
    const runId = String(job.payload.runId ?? '');
    let run = await this.e.db.selectFrom('automation_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run || TERMINAL.has(run.status)) return;
    const automation = await this.e.db.selectFrom('automations').selectAll().where('id', '=', run.automation_id).executeTakeFirst();
    if (!automation || automation.status === 'archived') {
      await this.finish(run, 'cancelled', 'Automation was archived');
      return;
    }
    if (automation.status === 'paused' || automation.status === 'draft') {
      // Paused automations hold their in-flight runs until resumed.
      return { reschedule: new Date(this.e.now().getTime() + 5 * 60_000) };
    }
    const contact = await this.e.db.selectFrom('contacts').selectAll().where('id', '=', run.contact_id).executeTakeFirst();
    if (!contact) {
      await this.finish(run, 'cancelled', 'Contact no longer exists');
      return;
    }
    const loaded = await this.loadVersion(run.version_id);
    const eventData = fromJson<Record<string, unknown>>(run.event_data, {});

    if (run.status === 'running' && run.cursor === null) {
      const entered = await this.e.db.selectFrom('automation_run_steps').select('id').where('run_id', '=', run.id).where('step_id', '=', '__entry').executeTakeFirst();
      if (!entered) {
        const skip = await this.entryCheck(run.workspace_id, automation, loaded.definition, contact, run.id, run.started_at);
        if (skip) {
          await this.log(run, '__entry', 'entry', 'skipped', skip);
          await this.finish(run, 'skipped', skip);
          return;
        }
        await this.log(run, '__entry', 'entry', 'ok', 'Entry conditions met');
        if (!loaded.compiled.entry) {
          await this.finish(run, 'completed');
          return;
        }
        await this.e.db.updateTable('automation_runs').set({ cursor: loaded.compiled.entry, updated_at: this.e.nowIso() }).where('id', '=', run.id).execute();
        run = { ...run, cursor: loaded.compiled.entry };
      }
    }

    let cursor = run.cursor;
    if (run.status === 'waiting' && cursor) {
      const node = loaded.compiled.nodes[cursor];
      if (run.resume_at && Date.parse(run.resume_at) > this.e.now().getTime()) return { reschedule: new Date(run.resume_at) };
      await this.log(run, cursor, 'wait', 'ok', 'Wait finished');
      cursor = node?.next ?? null;
      await this.e.db.updateTable('automation_runs').set({ status: 'running', cursor, resume_at: null, updated_at: this.e.nowIso() }).where('id', '=', run.id).execute();
    }

    for (let i = 0; i < MAX_STEPS_PER_EXECUTION && cursor; i++) {
      const node = loaded.compiled.nodes[cursor];
      if (!node) {
        await this.finish(run, 'failed', `Unknown step ${cursor}`);
        return;
      }
      const outcome = await this.runStep(run, automation, contact, loaded, node.step, eventData);
      const type = node.step.type;
      if (outcome.kind === 'fail') {
        await this.log(run, node.step.id, type, 'failed', outcome.detail);
        await this.finish(run, 'failed', outcome.detail);
        await this.e.notifications.notifyAdmins(run.workspace_id, {
          kind: 'automation.failed',
          title: `Automation "${automation.name}" needs attention`,
          body: `${STEP_LABELS[type]} failed: ${outcome.detail}`,
          link: `/automations/${automation.id}`,
          dedupeKey: `automation-failed:${automation.id}:${this.e.nowIso().slice(0, 10)}`,
        });
        return;
      }
      if (outcome.kind === 'wait') {
        await this.log(run, node.step.id, type, 'waiting', outcome.detail);
        await this.e.db
          .updateTable('automation_runs')
          .set({ status: 'waiting', cursor: node.step.id, resume_at: outcome.resumeAt.toISOString(), updated_at: this.e.nowIso() })
          .where('id', '=', run.id)
          .execute();
        await this.e.queue.enqueue(
          'automation.execute',
          { runId: run.id },
          { workspaceId: run.workspace_id, runAt: outcome.resumeAt, dedupeKey: `run:${run.id}:${node.step.id}:resume`, maxAttempts: 6 },
        );
        return;
      }
      if (outcome.kind === 'end') {
        await this.log(run, node.step.id, type, 'ok', outcome.detail);
        break;
      }
      await this.log(run, node.step.id, type, outcome.status, outcome.detail);
      cursor = outcome.next;
      await this.e.db.updateTable('automation_runs').set({ cursor, updated_at: this.e.nowIso() }).where('id', '=', run.id).execute();
    }
    await this.finish(run, 'completed');
  }

  // ------------------------------------------------------------ simulation

  /** Walk the steps for one contact without side effects (dry run). */
  async simulateSteps(
    workspaceId: string,
    automation: Pick<Row<'automations'>, 'id' | 'delivery_mode'>,
    loaded: LoadedVersion,
    contact: Row<'contacts'>,
    eventData: Record<string, unknown>,
  ): Promise<DryRunStepDTO[]> {
    const out: DryRunStepDTO[] = [];
    const { settings } = await this.e.workspaces.settings(workspaceId);
    let cursor = loaded.compiled.entry;
    for (let i = 0; i < MAX_STEPS_PER_EXECUTION && cursor; i++) {
      const node = loaded.compiled.nodes[cursor]!;
      const step = node.step;
      switch (step.type) {
        case 'send_email': {
          const tpl = await this.e.templates.publishedSource(workspaceId, step.templateId);
          if (!tpl) {
            out.push({ stepId: step.id, type: step.type, outcome: 'blocked', detail: 'Template is not published' });
            break;
          }
          const category = (step.category ?? tpl.category) as MessageCategory;
          const elig = await this.e.delivery.eligibility(workspaceId, contact, contact.email, category, settings);
          const capped = elig.eligible && (await this.e.delivery.frequencyCapped(workspaceId, contact, settings));
          const sender = await this.e.senders.resolve(workspaceId, step.senderId);
          const composed = await this.e.delivery.compose({
            workspaceId,
            messageId: 'msg_dryrun',
            contact,
            toEmail: contact.email ?? '',
            category,
            template: { ...tpl, subject: step.subjectOverride || tpl.subject },
            sender: sender ? { email: sender.email, name: sender.name, replyTo: sender.reply_to } : { email: 'sender@not-verified', name: null, replyTo: null },
            data: eventData,
            preview: true,
          });
          const blockers = [...elig.reasons, ...(capped ? ['frequency_cap'] : []), ...(sender ? [] : ['no_verified_sender'])];
          if (composed.email.missing.length && tpl.missingPolicy === 'skip') blockers.push(`missing_personalization:${composed.email.missing.join(',')}`);
          out.push({
            stepId: step.id,
            type: step.type,
            outcome: blockers.length ? 'blocked' : 'would_run',
            detail: blockers.length
              ? `Would not send: ${blockers.join(', ')}`
              : `Would ${automation.delivery_mode === 'auto' ? 'send' : 'queue for approval'} "${tpl.name}" (${category})`,
            email: {
              subject: composed.email.subject,
              previewText: composed.email.previewText,
              html: composed.email.html,
              text: composed.email.text,
              missing: composed.email.missing,
              to: contact.email ?? '',
              category,
            },
          });
          break;
        }
        case 'wait':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_wait', detail: `Would wait ${step.amount} ${step.unit}` });
          break;
        case 'branch': {
          const yes = await this.e.segments.matches(workspaceId, step.condition, contact.id);
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: yes ? 'Condition met → "then" path' : 'Condition not met → "else" path' });
          cursor = (yes ? node.thenEntry : node.elseEntry) ?? node.next;
          continue;
        }
        case 'end':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_end', detail: 'Would end the automation' });
          return out;
        case 'create_task':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: `Would create task "${this.renderText(step.title, this.textData(contact, eventData))}"` });
          break;
        case 'notify':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: `Would notify the team: "${this.renderText(step.title, this.textData(contact, eventData))}"` });
          break;
        case 'add_tag':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: `Would add tag "${step.tag}"` });
          break;
        case 'remove_tag':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: `Would remove tag "${step.tag}"` });
          break;
        case 'update_field':
          out.push({ stepId: step.id, type: step.type, outcome: 'would_run', detail: `Would set ${step.field} to ${JSON.stringify(step.value)}` });
          break;
      }
      cursor = node.next;
    }
    return out;
  }
}

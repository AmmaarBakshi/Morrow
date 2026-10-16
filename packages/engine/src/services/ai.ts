import { AI_PROVIDERS, AiError, createAiProvider, MorrowAssistant, type AiProvider, type AssistantContext, type CampaignSummary, type SubjectSuggestion, type Tone } from '@morrow/ai';
import { MorrowError, PreconditionError, ValidationError, type AiDraftDTO, type AiStatusDTO, type MessageCategory } from '@morrow/core';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

const TONES: Tone[] = ['warm', 'professional', 'concise', 'friendly', 'formal', 'playful'];
const MAX_INPUT = 20_000;

function mapError(err: unknown): never {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'disabled':
      case 'auth':
      case 'refused':
        throw new PreconditionError(err.message);
      case 'rate_limited':
        throw new MorrowError('rate_limited', err.message);
      default:
        throw new MorrowError('unavailable', err.message);
    }
  }
  throw err;
}

/**
 * Optional AI assistance. Everything returned is a draft for a person to
 * review in the template editor; nothing here can send, approve or change
 * eligibility. Contact records are never sent to the model.
 */
export class AiService {
  constructor(private readonly e: Engine) {}

  async provider(workspaceId: string): Promise<AiProvider | null> {
    if (this.e.aiOverride) return this.e.aiOverride;
    const ws = await this.e.integrations.aiSettings(workspaceId);
    try {
      if (ws) return createAiProvider(ws.provider, ws.config, ws.secrets);
      const env = this.e.config.ai;
      if (env?.apiKey) return createAiProvider(env.provider, { model: env.model ?? undefined }, { apiKey: env.apiKey });
    } catch (err) {
      this.e.log.warn('AI provider misconfigured', { workspaceId, error: err as Error });
    }
    return null;
  }

  async status(workspaceId: string): Promise<AiStatusDTO> {
    const p = await this.provider(workspaceId);
    return { enabled: Boolean(p), provider: p?.name ?? null, model: p?.model ?? null };
  }

  providers() {
    return AI_PROVIDERS;
  }

  private async assistant(ctx: WorkspaceContext): Promise<{ assistant: MorrowAssistant; context: AssistantContext }> {
    authorize(ctx, 'ai:use');
    const provider = await this.provider(ctx.workspaceId);
    if (!provider) throw new PreconditionError('AI assistance is not configured. Add a provider in Settings → AI, or leave it off — everything else works without it.');
    const [{ settings, workspace }, fields] = await Promise.all([this.e.workspaces.settings(ctx.workspaceId), this.e.fields.definitions(ctx.workspaceId)]);
    return {
      assistant: new MorrowAssistant(provider),
      context: {
        companyName: settings.companyName || workspace.name,
        workspaceVariables: Object.keys(settings.variables),
        customFieldKeys: fields.map((f) => f.key),
        voice: typeof settings.variables.brand_voice === 'string' ? settings.variables.brand_voice : null,
      },
    };
  }

  private text(value: unknown, field: string, max = MAX_INPUT): string {
    if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required.`, [{ path: field, message: 'Required.' }]);
    if (value.length > max) throw new ValidationError(`${field} is too long.`, [{ path: field, message: `At most ${max} characters.` }]);
    return value;
  }

  private tone(value: unknown): Tone {
    return TONES.includes(value as Tone) ? (value as Tone) : 'warm';
  }

  async draft(ctx: WorkspaceContext, input: { purpose: string; audience?: string; keyPoints?: string; tone?: string; category?: MessageCategory }): Promise<AiDraftDTO> {
    const { assistant, context } = await this.assistant(ctx);
    const purpose = this.text(input.purpose, 'purpose', 2000);
    try {
      const out = await assistant.draft(context, {
        purpose,
        audience: input.audience?.slice(0, 1000),
        keyPoints: input.keyPoints?.slice(0, 4000),
        tone: this.tone(input.tone),
        category: input.category ?? 'marketing',
      });
      await this.e.audit.record(ctx, 'ai.draft', null, { model: assistant.model });
      return out;
    } catch (err) {
      mapError(err);
    }
  }

  async rewrite(ctx: WorkspaceContext, input: { subject: string; html: string; tone?: string; instructions?: string }): Promise<AiDraftDTO> {
    const { assistant, context } = await this.assistant(ctx);
    try {
      const out = await assistant.rewrite(context, {
        subject: this.text(input.subject, 'subject', 500),
        html: this.text(input.html, 'html'),
        tone: this.tone(input.tone),
        instructions: input.instructions?.slice(0, 1000),
      });
      await this.e.audit.record(ctx, 'ai.rewrite', null, { model: assistant.model, tone: this.tone(input.tone) });
      return out;
    } catch (err) {
      mapError(err);
    }
  }

  async adapt(ctx: WorkspaceContext, input: { subject: string; html: string; segmentId: string }): Promise<AiDraftDTO> {
    const { assistant, context } = await this.assistant(ctx);
    const segment = await this.e.segments.get(ctx, input.segmentId);
    try {
      return await assistant.adaptForSegment(context, {
        subject: this.text(input.subject, 'subject', 500),
        html: this.text(input.html, 'html'),
        segmentDescription: `${segment.name}${segment.description ? ` — ${segment.description}` : ''} (${segment.summary})`,
      });
    } catch (err) {
      mapError(err);
    }
  }

  async subjects(ctx: WorkspaceContext, input: { html: string; current?: string; count?: number }): Promise<SubjectSuggestion[]> {
    const { assistant, context } = await this.assistant(ctx);
    try {
      return await assistant.subjectLines(context, { html: this.text(input.html, 'html'), current: input.current?.slice(0, 300), count: input.count });
    } catch (err) {
      mapError(err);
    }
  }

  /** Summarise a campaign from aggregate statistics only. */
  async summarizeCampaign(ctx: WorkspaceContext, campaignId: string): Promise<CampaignSummary> {
    const { assistant, context } = await this.assistant(ctx);
    authorize(ctx, 'analytics:read');
    const c = await this.e.campaigns.get(ctx, campaignId);
    const failures = await this.e.analytics.failures(ctx, {});
    try {
      return await assistant.summarizeCampaign(context, {
        name: c.name,
        category: c.category,
        status: c.status,
        launchedAt: c.launchedAt,
        recipients: c.recipientCount,
        counts: c.stats.counts,
        rates: c.stats.rates,
        providerReports: c.stats.reporting,
        topFailureReasons: failures.slice(0, 5).map((f) => ({ status: f.status, count: f.count })),
      });
    } catch (err) {
      mapError(err);
    }
  }
}

import { analyzeTemplate, isKnownVariable, parseTemplate, sanitizeTemplateHtml, STANDARD_VARIABLES, type AiDraftDTO } from '@morrow/core';
import { z } from 'zod';
import type { AiProvider } from './types';

export interface AssistantContext {
  companyName: string;
  /** Workspace-defined variables that may be used, e.g. collaboration_url. */
  workspaceVariables: string[];
  customFieldKeys: string[];
  /** Short description of the company/brand voice supplied by the user. */
  voice?: string | null;
}

export type Tone = 'warm' | 'professional' | 'concise' | 'friendly' | 'formal' | 'playful';

const draftSchema = z.object({
  subject: z.string(),
  previewText: z.string(),
  html: z.string(),
  notes: z.array(z.string()),
});

const subjectsSchema = z.object({ subjects: z.array(z.object({ subject: z.string(), previewText: z.string(), rationale: z.string() })) });

const summarySchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
  concerns: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export type CampaignSummary = z.infer<typeof summarySchema>;
export type SubjectSuggestion = z.infer<typeof subjectsSchema>['subjects'][number];

function variableList(ctx: AssistantContext): string {
  const standard = STANDARD_VARIABLES.filter((v) => v.group !== 'system' || v.key === 'unsubscribe_url').map((v) => `{{${v.key}}} — ${v.label}`);
  const ws = ctx.workspaceVariables.map((k) => `{{${k}}} — workspace variable`);
  const custom = ctx.customFieldKeys.map((k) => `{{custom.${k}}} — custom contact field`);
  return [...standard, ...ws, ...custom].join('\n');
}

function systemPrompt(ctx: AssistantContext): string {
  return [
    `You help ${ctx.companyName || 'a software company'} write e-mail for their contacts: clients, leads, developers, collaborators and subscribers.`,
    ctx.voice ? `Brand voice: ${ctx.voice}` : 'Voice: clear, human and respectful. Never pushy.',
    '',
    'Rules:',
    '- Personalise only with the template variables listed below, written exactly as shown (for example {{first_name}}). Morrow fills them in per recipient.',
    '- Never invent facts about a recipient (achievements, purchases, relationships, dates) or about the company. If something specific is needed, use an obvious placeholder in square brackets for the author to fill in, such as [describe the project].',
    '- Relationship messages (birthdays, thank-yous, check-ins) must not turn into sales pitches.',
    '- Write the body as simple e-mail-safe HTML using only <p>, <h2>, <ul>, <li>, <a href="...">, <strong> and <em>. No <html>, <head>, <style> or <script> tags; the workspace layout adds the header, signature and footer.',
    '- Do not add an unsubscribe link; the footer provides it.',
    '- Keep subjects under 60 characters and preview text under 100.',
    '',
    'Available variables:',
    variableList(ctx),
  ].join('\n');
}

/** Variables used by generated content and which of them are not available. */
export function inspectVariables(source: string, ctx: AssistantContext): { used: string[]; unknown: string[] } {
  try {
    const { variables } = analyzeTemplate(parseTemplate(source));
    const used = variables.map((v) => v.path);
    return { used, unknown: used.filter((p) => !isKnownVariable(p, ctx.workspaceVariables, ctx.customFieldKeys)) };
  } catch {
    return { used: [], unknown: [] };
  }
}

/**
 * Drafting helpers built on any AiProvider. Inputs are the author's own
 * brief and template text plus aggregate statistics — never contact records.
 */
export class MorrowAssistant {
  constructor(private readonly provider: AiProvider) {}

  get model(): string {
    return this.provider.model;
  }

  private finish(draft: { subject: string; previewText: string; html: string; notes: string[] }, ctx: AssistantContext): AiDraftDTO {
    const html = sanitizeTemplateHtml(draft.html).html;
    const { used, unknown } = inspectVariables(`${draft.subject}\n${draft.previewText}\n${html}`, ctx);
    const notes = [...draft.notes];
    if (unknown.length) notes.push(`Check these variables, which this workspace does not define: ${unknown.map((u) => `{{${u}}}`).join(', ')}`);
    return { subject: draft.subject, previewText: draft.previewText, html, text: null, notes, variablesUsed: used, unknownVariables: unknown };
  }

  async draft(ctx: AssistantContext, brief: { purpose: string; audience?: string; keyPoints?: string; tone?: Tone; category: 'transactional' | 'relationship' | 'marketing' }): Promise<AiDraftDTO> {
    const prompt = [
      `Write a ${brief.category} e-mail.`,
      `Purpose: ${brief.purpose}`,
      brief.audience ? `Audience: ${brief.audience}` : null,
      brief.keyPoints ? `Points to cover:\n${brief.keyPoints}` : null,
      `Tone: ${brief.tone ?? 'warm'}`,
      'Return a subject, preview text, the HTML body, and short notes for the author (for example placeholders they must fill in).',
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.finish(await this.provider.generateJson({ system: systemPrompt(ctx), prompt, schema: draftSchema }), ctx);
  }

  async rewrite(ctx: AssistantContext, input: { subject: string; html: string; tone: Tone; instructions?: string }): Promise<AiDraftDTO> {
    const prompt = [
      `Rewrite this e-mail in a ${input.tone} tone. Keep its meaning, every template variable and every link exactly as they are.`,
      input.instructions ? `Additional instructions: ${input.instructions}` : null,
      `Subject:\n${input.subject}`,
      `HTML body:\n${input.html}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.finish(await this.provider.generateJson({ system: systemPrompt(ctx), prompt, schema: draftSchema }), ctx);
  }

  async adaptForSegment(ctx: AssistantContext, input: { subject: string; html: string; segmentDescription: string }): Promise<AiDraftDTO> {
    const prompt = `Adapt this e-mail for this audience: ${input.segmentDescription}. Keep variables and links unchanged.\n\nSubject:\n${input.subject}\n\nHTML body:\n${input.html}`;
    return this.finish(await this.provider.generateJson({ system: systemPrompt(ctx), prompt, schema: draftSchema }), ctx);
  }

  async subjectLines(ctx: AssistantContext, input: { html: string; current?: string; count?: number }): Promise<SubjectSuggestion[]> {
    const count = Math.min(10, Math.max(1, input.count ?? 5));
    const prompt = `Suggest ${count} subject lines with matching preview text for this e-mail. Vary the approach (direct, curious, personal). Avoid spammy wording, all caps and excessive punctuation.${input.current ? `\n\nCurrent subject: ${input.current}` : ''}\n\nHTML body:\n${input.html}`;
    const res = await this.provider.generateJson({ system: systemPrompt(ctx), prompt, schema: subjectsSchema, effort: 'low' });
    return res.subjects.slice(0, count);
  }

  /** Summarise aggregate campaign statistics and suggest follow-ups. */
  async summarizeCampaign(ctx: AssistantContext, stats: Record<string, unknown>): Promise<CampaignSummary> {
    const prompt = [
      'Summarise the performance of this e-mail campaign for the team in plain language, then list highlights, concerns and practical next steps (for example follow-ups for people who clicked, or cleaning bounced addresses).',
      'Open rates are estimates distorted by privacy features; say so if you discuss them. Only use the numbers given — do not invent any.',
      `Statistics (JSON):\n${JSON.stringify(stats, null, 2)}`,
    ].join('\n\n');
    return this.provider.generateJson({
      system: `You are an analyst for ${ctx.companyName || 'a software company'}'s e-mail programme. Be concise and factual.`,
      prompt,
      schema: summarySchema,
      effort: 'low',
    });
  }
}

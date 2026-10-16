import type {
  AiCampaignSummaryDTO,
  AiDraftDTO,
  AiStatusDTO,
  AiSubjectSuggestionDTO,
  DnsCheckDTO,
  EmailIntegrationDTO,
  JobDTO,
  MessageCategory,
  Page,
  ProviderInfoDTO,
  SenderDTO,
  SuppressionDTO,
  SuppressionReason,
  SystemHealthDTO,
} from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, PageQuery } from '../types';

export class SendersApi {
  constructor(private readonly t: Transport) {}

  list(): Promise<Items<SenderDTO>> {
    return this.t.json('GET', '/senders');
  }
  create(input: { name: string; email: string; replyTo?: string | null; isDefault?: boolean }): Promise<SenderDTO> {
    return this.t.json('POST', '/senders', { body: input });
  }
  update(id: string, input: { name?: string; replyTo?: string | null; isDefault?: boolean }): Promise<SenderDTO> {
    return this.t.json('PATCH', `/senders/${id}`, { body: input });
  }
  delete(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/senders/${id}`);
  }
  sendVerification(id: string): Promise<{ sent: boolean; verifyUrl?: string }> {
    return this.t.json('POST', `/senders/${id}/send-verification`);
  }
  markVerified(id: string, note: string): Promise<SenderDTO> {
    return this.t.json('POST', `/senders/${id}/mark-verified`, { body: { note } });
  }
  /** SPF, DKIM, DMARC and MX checks for the sender's domain. */
  dns(id: string): Promise<DnsCheckDTO> {
    return this.t.json('GET', `/senders/${id}/dns`);
  }
}

export class IntegrationsApi {
  constructor(private readonly t: Transport) {}

  providers(): Promise<Items<ProviderInfoDTO>> {
    return this.t.json('GET', '/integrations/providers');
  }
  email(): Promise<EmailIntegrationDTO> {
    return this.t.json('GET', '/integrations/email');
  }
  /** Secrets are write-only: send `null` to clear one, omit to keep it. */
  setEmail(input: { provider: string; config?: Record<string, unknown>; secrets?: Record<string, string | null> }): Promise<EmailIntegrationDTO> {
    return this.t.json('PUT', '/integrations/email', { body: input });
  }
  testEmail(): Promise<{ ok: boolean; message: string }> {
    return this.t.json('POST', '/integrations/email/test');
  }
  removeEmail(): Promise<Ok> {
    return this.t.json('DELETE', '/integrations/email');
  }
  ai(): Promise<AiStatusDTO & { providers: unknown[] }> {
    return this.t.json('GET', '/integrations/ai');
  }
  setAi(input: { provider: string | null; config?: Record<string, unknown>; secrets?: Record<string, string | null> }): Promise<AiStatusDTO> {
    return this.t.json('PUT', '/integrations/ai', { body: input });
  }
}

/** Optional AI writing help. Drafts only — nothing is sent without a person. */
export class AiApi {
  constructor(private readonly t: Transport) {}

  draft(input: { purpose: string; audience?: string; keyPoints?: string; tone?: string; category?: MessageCategory }): Promise<AiDraftDTO> {
    return this.t.json('POST', '/ai/draft', { body: input });
  }
  rewrite(input: { subject: string; html: string; tone?: string; instructions?: string }): Promise<AiDraftDTO> {
    return this.t.json('POST', '/ai/rewrite', { body: input });
  }
  adapt(input: { subject: string; html: string; segmentId: string }): Promise<AiDraftDTO> {
    return this.t.json('POST', '/ai/adapt', { body: input });
  }
  subjects(input: { html: string; current?: string; count?: number }): Promise<Items<AiSubjectSuggestionDTO>> {
    return this.t.json('POST', '/ai/subjects', { body: input });
  }
  summarizeCampaign(campaignId: string): Promise<AiCampaignSummaryDTO> {
    return this.t.json('POST', `/campaigns/${campaignId}/summary`);
  }
}

export class SuppressionsApi {
  constructor(private readonly t: Transport) {}

  list(query: { q?: string; reason?: SuppressionReason; includeLifted?: boolean } & PageQuery = {}): Promise<Page<SuppressionDTO>> {
    return this.t.json('GET', '/suppressions', { query: { ...query } });
  }
  add(input: { email: string; reason?: SuppressionReason; note?: string | null }): Promise<SuppressionDTO> {
    return this.t.json('POST', '/suppressions', { body: input });
  }
  lift(id: string, note: string): Promise<Ok> {
    return this.t.json('POST', `/suppressions/${id}/lift`, { body: { note } });
  }
}

export class SystemApi {
  constructor(private readonly t: Transport) {}

  health(): Promise<SystemHealthDTO> {
    return this.t.json('GET', '/system/health');
  }
  jobs(query: { status?: string; type?: string; limit?: number } = {}): Promise<Items<JobDTO>> {
    return this.t.json('GET', '/system/jobs', { query: { ...query } });
  }
  retryJob(id: string): Promise<Ok> {
    return this.t.json('POST', `/system/jobs/${id}/retry`);
  }
  cancelJob(id: string): Promise<Ok> {
    return this.t.json('POST', `/system/jobs/${id}/cancel`);
  }
}

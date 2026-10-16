import type { CampaignDTO, CampaignRecipientDTO, MessageCategory, MessageDetailDTO, MessageDTO, Page, PreflightDTO } from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, PageQuery } from '../types';

export interface CampaignInput {
  name?: string;
  description?: string | null;
  category?: MessageCategory;
  segmentId?: string | null;
  templateId?: string | null;
  /** Override the template subject for this campaign. */
  subject?: string | null;
  previewText?: string | null;
  senderId?: string | null;
  replyTo?: string | null;
  scheduledAt?: string | null;
  timezone?: string | null;
  requiresApproval?: boolean;
}

export class CampaignsApi {
  constructor(private readonly t: Transport) {}

  list(query: { status?: string } = {}): Promise<Items<CampaignDTO>> {
    return this.t.json('GET', '/campaigns', { query: { ...query } });
  }
  get(id: string): Promise<CampaignDTO> {
    return this.t.json('GET', `/campaigns/${id}`);
  }
  create(input: CampaignInput & { name: string }): Promise<CampaignDTO> {
    return this.t.json('POST', '/campaigns', { body: input });
  }
  update(id: string, input: CampaignInput): Promise<CampaignDTO> {
    return this.t.json('PATCH', `/campaigns/${id}`, { body: input });
  }
  delete(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/campaigns/${id}`);
  }
  duplicate(id: string): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/duplicate`);
  }
  /** Audience, exclusions with reasons, missing personalisation, blockers and warnings. */
  preflight(id: string): Promise<PreflightDTO> {
    return this.t.json('GET', `/campaigns/${id}/preflight`);
  }
  testSend(id: string, to?: string): Promise<{ messageId: string; to: string }> {
    return this.t.json('POST', `/campaigns/${id}/test`, { body: { to } });
  }
  schedule(id: string, input: { scheduledAt?: string | null; timezone?: string | null }): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/schedule`, { body: input });
  }
  /** Send now (or submit for approval when the workspace requires it). */
  launch(id: string): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/launch`);
  }
  approve(id: string, note?: string | null): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/approve`, { body: { note } });
  }
  reject(id: string, note: string): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/reject`, { body: { note } });
  }
  pause(id: string): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/pause`);
  }
  resume(id: string): Promise<CampaignDTO> {
    return this.t.json('POST', `/campaigns/${id}/resume`);
  }
  /** Cancel unsent messages. Already-sent e-mail cannot be recalled; the result says how many. */
  cancel(id: string): Promise<{ campaign: CampaignDTO; cancelledMessages: number; alreadySent: number }> {
    return this.t.json('POST', `/campaigns/${id}/cancel`);
  }
  recipients(id: string, query: { status?: string } & PageQuery = {}): Promise<Page<CampaignRecipientDTO>> {
    return this.t.json('GET', `/campaigns/${id}/recipients`, { query: { ...query } });
  }
}

export interface MessageListQuery extends PageQuery {
  status?: string;
  kind?: string;
  campaignId?: string;
  automationId?: string;
  contactId?: string;
  provider?: string;
  q?: string;
  from?: string;
  to?: string;
}

export class MessagesApi {
  constructor(private readonly t: Transport) {}

  list(query: MessageListQuery = {}): Promise<Page<MessageDTO>> {
    return this.t.json('GET', '/messages', { query: { ...query } });
  }
  get(id: string): Promise<MessageDetailDTO> {
    return this.t.json('GET', `/messages/${id}`);
  }
  cancel(id: string): Promise<{ cancelled: boolean; reason?: string }> {
    return this.t.json('POST', `/messages/${id}/cancel`);
  }
}

/** E-mail from automations in review mode waits here for a person to approve it. */
export class ApprovalsApi {
  constructor(private readonly t: Transport) {}

  list(query: { automationId?: string } & PageQuery = {}): Promise<Page<MessageDTO>> {
    return this.t.json('GET', '/approvals', { query: { ...query } });
  }
  approve(ids: string[]): Promise<{ approved: number }> {
    return this.t.json('POST', '/approvals/approve', { body: { ids } });
  }
  reject(ids: string[], note?: string): Promise<{ rejected: number }> {
    return this.t.json('POST', '/approvals/reject', { body: { ids, note } });
  }
}

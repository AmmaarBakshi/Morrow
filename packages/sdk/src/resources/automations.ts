import type { AutomationDefinition, AutomationDefinitionInput, AutomationDTO, AutomationRunDTO, DefinitionProblemDTO, DryRunResultDTO, Page } from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, PageQuery } from '../types';

export type AutomationWithProblems = AutomationDTO & { problems: DefinitionProblemDTO[] };

export class AutomationsApi {
  constructor(private readonly t: Transport) {}

  list(query: { status?: string } = {}): Promise<Items<AutomationDTO>> {
    return this.t.json('GET', '/automations', { query: { ...query } });
  }
  get(id: string): Promise<AutomationWithProblems> {
    return this.t.json('GET', `/automations/${id}`);
  }
  create(input: { name: string; description?: string | null; definition: AutomationDefinitionInput }): Promise<AutomationDTO> {
    return this.t.json('POST', '/automations', { body: input });
  }
  /** Changing the definition creates a new version; running contacts finish on theirs. */
  update(id: string, input: { name?: string; description?: string | null; definition?: AutomationDefinitionInput }): Promise<AutomationDTO> {
    return this.t.json('PATCH', `/automations/${id}`, { body: input });
  }
  validate(definition: AutomationDefinitionInput): Promise<{ definition: AutomationDefinition; problems: DefinitionProblemDTO[] }> {
    return this.t.json('POST', '/automations/validate', { body: { definition } });
  }
  /** `auto` sends without review and needs the automations:approve_auto permission. */
  activate(id: string, deliveryMode?: 'review' | 'auto'): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/activate`, { body: { deliveryMode } });
  }
  setDeliveryMode(id: string, mode: 'review' | 'auto'): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/delivery-mode`, { body: { mode } });
  }
  pause(id: string): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/pause`);
  }
  resume(id: string): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/resume`);
  }
  archive(id: string): Promise<Ok> {
    return this.t.json('POST', `/automations/${id}/archive`);
  }
  restore(id: string): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/restore`);
  }
  duplicate(id: string): Promise<AutomationDTO> {
    return this.t.json('POST', `/automations/${id}/duplicate`);
  }
  /** Simulate at a moment in time, optionally with an unsaved definition. Writes nothing. */
  dryRun(id: string, input: { at?: string; contactIds?: string[]; limit?: number; definition?: AutomationDefinitionInput } = {}): Promise<DryRunResultDTO> {
    return this.t.json('POST', `/automations/${id}/dry-run`, { body: input });
  }
  run(id: string, input: { contactIds?: string[]; segmentId?: string | null }): Promise<{ started: number; queued: boolean; eventKey: string }> {
    return this.t.json('POST', `/automations/${id}/run`, { body: input });
  }
  runs(id: string, query: { status?: string } & PageQuery = {}): Promise<Page<AutomationRunDTO>> {
    return this.t.json('GET', `/automations/${id}/runs`, { query: { ...query } });
  }
  getRun(runId: string): Promise<AutomationRunDTO> {
    return this.t.json('GET', `/automation-runs/${runId}`);
  }
  cancelRun(runId: string): Promise<Ok> {
    return this.t.json('POST', `/automation-runs/${runId}/cancel`);
  }
}

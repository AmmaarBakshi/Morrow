import type { MessageCategory, RenderedEmailDTO, SnippetDTO, TemplateDTO, TemplatePurpose, TemplateSummaryDTO, TemplateVersionDTO, VariableDefinition } from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok } from '../types';

export interface TemplateContent {
  subject?: string;
  previewText?: string | null;
  html?: string;
  text?: string | null;
  missingPolicy?: 'fallback' | 'skip';
}

export interface TemplateMeta {
  name?: string;
  description?: string | null;
  category?: MessageCategory;
  purpose?: TemplatePurpose;
}

export type SavedTemplate = TemplateDTO & { warnings: string[] };

export class TemplatesApi {
  constructor(private readonly t: Transport) {}

  list(query: { status?: string; purpose?: TemplatePurpose; category?: MessageCategory; q?: string } = {}): Promise<Items<TemplateSummaryDTO>> {
    return this.t.json('GET', '/templates', { query: { ...query } });
  }
  get(id: string): Promise<TemplateDTO> {
    return this.t.json('GET', `/templates/${id}`);
  }
  create(input: TemplateContent & TemplateMeta & { name: string }): Promise<SavedTemplate> {
    return this.t.json('POST', '/templates', { body: input });
  }
  /** Editing a published template creates a new draft; the published version keeps sending. */
  update(id: string, input: TemplateContent & TemplateMeta): Promise<SavedTemplate> {
    return this.t.json('PATCH', `/templates/${id}`, { body: input });
  }
  publish(id: string): Promise<TemplateDTO> {
    return this.t.json('POST', `/templates/${id}/publish`);
  }
  versions(id: string): Promise<Items<TemplateVersionDTO>> {
    return this.t.json('GET', `/templates/${id}/versions`);
  }
  restoreVersion(id: string, versionId: string): Promise<TemplateDTO> {
    return this.t.json('POST', `/templates/${id}/versions/${versionId}/restore`);
  }
  duplicate(id: string): Promise<TemplateDTO> {
    return this.t.json('POST', `/templates/${id}/duplicate`);
  }
  archive(id: string): Promise<Ok> {
    return this.t.json('POST', `/templates/${id}/archive`);
  }
  restore(id: string): Promise<TemplateDTO> {
    return this.t.json('POST', `/templates/${id}/restore`);
  }
  render(id: string, input: { which?: 'draft' | 'published'; versionId?: string; contactId?: string | null } = {}): Promise<RenderedEmailDTO> {
    return this.t.json('POST', `/templates/${id}/render`, { body: input });
  }
  /** Render unsaved content (live preview). */
  renderContent(input: Required<Pick<TemplateContent, 'subject' | 'html'>> & TemplateContent & { category?: MessageCategory; contactId?: string | null; data?: Record<string, unknown> }): Promise<RenderedEmailDTO> {
    return this.t.json('POST', '/templates/render', { body: input });
  }
  /** Send a test to a workspace member (yourself by default). */
  testSend(id: string, input: { to?: string; contactId?: string | null; which?: 'draft' | 'published' } = {}): Promise<{ messageId: string; to: string }> {
    return this.t.json('POST', `/templates/${id}/test`, { body: input });
  }
  variables(): Promise<Items<VariableDefinition>> {
    return this.t.json('GET', '/variables');
  }
}

export class SnippetsApi {
  constructor(private readonly t: Transport) {}

  list(): Promise<Items<SnippetDTO>> {
    return this.t.json('GET', '/snippets');
  }
  create(input: { key: string; name: string; kind?: SnippetDTO['kind']; html: string; text?: string | null }): Promise<SnippetDTO> {
    return this.t.json('POST', '/snippets', { body: input });
  }
  update(id: string, input: { name?: string; html?: string; text?: string | null }): Promise<SnippetDTO> {
    return this.t.json('PATCH', `/snippets/${id}`, { body: input });
  }
  delete(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/snippets/${id}`);
  }
}

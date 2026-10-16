import type {
  ConsentEventDTO,
  ConsentStatus,
  ContactCreateInput,
  ContactDTO,
  CriteriaGroup,
  CustomFieldDTO,
  CustomFieldType,
  NoteDTO,
  Page,
  TagDTO,
  TimelineItemDTO,
  UpcomingOccasionDTO,
} from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, PageQuery } from '../types';

export interface ContactListQuery extends PageQuery {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  relationshipType?: string;
  tag?: string;
  consent?: ConsentStatus;
  segmentId?: string;
  hasBirthday?: boolean;
  sort?: 'created_at' | 'name' | 'email' | 'last_interaction_at' | 'last_emailed_at' | 'company';
  dir?: 'asc' | 'desc';
}

export interface RecordEventInput {
  /** Identify the contact by ID or e-mail (with `contact` to create them if missing). */
  contactId?: string;
  email?: string;
  name: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;
  /** Repeat-safe: the same key is only recorded once. */
  dedupeKey?: string;
  contact?: ContactCreateInput;
  /** Counts as an interaction (updates "last interaction"). */
  interaction?: boolean;
}

export interface RecordEventResult {
  eventId: string;
  contactId: string;
  duplicate: boolean;
  contactCreated: boolean;
}

export class ContactsApi {
  constructor(private readonly t: Transport) {}

  list(query: ContactListQuery = {}): Promise<Page<ContactDTO>> {
    return this.t.json('GET', '/contacts', { query: { ...query } });
  }

  /** Filter with the full segment criteria language. */
  search(criteria: CriteriaGroup, query: ContactListQuery = {}): Promise<Page<ContactDTO>> {
    return this.t.json('POST', '/contacts/search', { body: { ...query, criteria } });
  }

  /** Iterate every matching contact, page by page. */
  async *all(query: ContactListQuery = {}): AsyncGenerator<ContactDTO> {
    let page = 1;
    for (;;) {
      const res = await this.list({ ...query, page, pageSize: query.pageSize ?? 200 });
      yield* res.items;
      if (res.items.length === 0 || page * res.pageSize >= res.total) return;
      page += 1;
    }
  }

  get(id: string): Promise<ContactDTO> {
    return this.t.json('GET', `/contacts/${id}`);
  }

  create(input: ContactCreateInput): Promise<ContactDTO> {
    return this.t.json('POST', '/contacts', { body: input });
  }

  update(id: string, input: Partial<ContactCreateInput>): Promise<ContactDTO> {
    return this.t.json('PATCH', `/contacts/${id}`, { body: input });
  }

  archive(id: string): Promise<ContactDTO> {
    return this.t.json('POST', `/contacts/${id}/archive`);
  }

  restore(id: string): Promise<ContactDTO> {
    return this.t.json('POST', `/contacts/${id}/restore`);
  }

  /** Permanently erase personal data. Irreversible. */
  erase(id: string): Promise<Ok> {
    return this.t.json('POST', `/contacts/${id}/erase`, { body: { confirm: 'erase' } });
  }

  bulk(input: { ids: string[]; action: 'archive' | 'restore' | 'add_tag' | 'remove_tag'; tag?: string }): Promise<{ affected: number }> {
    return this.t.json('POST', '/contacts/bulk', { body: input });
  }

  /** CSV with the same filters as `list`. */
  exportCsv(query: ContactListQuery = {}): Promise<string> {
    return this.t.text('GET', '/contacts/export', { query: { ...query } });
  }

  setConsent(id: string, input: { status: ConsentStatus; source?: string | null; note?: string | null }): Promise<ContactDTO> {
    return this.t.json('PUT', `/contacts/${id}/consent`, { body: input });
  }

  consentHistory(id: string): Promise<Items<ConsentEventDTO>> {
    return this.t.json('GET', `/contacts/${id}/consent`);
  }

  notes(id: string): Promise<Items<NoteDTO>> {
    return this.t.json('GET', `/contacts/${id}/notes`);
  }

  addNote(id: string, body: string): Promise<NoteDTO> {
    return this.t.json('POST', `/contacts/${id}/notes`, { body: { body } });
  }

  deleteNote(id: string, noteId: string): Promise<Ok> {
    return this.t.json('DELETE', `/contacts/${id}/notes/${noteId}`);
  }

  timeline(id: string, limit?: number): Promise<Items<TimelineItemDTO>> {
    return this.t.json('GET', `/contacts/${id}/timeline`, { query: { limit } });
  }

  upcomingOccasions(query: { days?: number; kinds?: Array<'birthday' | 'work_anniversary'>; limit?: number } = {}): Promise<Items<UpcomingOccasionDTO>> {
    return this.t.json('GET', '/occasions/upcoming', { query: { ...query } });
  }
}

export class EventsApi {
  constructor(private readonly t: Transport) {}

  /** Record a custom event such as `proposal.sent`; event-triggered automations react to it. */
  record(input: RecordEventInput): Promise<RecordEventResult> {
    return this.t.json('POST', '/events', { body: input });
  }
}

export class TagsApi {
  constructor(private readonly t: Transport) {}

  list(): Promise<Items<TagDTO>> {
    return this.t.json('GET', '/tags');
  }
  create(input: { name: string; color?: string | null }): Promise<TagDTO> {
    return this.t.json('POST', '/tags', { body: input });
  }
  update(id: string, input: { name?: string; color?: string | null }): Promise<TagDTO> {
    return this.t.json('PATCH', `/tags/${id}`, { body: input });
  }
  delete(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/tags/${id}`);
  }
}

export class FieldsApi {
  constructor(private readonly t: Transport) {}

  list(includeArchived = false): Promise<Items<CustomFieldDTO>> {
    return this.t.json('GET', '/fields', { query: { includeArchived: includeArchived || undefined } });
  }
  create(input: { key: string; label: string; type: CustomFieldType; options?: string[] }): Promise<CustomFieldDTO> {
    return this.t.json('POST', '/fields', { body: input });
  }
  update(id: string, input: { label?: string; options?: string[] }): Promise<CustomFieldDTO> {
    return this.t.json('PATCH', `/fields/${id}`, { body: input });
  }
  archive(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/fields/${id}`);
  }
}

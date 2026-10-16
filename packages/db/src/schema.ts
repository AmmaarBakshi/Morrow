/**
 * Kysely table types. Conventions (identical on SQLite and PostgreSQL):
 *   - IDs are prefixed text IDs (see @morrow/core ids)
 *   - timestamps are ISO-8601 UTC strings
 *   - booleans are integers (0/1)
 *   - JSON is stored as text and parsed in the service layer
 */
import type { Insertable, Selectable, Updateable } from 'kysely';

type Ts = string;
type Json = string;
type Bool = number;

// ---------------------------------------------------------------- identity

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  created_at: Ts;
  updated_at: Ts;
  last_login_at: Ts | null;
}

export interface WorkspacesTable {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  settings: Json;
  created_at: Ts;
  updated_at: Ts;
}

export interface MembershipsTable {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: Ts;
}

export interface InvitationsTable {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: Ts;
  accepted_at: Ts | null;
  revoked_at: Ts | null;
  created_at: Ts;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  workspace_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Ts;
  last_seen_at: Ts;
  expires_at: Ts;
}

export interface ApiKeysTable {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  role: string;
  created_by: string | null;
  last_used_at: Ts | null;
  expires_at: Ts | null;
  revoked_at: Ts | null;
  created_at: Ts;
}

export interface AuditLogsTable {
  id: string;
  workspace_id: string;
  actor_type: string; // user | api_key | system
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  ip: string | null;
  created_at: Ts;
}

// ---------------------------------------------------------------- contacts

export interface ContactsTable {
  id: string;
  workspace_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_normalized: string | null;
  /** unknown | valid | invalid | bounced | complained */
  email_status: string;
  company: string | null;
  job_title: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birth_year: number | null;
  /** month * 100 + day, indexed for calendar lookups */
  birthday_md: number | null;
  work_anniversary: string | null;
  anniversary_md: number | null;
  relationship_type: string;
  interests: Json;
  preferences: Json;
  language: string | null;
  timezone: string | null;
  source: string | null;
  consent_status: string;
  consent_updated_at: Ts | null;
  consent_source: string | null;
  status: string; // active | archived
  archived_at: Ts | null;
  last_interaction_at: Ts | null;
  last_emailed_at: Ts | null;
  /** Lower-cased name, e-mail and company for search. */
  search_text: string;
  created_at: Ts;
  updated_at: Ts;
}

export interface ContactNotesTable {
  id: string;
  workspace_id: string;
  contact_id: string;
  author_id: string | null;
  body: string;
  created_at: Ts;
}

export interface ContactEventsTable {
  id: string;
  workspace_id: string;
  contact_id: string;
  name: string;
  properties: Json;
  source: string | null;
  dedupe_key: string | null;
  occurred_at: Ts;
  created_at: Ts;
}

export interface TagsTable {
  id: string;
  workspace_id: string;
  name: string;
  name_normalized: string;
  color: string | null;
  created_at: Ts;
}

export interface ContactTagsTable {
  workspace_id: string;
  contact_id: string;
  tag_id: string;
  created_at: Ts;
}

export interface CustomFieldsTable {
  id: string;
  workspace_id: string;
  key: string;
  label: string;
  type: string; // text | number | date | boolean | select | url
  options: Json | null;
  created_at: Ts;
  archived_at: Ts | null;
}

export interface ContactFieldValuesTable {
  workspace_id: string;
  contact_id: string;
  field_id: string;
  value_text: string | null;
  value_number: number | null;
  updated_at: Ts;
}

export interface ConsentEventsTable {
  id: string;
  workspace_id: string;
  contact_id: string;
  from_status: string | null;
  to_status: string;
  source: string;
  actor_type: string;
  actor_id: string | null;
  ip: string | null;
  note: string | null;
  created_at: Ts;
}

export interface SuppressionsTable {
  id: string;
  workspace_id: string;
  email_normalized: string;
  reason: string;
  scope: string; // marketing | all
  source: string | null;
  message_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Ts;
  lifted_at: Ts | null;
  lifted_by: string | null;
}

export interface ImportsTable {
  id: string;
  workspace_id: string;
  filename: string;
  status: string; // uploaded | committed | failed
  headers: Json;
  sample: Json;
  mapping: Json | null;
  options: Json | null;
  row_count: number;
  csv: string | null;
  summary: Json | null;
  report: Json | null;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
  committed_at: Ts | null;
}

// ---------------------------------------------------------------- segments

export interface SegmentsTable {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  criteria: Json;
  created_by: string | null;
  cached_count: number | null;
  cached_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
}

export interface SegmentMembershipsTable {
  workspace_id: string;
  segment_id: string;
  contact_id: string;
  entered_at: Ts;
}

// ---------------------------------------------------------------- content

export interface SnippetsTable {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  kind: string; // header | footer | signature | custom
  html: string;
  text: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface TemplatesTable {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  category: string;
  purpose: string;
  status: string; // draft | published | archived
  draft_version_id: string | null;
  published_version_id: string | null;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
}

export interface TemplateVersionsTable {
  id: string;
  workspace_id: string;
  template_id: string;
  version: number;
  subject: string;
  preview_text: string | null;
  html: string;
  text: string | null;
  /** fallback | skip — what to do when a recipient lacks a required variable */
  missing_policy: string;
  created_by: string | null;
  created_at: Ts;
  published_at: Ts | null;
}

export interface SendersTable {
  id: string;
  workspace_id: string;
  name: string;
  email: string;
  reply_to: string | null;
  domain: string;
  status: string; // pending | verified
  verification_token_hash: string | null;
  verification_sent_at: Ts | null;
  verified_at: Ts | null;
  is_default: Bool;
  created_at: Ts;
  updated_at: Ts;
}

export interface IntegrationsTable {
  id: string;
  workspace_id: string;
  kind: string; // email | ai
  provider: string;
  config: Json;
  secrets: string | null; // AES-256-GCM ciphertext
  webhook_secret: string | null; // AES-256-GCM ciphertext
  status: string; // unconfigured | ok | error
  last_tested_at: Ts | null;
  last_test_result: string | null;
  created_at: Ts;
  updated_at: Ts;
}

// ---------------------------------------------------------------- messaging

export interface MessagesTable {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  campaign_id: string | null;
  automation_id: string | null;
  automation_run_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  kind: string; // campaign | automation | test | system
  category: string;
  idempotency_key: string;
  to_email: string;
  from_email: string;
  from_name: string | null;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Json;
  /** queued | pending_approval | sending | sent | delivered | bounced | failed | rejected | complained | suppressed | cancelled | uncertain */
  status: string;
  approval_status: string; // not_required | pending | approved | rejected
  approved_by: string | null;
  approved_at: Ts | null;
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  error_class: string | null; // transient | permanent
  scheduled_for: Ts | null;
  queued_at: Ts | null;
  sent_at: Ts | null;
  delivered_at: Ts | null;
  bounced_at: Ts | null;
  bounce_type: string | null; // hard | soft
  complained_at: Ts | null;
  opened_at: Ts | null;
  clicked_at: Ts | null;
  unsubscribed_at: Ts | null;
  failed_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MessageEventsTable {
  id: string;
  workspace_id: string;
  message_id: string;
  type: string;
  provider: string | null;
  provider_event_id: string | null;
  occurred_at: Ts;
  data: Json;
  created_at: Ts;
}

export interface WebhookEventsTable {
  id: string;
  workspace_id: string | null;
  integration_id: string | null;
  provider: string;
  signature_valid: Bool;
  payload: string;
  received_at: Ts;
  processed_at: Ts | null;
  error: string | null;
}

export interface JobsTable {
  id: string;
  workspace_id: string | null;
  type: string;
  payload: Json;
  status: string; // queued | running | succeeded | failed | dead | cancelled
  priority: number;
  run_at: Ts;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  locked_by: string | null;
  locked_until: Ts | null;
  last_error: string | null;
  created_at: Ts;
  updated_at: Ts;
  finished_at: Ts | null;
}

// ---------------------------------------------------------------- automation

export interface AutomationsTable {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string; // draft | active | paused | archived
  trigger_type: string;
  current_version_id: string | null;
  delivery_mode: string; // review | auto
  auto_approved_by: string | null;
  auto_approved_at: Ts | null;
  activated_at: Ts | null;
  last_triggered_at: Ts | null;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface AutomationVersionsTable {
  id: string;
  workspace_id: string;
  automation_id: string;
  version: number;
  definition: Json;
  created_by: string | null;
  created_at: Ts;
}

export interface AutomationRunsTable {
  id: string;
  workspace_id: string;
  automation_id: string;
  version_id: string;
  contact_id: string;
  event_key: string;
  event_data: Json;
  /** running | waiting | completed | skipped | failed | cancelled */
  status: string;
  cursor: string | null;
  resume_at: Ts | null;
  error: string | null;
  started_at: Ts;
  updated_at: Ts;
  completed_at: Ts | null;
}

export interface AutomationRunStepsTable {
  id: string;
  workspace_id: string;
  run_id: string;
  step_id: string;
  step_type: string;
  status: string; // ok | skipped | waiting | failed
  detail: string | null;
  created_at: Ts;
}

// ---------------------------------------------------------------- campaigns

export interface CampaignsTable {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  /** draft | pending_approval | scheduled | sending | paused | completed | cancelled | failed */
  status: string;
  category: string;
  segment_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  subject: string | null;
  preview_text: string | null;
  sender_id: string | null;
  reply_to: string | null;
  scheduled_at: Ts | null;
  timezone: string | null;
  requires_approval: Bool;
  approval_status: string; // not_required | pending | approved | rejected
  approval_note: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  approved_at: Ts | null;
  launched_at: Ts | null;
  paused_at: Ts | null;
  completed_at: Ts | null;
  cancelled_at: Ts | null;
  dispatch_cursor: string | null;
  recipient_count: number | null;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface CampaignRecipientsTable {
  workspace_id: string;
  campaign_id: string;
  contact_id: string;
  status: string; // queued | skipped | cancelled
  skip_reason: string | null;
  message_id: string | null;
  created_at: Ts;
}

// ---------------------------------------------------------------- workflow

export interface TasksTable {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  title: string;
  description: string | null;
  status: string; // open | done | dismissed
  due_at: Ts | null;
  assignee_id: string | null;
  source: string; // manual | automation
  automation_run_id: string | null;
  dedupe_key: string | null;
  created_by: string | null;
  created_at: Ts;
  updated_at: Ts;
  completed_at: Ts | null;
}

export interface NotificationsTable {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  dedupe_key: string | null;
  read_at: Ts | null;
  created_at: Ts;
}

export interface SchedulerStateTable {
  key: string;
  value: string;
  updated_at: Ts;
}

export interface Database {
  users: UsersTable;
  workspaces: WorkspacesTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  sessions: SessionsTable;
  api_keys: ApiKeysTable;
  audit_logs: AuditLogsTable;
  contacts: ContactsTable;
  contact_notes: ContactNotesTable;
  contact_events: ContactEventsTable;
  tags: TagsTable;
  contact_tags: ContactTagsTable;
  custom_fields: CustomFieldsTable;
  contact_field_values: ContactFieldValuesTable;
  consent_events: ConsentEventsTable;
  suppressions: SuppressionsTable;
  imports: ImportsTable;
  segments: SegmentsTable;
  segment_memberships: SegmentMembershipsTable;
  snippets: SnippetsTable;
  templates: TemplatesTable;
  template_versions: TemplateVersionsTable;
  senders: SendersTable;
  integrations: IntegrationsTable;
  messages: MessagesTable;
  message_events: MessageEventsTable;
  webhook_events: WebhookEventsTable;
  jobs: JobsTable;
  automations: AutomationsTable;
  automation_versions: AutomationVersionsTable;
  automation_runs: AutomationRunsTable;
  automation_run_steps: AutomationRunStepsTable;
  campaigns: CampaignsTable;
  campaign_recipients: CampaignRecipientsTable;
  tasks: TasksTable;
  notifications: NotificationsTable;
  scheduler_state: SchedulerStateTable;
}

export type TableName = keyof Database;
export type Row<T extends TableName> = Selectable<Database[T]>;
export type NewRow<T extends TableName> = Insertable<Database[T]>;
export type RowUpdate<T extends TableName> = Updateable<Database[T]>;

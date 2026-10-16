/**
 * Data transfer objects: the JSON shapes returned by the Morrow API.
 * Shared by the engine (producer), the SDK, the CLI and the web app.
 */
import type { MessageCounts, MessageRates, ProviderReporting } from './analytics';
import type { AutomationDefinition } from './automations';
import type { ConsentStatus, IneligibleReason, MessageCategory, SuppressionReason, SuppressionScope } from './consent';
import type { RelationshipType } from './contacts';
import type { ImportTarget } from './imports';
import type { Permission, Role } from './permissions';
import type { CriteriaGroup } from './segments';
import type { WorkspaceSettings } from './settings';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ------------------------------------------------------------ identity

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummaryDTO {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface SessionInfoDTO {
  user: UserDTO;
  workspace: WorkspaceDTO | null;
  workspaces: WorkspaceSummaryDTO[];
  role: Role | null;
  permissions: Permission[];
  csrfToken: string;
}

export interface MemberDTO {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface InvitationDTO {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  /** Only returned once, when the invitation is created. */
  acceptUrl?: string;
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKeyDTO extends ApiKeyDTO {
  /** The full key. Shown once; Morrow only stores a hash. */
  key: string;
}

export interface AuditLogDTO {
  id: string;
  actorType: string;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

// ------------------------------------------------------------ contacts

export interface TagDTO {
  id: string;
  name: string;
  color: string | null;
  contactCount?: number;
}

export interface CustomFieldDTO {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'url';
  options: string[] | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface ContactDTO {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string | null;
  emailStatus: string;
  company: string | null;
  jobTitle: string | null;
  birthday: { month: number; day: number; year: number | null } | null;
  workAnniversary: string | null;
  relationshipType: RelationshipType;
  interests: string[];
  preferences: { frequency?: 'normal' | 'reduced' | 'minimal'; topics?: string[] };
  language: string | null;
  timezone: string | null;
  source: string | null;
  consentStatus: ConsentStatus;
  consentUpdatedAt: string | null;
  consentSource: string | null;
  status: 'active' | 'archived';
  archivedAt: string | null;
  lastInteractionAt: string | null;
  lastEmailedAt: string | null;
  tags: TagDTO[];
  customFields: Record<string, string | number | boolean | null>;
  suppression: { reason: SuppressionReason; scope: SuppressionScope; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
}

export interface TimelineItemDTO {
  id: string;
  type: 'message' | 'event' | 'note' | 'consent' | 'task' | 'automation' | 'created';
  at: string;
  title: string;
  detail?: string | null;
  status?: string | null;
  link?: string | null;
}

export interface ConsentEventDTO {
  id: string;
  fromStatus: ConsentStatus | null;
  toStatus: ConsentStatus;
  source: string;
  actorType: string;
  note: string | null;
  createdAt: string;
}

export interface UpcomingOccasionDTO {
  contactId: string;
  name: string;
  email: string | null;
  kind: 'birthday' | 'work_anniversary';
  date: string;
  daysAway: number;
  years: number | null;
  relationshipType: RelationshipType;
}

// ------------------------------------------------------------ segments & imports

export interface SegmentDTO {
  id: string;
  name: string;
  description: string | null;
  criteria: CriteriaGroup;
  summary: string;
  count: number | null;
  countedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactPreviewDTO {
  id: string;
  name: string;
  email: string | null;
  relationshipType: RelationshipType;
  consentStatus: ConsentStatus;
}

export interface SegmentPreviewDTO {
  count: number;
  sample: ContactPreviewDTO[];
}

export type DuplicateStrategy = 'skip' | 'update_empty' | 'overwrite';

export interface ImportOptionsDTO {
  duplicateStrategy: DuplicateStrategy;
  dateOrder: 'DMY' | 'MDY' | 'YMD';
  addTags: string[];
  defaultRelationship: RelationshipType;
  defaultConsent: ConsentStatus;
  consentSource: string | null;
}

export interface ImportDTO {
  id: string;
  filename: string;
  status: 'uploaded' | 'committed' | 'failed';
  headers: string[];
  sample: string[][];
  suggestedMapping: ImportTarget[];
  rowCount: number;
  createdAt: string;
  committedAt: string | null;
  report: ImportReportDTO | null;
}

export interface ImportRowIssueDTO {
  row: number;
  email: string | null;
  errors: string[];
  warnings: string[];
  action: 'create' | 'update' | 'skip' | 'invalid';
  conflicts?: string[];
}

export interface ImportPreviewDTO {
  total: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  existing: number;
  conflicts: number;
  suppressed: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  issues: ImportRowIssueDTO[];
}

export interface ImportReportDTO extends ImportPreviewDTO {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  finishedAt: string;
}

// ------------------------------------------------------------ content

export interface TemplateVersionDTO {
  id: string;
  version: number;
  subject: string;
  previewText: string | null;
  html: string;
  text: string | null;
  missingPolicy: 'fallback' | 'skip';
  createdAt: string;
  publishedAt: string | null;
}

export type TemplatePurpose =
  | 'birthday'
  | 'welcome'
  | 'follow_up'
  | 'newsletter'
  | 'announcement'
  | 'collaboration'
  | 'work_anniversary'
  | 're_engagement'
  | 'project_completion'
  | 'feedback'
  | 'custom';

export interface TemplateSummaryDTO {
  id: string;
  name: string;
  description: string | null;
  category: MessageCategory;
  purpose: TemplatePurpose;
  status: 'draft' | 'published' | 'archived';
  subject: string;
  version: number;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
}

export interface TemplateDTO extends TemplateSummaryDTO {
  draft: TemplateVersionDTO;
  published: TemplateVersionDTO | null;
  createdAt: string;
}

export interface TemplateIssueDTO {
  field: 'subject' | 'previewText' | 'html' | 'text';
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

export interface RenderedEmailDTO {
  subject: string;
  previewText: string;
  html: string;
  text: string;
  missing: string[];
  fallbacksUsed: string[];
  warnings: string[];
  issues: TemplateIssueDTO[];
  eligibility?: { eligible: boolean; reasons: IneligibleReason[] } | null;
}

export interface SnippetDTO {
  id: string;
  key: string;
  name: string;
  kind: 'header' | 'footer' | 'signature' | 'custom';
  html: string;
  text: string | null;
  updatedAt: string;
}

export interface SenderDTO {
  id: string;
  name: string;
  email: string;
  replyTo: string | null;
  domain: string;
  status: 'pending' | 'verified';
  verifiedAt: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface DnsRecordCheckDTO {
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  record: string | null;
  message: string;
}

export interface DnsCheckDTO {
  domain: string;
  checkedAt: string;
  mx: DnsRecordCheckDTO;
  spf: DnsRecordCheckDTO;
  dmarc: DnsRecordCheckDTO;
  dkim: Array<DnsRecordCheckDTO & { selector: string }>;
}

export interface ProviderFieldDTO {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select';
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  defaultValue?: string | number | boolean;
}

export interface ProviderInfoDTO {
  name: string;
  label: string;
  description: string;
  docsUrl?: string;
  developmentOnly: boolean;
  fields: ProviderFieldDTO[];
  webhook: { supported: boolean; instructions: string };
}

export interface ProviderCapabilitiesDTO {
  deliveryEvents: boolean;
  bounceEvents: boolean;
  complaintEvents: boolean;
  openTracking: boolean;
  clickTracking: boolean;
  idempotencyKeys: boolean;
  webhooks: boolean;
  customHeaders: boolean;
}

export interface EmailIntegrationDTO {
  source: 'workspace' | 'environment' | 'none';
  provider: string | null;
  providerLabel: string | null;
  config: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  status: 'unconfigured' | 'ok' | 'error';
  lastTestedAt: string | null;
  lastTestResult: string | null;
  webhookUrl: string | null;
  capabilities: ProviderCapabilitiesDTO | null;
  providers: ProviderInfoDTO[];
}

export interface SuppressionDTO {
  id: string;
  email: string;
  reason: SuppressionReason;
  scope: SuppressionScope;
  source: string | null;
  note: string | null;
  createdAt: string;
  liftedAt: string | null;
}

// ------------------------------------------------------------ messages

export type MessageStatus =
  | 'queued'
  | 'pending_approval'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'failed'
  | 'rejected'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'uncertain';

export interface MessageDTO {
  id: string;
  contactId: string | null;
  contactName: string | null;
  campaignId: string | null;
  automationId: string | null;
  automationRunId: string | null;
  templateId: string | null;
  kind: 'campaign' | 'automation' | 'test' | 'system';
  category: MessageCategory;
  toEmail: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  status: MessageStatus;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  provider: string | null;
  providerMessageId: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  errorClass: 'transient' | 'permanent' | null;
  scheduledFor: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  bounceType: 'hard' | 'soft' | null;
  complainedAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface MessageEventDTO {
  id: string;
  type: string;
  provider: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface MessageDetailDTO extends MessageDTO {
  html: string | null;
  text: string | null;
  events: MessageEventDTO[];
}

// ------------------------------------------------------------ automations

export interface AutomationStatsDTO {
  runs: number;
  active: number;
  completed: number;
  skipped: number;
  failed: number;
  messages: number;
  pendingApproval: number;
}

export interface AutomationDTO {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  triggerType: string;
  triggerSummary: string;
  deliveryMode: 'review' | 'auto';
  autoApprovedBy: string | null;
  autoApprovedAt: string | null;
  activatedAt: string | null;
  lastTriggeredAt: string | null;
  version: number;
  versionId: string | null;
  definition: AutomationDefinition;
  stats: AutomationStatsDTO;
  createdAt: string;
  updatedAt: string;
}

export interface RunStepDTO {
  id: string;
  stepId: string;
  stepType: string;
  status: 'ok' | 'skipped' | 'waiting' | 'failed';
  detail: string | null;
  createdAt: string;
}

export interface AutomationRunDTO {
  id: string;
  automationId: string;
  automationName?: string;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  eventKey: string;
  status: 'running' | 'waiting' | 'completed' | 'skipped' | 'failed' | 'cancelled';
  cursor: string | null;
  resumeAt: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  steps?: RunStepDTO[];
}

export interface DryRunStepDTO {
  stepId: string;
  type: string;
  outcome: 'would_run' | 'would_skip' | 'would_wait' | 'would_end' | 'blocked';
  detail: string;
  email?: { subject: string; previewText: string; html: string; text: string; missing: string[]; to: string; category: MessageCategory };
}

export interface DryRunContactDTO {
  contact: { id: string; name: string; email: string | null };
  eventKey: string;
  qualified: boolean;
  reasons: string[];
  steps: DryRunStepDTO[];
}

export interface DryRunResultDTO {
  simulatedAt: string;
  triggerSummary: string;
  candidates: number;
  qualified: number;
  truncated: boolean;
  results: DryRunContactDTO[];
}

// ------------------------------------------------------------ campaigns & analytics

export interface CampaignStatsDTO {
  counts: MessageCounts;
  rates: MessageRates;
  reporting: ProviderReporting;
}

export type CampaignStatus = 'draft' | 'pending_approval' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface CampaignDTO {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  category: MessageCategory;
  segmentId: string | null;
  segmentName: string | null;
  templateId: string | null;
  templateName: string | null;
  templateVersionId: string | null;
  subject: string | null;
  previewText: string | null;
  senderId: string | null;
  sender: SenderDTO | null;
  replyTo: string | null;
  scheduledAt: string | null;
  timezone: string | null;
  requiresApproval: boolean;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  approvalNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  launchedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  recipientCount: number | null;
  stats: CampaignStatsDTO;
  createdAt: string;
  updatedAt: string;
}

export interface PreflightDTO {
  ok: boolean;
  audience: number;
  eligible: number;
  excluded: Partial<Record<IneligibleReason | 'frequency_cap' | 'duplicate', number>>;
  missingPersonalization: Array<{ variable: string; contacts: number; handledBy: 'fallback' | 'skip' | 'blank' }>;
  blockers: string[];
  warnings: string[];
  sample: ContactPreviewDTO[];
}

export interface CampaignRecipientDTO {
  contactId: string;
  name: string;
  email: string | null;
  status: string;
  skipReason: string | null;
  messageId: string | null;
  messageStatus: MessageStatus | null;
}

export interface AnalyticsOverviewDTO {
  from: string;
  to: string;
  counts: MessageCounts;
  rates: MessageRates;
  reporting: ProviderReporting;
  openDisclaimer: string;
}

export interface TimeseriesPointDTO {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  opened: number;
  clicked: number;
  complained: number;
  unsubscribed: number;
}

export interface CampaignComparisonDTO {
  id: string;
  name: string;
  status: CampaignStatus;
  launchedAt: string | null;
  counts: MessageCounts;
  rates: MessageRates;
}

export interface AutomationPerformanceDTO {
  id: string;
  name: string;
  status: string;
  triggerType: string;
  counts: MessageCounts;
  rates: MessageRates;
}

export interface FailureReasonDTO {
  reason: string;
  errorClass: string | null;
  status: string;
  count: number;
  lastAt: string;
}

// ------------------------------------------------------------ workflow & ops

export interface TaskDTO {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'done' | 'dismissed';
  dueAt: string | null;
  contactId: string | null;
  contactName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  source: 'manual' | 'automation';
  automationRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface CalendarEventDTO {
  id: string;
  date: string;
  time: string | null;
  kind: 'birthday' | 'work_anniversary' | 'campaign' | 'automation' | 'task' | 'resume';
  title: string;
  subtitle: string | null;
  link: string | null;
}

export interface DashboardDTO {
  range: { from: string; to: string };
  contacts: { total: number; active: number; marketingEligible: number; newInRange: number; withBirthday: number };
  messages: { counts: MessageCounts; rates: MessageRates; reporting: ProviderReporting };
  upcomingOccasions: UpcomingOccasionDTO[];
  scheduled: Array<{ kind: 'campaign' | 'automation_resume'; id: string; title: string; at: string; link: string }>;
  automations: { active: number; paused: number; draft: number };
  recentCampaigns: CampaignComparisonDTO[];
  failures: Array<{ id: string; kind: 'message' | 'job'; title: string; detail: string; at: string; link: string | null }>;
  approvals: { messages: number; campaigns: number };
  tasks: { open: number; overdue: number; items: TaskDTO[] };
  setup: { senderVerified: boolean; providerConfigured: boolean; hasContacts: boolean; hasTemplates: boolean; hasAutomations: boolean };
}

export interface JobDTO {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SystemHealthDTO {
  ok: boolean;
  version: string;
  database: { ok: boolean; dialect: string; latencyMs: number };
  queue: {
    byStatus: Record<string, number>;
    lagSeconds: number;
    oldestQueuedAt: string | null;
    runningExpired: number;
  };
  scheduler: { lastTickAt: string | null; secondsSinceTick: number | null; leader: string | null; healthy: boolean };
  email: { provider: string | null; source: 'workspace' | 'environment' | 'none' };
  ai: { enabled: boolean; provider: string | null };
}

export interface AiStatusDTO {
  enabled: boolean;
  provider: string | null;
  model: string | null;
}

export interface AiDraftDTO {
  subject: string | null;
  previewText: string | null;
  html: string | null;
  text: string | null;
  notes: string[];
  variablesUsed: string[];
  unknownVariables: string[];
}

import { Transport, type TransportOptions } from './http';
import { AuthApi } from './resources/auth';
import { AutomationsApi } from './resources/automations';
import { ApprovalsApi, CampaignsApi, MessagesApi } from './resources/campaigns';
import { ContactsApi, EventsApi, FieldsApi, TagsApi } from './resources/contacts';
import { AnalyticsApi, CalendarApi, NotificationsApi, TasksApi } from './resources/insights';
import { ImportsApi, SegmentsApi } from './resources/segments';
import { AiApi, IntegrationsApi, SendersApi, SuppressionsApi, SystemApi } from './resources/settings';
import { SnippetsApi, TemplatesApi } from './resources/templates';
import { WorkspaceApi } from './resources/workspace';

export type MorrowClientOptions = TransportOptions;

/**
 * Typed client for the Morrow API.
 *
 * ```ts
 * const morrow = new MorrowClient({ baseUrl: 'https://morrow.example.com', token: process.env.MORROW_API_KEY });
 * await morrow.events.record({ email: 'lead@example.com', name: 'proposal.sent' });
 * ```
 */
export class MorrowClient {
  readonly transport: Transport;
  readonly auth: AuthApi;
  readonly workspace: WorkspaceApi;
  readonly contacts: ContactsApi;
  readonly events: EventsApi;
  readonly tags: TagsApi;
  readonly fields: FieldsApi;
  readonly segments: SegmentsApi;
  readonly imports: ImportsApi;
  readonly templates: TemplatesApi;
  readonly snippets: SnippetsApi;
  readonly automations: AutomationsApi;
  readonly campaigns: CampaignsApi;
  readonly messages: MessagesApi;
  readonly approvals: ApprovalsApi;
  readonly analytics: AnalyticsApi;
  readonly calendar: CalendarApi;
  readonly tasks: TasksApi;
  readonly notifications: NotificationsApi;
  readonly senders: SendersApi;
  readonly integrations: IntegrationsApi;
  readonly ai: AiApi;
  readonly suppressions: SuppressionsApi;
  readonly system: SystemApi;

  constructor(options: MorrowClientOptions) {
    const t = (this.transport = new Transport(options));
    this.auth = new AuthApi(t);
    this.workspace = new WorkspaceApi(t);
    this.contacts = new ContactsApi(t);
    this.events = new EventsApi(t);
    this.tags = new TagsApi(t);
    this.fields = new FieldsApi(t);
    this.segments = new SegmentsApi(t);
    this.imports = new ImportsApi(t);
    this.templates = new TemplatesApi(t);
    this.snippets = new SnippetsApi(t);
    this.automations = new AutomationsApi(t);
    this.campaigns = new CampaignsApi(t);
    this.messages = new MessagesApi(t);
    this.approvals = new ApprovalsApi(t);
    this.analytics = new AnalyticsApi(t);
    this.calendar = new CalendarApi(t);
    this.tasks = new TasksApi(t);
    this.notifications = new NotificationsApi(t);
    this.senders = new SendersApi(t);
    this.integrations = new IntegrationsApi(t);
    this.ai = new AiApi(t);
    this.suppressions = new SuppressionsApi(t);
    this.system = new SystemApi(t);
  }

  /** Change credentials or workspace after construction (e.g. after signing in). */
  configure(options: Partial<MorrowClientOptions>): this {
    Object.assign(this.transport.options, options);
    return this;
  }
}

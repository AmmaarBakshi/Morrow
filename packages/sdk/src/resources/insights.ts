import type {
  AnalyticsOverviewDTO,
  AutomationPerformanceDTO,
  CalendarEventDTO,
  CampaignComparisonDTO,
  FailureReasonDTO,
  NotificationDTO,
  Page,
  TaskDTO,
  TimeseriesPointDTO,
} from '@morrow/core';
import type { Transport } from '../http';
import type { Items, Ok, PageQuery, Range } from '../types';

export class AnalyticsApi {
  constructor(private readonly t: Transport) {}

  overview(query: Range & { campaignId?: string; automationId?: string } = {}): Promise<AnalyticsOverviewDTO> {
    return this.t.json('GET', '/analytics/overview', { query: { ...query } });
  }
  timeseries(range: Range = {}): Promise<Items<TimeseriesPointDTO>> {
    return this.t.json('GET', '/analytics/timeseries', { query: { ...range } });
  }
  campaigns(range: Range = {}): Promise<Items<CampaignComparisonDTO>> {
    return this.t.json('GET', '/analytics/campaigns', { query: { ...range } });
  }
  automations(range: Range = {}): Promise<Items<AutomationPerformanceDTO>> {
    return this.t.json('GET', '/analytics/automations', { query: { ...range } });
  }
  failures(range: Range = {}): Promise<Items<FailureReasonDTO>> {
    return this.t.json('GET', '/analytics/failures', { query: { ...range } });
  }
  exportCsv(range: Range = {}): Promise<string> {
    return this.t.text('GET', '/analytics/export', { query: { ...range } });
  }
}

export class CalendarApi {
  constructor(private readonly t: Transport) {}

  /** Birthdays, anniversaries, scheduled campaigns and automation sends in a date range. */
  events(range: Range = {}): Promise<Items<CalendarEventDTO>> {
    return this.t.json('GET', '/calendar', { query: { ...range } });
  }
}

export interface TaskInput {
  title?: string;
  description?: string | null;
  contactId?: string | null;
  dueAt?: string | null;
  assigneeId?: string | null;
}

export class TasksApi {
  constructor(private readonly t: Transport) {}

  list(query: { status?: string; contactId?: string; assigneeId?: string; mine?: boolean } & PageQuery = {}): Promise<Page<TaskDTO>> {
    return this.t.json('GET', '/tasks', { query: { ...query } });
  }
  get(id: string): Promise<TaskDTO> {
    return this.t.json('GET', `/tasks/${id}`);
  }
  create(input: TaskInput & { title: string }): Promise<TaskDTO> {
    return this.t.json('POST', '/tasks', { body: input });
  }
  update(id: string, input: TaskInput & { status?: 'open' | 'done' | 'dismissed' }): Promise<TaskDTO> {
    return this.t.json('PATCH', `/tasks/${id}`, { body: input });
  }
  complete(id: string): Promise<TaskDTO> {
    return this.update(id, { status: 'done' });
  }
  delete(id: string): Promise<Ok> {
    return this.t.json('DELETE', `/tasks/${id}`);
  }
}

export class NotificationsApi {
  constructor(private readonly t: Transport) {}

  list(query: { unreadOnly?: boolean; limit?: number } = {}): Promise<{ items: NotificationDTO[]; unread: number }> {
    return this.t.json('GET', '/notifications', { query: { ...query } });
  }
  markRead(ids: string[] | 'all'): Promise<Ok> {
    return this.t.json('POST', '/notifications/read', { body: { ids } });
  }
}

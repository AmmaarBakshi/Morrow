export { MorrowClient, type MorrowClientOptions } from './client';
export { MorrowApiError, MorrowNetworkError } from './errors';
export { Transport, buildQuery, type Query, type RequestOptions, type TransportOptions } from './http';
export type { Items, Ok, PageQuery, Range } from './types';
export type { InvitationInfo } from './resources/auth';
export type { ContactListQuery, RecordEventInput, RecordEventResult } from './resources/contacts';
export type { ImportPlan } from './resources/segments';
export type { SavedTemplate, TemplateContent, TemplateMeta } from './resources/templates';
export type { AutomationWithProblems } from './resources/automations';
export type { CampaignInput, MessageListQuery } from './resources/campaigns';
export type { TaskInput } from './resources/insights';
/** Every DTO and domain type, so consumers need only this package. */
export type * from '@morrow/core';

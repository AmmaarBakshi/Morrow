import { z } from 'zod';
import { CONSENT_STATUSES } from './consent';
import { isValidEmail } from './email';
import { isValidMonthDay } from './time/calendar';
import { isLeapYear, isValidLocalDate, isValidTimeZone } from './time/tz';

export const RELATIONSHIP_TYPES = [
  'client',
  'lead',
  'developer',
  'collaborator',
  'partner',
  'subscriber',
  'investor',
  'other',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  client: 'Client',
  lead: 'Lead',
  developer: 'Developer',
  collaborator: 'Collaborator',
  partner: 'Partner',
  subscriber: 'Subscriber',
  investor: 'Investor',
  other: 'Other',
};

export const CONTACT_FREQUENCIES = ['normal', 'reduced', 'minimal'] as const;
export type ContactFrequency = (typeof CONTACT_FREQUENCIES)[number];

export const TAG_NAME_RE = /^[^,;\n\r]{1,50}$/;

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, 'Tag names cannot be empty.')
  .max(50, 'Tag names are limited to 50 characters.')
  .refine((v) => TAG_NAME_RE.test(v), 'Tag names cannot contain commas, semicolons or line breaks.');

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

export const birthdaySchema = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year: z.number().int().min(1900).max(2100).nullish(),
  })
  .refine((b) => isValidMonthDay(b.month, b.day), { message: 'That day does not exist in that month.' })
  .refine((b) => !(b.year && b.month === 2 && b.day === 29 && !isLeapYear(b.year)), {
    message: '29 February only exists in leap years.',
  });

export type Birthday = z.infer<typeof birthdaySchema>;

export const customFieldValueSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const preferencesSchema = z.object({
  frequency: z.enum(CONTACT_FREQUENCIES).optional(),
  topics: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

const contactShape = {
  firstName: nullableText(100),
  lastName: nullableText(100),
  email: z
    .string()
    .trim()
    .max(254)
    .nullish()
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v == null || isValidEmail(v), 'Enter a valid e-mail address.'),
  company: nullableText(150),
  jobTitle: nullableText(150),
  birthday: birthdaySchema.nullish(),
  workAnniversary: z
    .string()
    .nullish()
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v == null || isValidLocalDate(v), 'Use a YYYY-MM-DD date.'),
  relationshipType: z.enum(RELATIONSHIP_TYPES),
  tags: z.array(tagNameSchema).max(50),
  interests: z.array(z.string().trim().min(1).max(60)).max(30),
  preferences: preferencesSchema,
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as "en" or "hi-IN".')
    .nullish()
    .or(z.literal('').transform(() => null)),
  timezone: z
    .string()
    .nullish()
    .transform((v) => (v === '' ? null : v))
    .refine((v) => v == null || isValidTimeZone(v), 'Use an IANA time zone such as "Asia/Kolkata".'),
  source: nullableText(120),
  consentStatus: z.enum(CONSENT_STATUSES),
  consentSource: nullableText(200),
  customFields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), customFieldValueSchema),
  lastInteractionAt: z.iso.datetime({ offset: true }).nullish(),
};

export const contactCreateSchema = z
  .object({
    ...contactShape,
    relationshipType: contactShape.relationshipType.default('subscriber'),
    tags: contactShape.tags.default([]),
    interests: contactShape.interests.default([]),
    preferences: preferencesSchema.default({}),
    consentStatus: contactShape.consentStatus.default('unknown'),
    customFields: contactShape.customFields.default({}),
    note: z.string().trim().max(5000).optional(),
  })
  .refine((c) => Boolean(c.email || c.firstName || c.lastName), {
    message: 'A contact needs at least an e-mail address or a name.',
    path: ['email'],
  });

export const contactUpdateSchema = z.object(contactShape).partial();

export type ContactCreateInput = z.input<typeof contactCreateSchema>;
export type ContactCreate = z.output<typeof contactCreateSchema>;
export type ContactUpdate = z.output<typeof contactUpdateSchema>;

export function fullName(c: { firstName?: string | null; lastName?: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
}

export function displayName(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  return fullName(c) || c.email || 'Unnamed contact';
}

/** Built-in contact fields that automations may update (consent is deliberately excluded). */
export const AUTOMATION_UPDATABLE_FIELDS = ['relationship_type', 'source', 'language', 'company', 'job_title'] as const;

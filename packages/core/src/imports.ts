/**
 * Contact import: header → field mapping suggestions, flexible date parsing and
 * per-row validation. Pure functions so the same logic powers the web wizard,
 * the API and `morrow contacts import`.
 */
import { CONSENT_STATUSES, type ConsentStatus } from './consent';
import { RELATIONSHIP_TYPES, TAG_NAME_RE, type RelationshipType } from './contacts';
import { isValidEmail } from './email';
import { isValidMonthDay } from './time/calendar';
import { formatLocalDate, isLeapYear, isValidTimeZone, parseLocalDate } from './time/tz';

export const IMPORT_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'company',
  'job_title',
  'birthday',
  'birthday_month',
  'birthday_day',
  'birth_year',
  'work_anniversary',
  'relationship_type',
  'tags',
  'interests',
  'language',
  'timezone',
  'source',
  'consent_status',
  'consent_source',
  'notes',
  'last_interaction_at',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Either a built-in field, `custom:<key>` or `ignore`. */
export type ImportTarget = ImportField | `custom:${string}` | 'ignore';

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  full_name: 'Full name (split into first/last)',
  email: 'E-mail',
  company: 'Company',
  job_title: 'Job title',
  birthday: 'Birthday (any common format)',
  birthday_month: 'Birthday month',
  birthday_day: 'Birthday day',
  birth_year: 'Birth year',
  work_anniversary: 'Work anniversary date',
  relationship_type: 'Relationship type',
  tags: 'Tags (comma or semicolon separated)',
  interests: 'Interests',
  language: 'Language',
  timezone: 'Time zone',
  source: 'Source',
  consent_status: 'Marketing consent',
  consent_source: 'Consent source',
  notes: 'Notes',
  last_interaction_at: 'Last interaction',
};

const ALIASES: Record<ImportField, string[]> = {
  first_name: ['firstname', 'first', 'givenname', 'fname', 'forename'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  full_name: ['name', 'fullname', 'contactname', 'displayname'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'workemail', 'primaryemail'],
  company: ['company', 'organization', 'organisation', 'org', 'companyname', 'employer', 'account'],
  job_title: ['title', 'jobtitle', 'position', 'role', 'designation'],
  birthday: ['birthday', 'birthdate', 'dob', 'dateofbirth', 'bday', 'birth'],
  birthday_month: ['birthdaymonth', 'birthmonth', 'dobmonth'],
  birthday_day: ['birthdayday', 'birthday_day', 'dobday', 'birthdayofmonth'],
  birth_year: ['birthyear', 'yearofbirth', 'dobyear'],
  work_anniversary: ['workanniversary', 'anniversary', 'startdate', 'hiredate', 'joiningdate', 'clientsince', 'customersince'],
  relationship_type: ['type', 'relationship', 'relationshiptype', 'contacttype', 'category', 'segment'],
  tags: ['tags', 'labels', 'tag', 'groups', 'lists'],
  interests: ['interests', 'topics', 'interest'],
  language: ['language', 'lang', 'locale', 'preferredlanguage'],
  timezone: ['timezone', 'tz', 'timezoneid', 'zone'],
  source: ['source', 'leadsource', 'origin', 'channel'],
  consent_status: ['consent', 'marketingconsent', 'optin', 'subscribed', 'emailoptin', 'newsletter', 'acceptsmarketing', 'consentstatus'],
  consent_source: ['consentsource', 'optinsource', 'consentmethod'],
  notes: ['notes', 'note', 'comments', 'comment', 'description'],
  last_interaction_at: ['lastinteraction', 'lastcontacted', 'lastactivity', 'lastseen', 'lastinteractionat'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function suggestMapping(headers: string[], customFieldKeys: string[] = []): ImportTarget[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const norm = normalizeHeader(header);
    const custom = customFieldKeys.find((k) => normalizeHeader(k) === norm);
    if (custom && !used.has(`custom:${custom}`)) {
      used.add(`custom:${custom}`);
      return `custom:${custom}` as ImportTarget;
    }
    for (const field of IMPORT_FIELDS) {
      if (used.has(field)) continue;
      if (normalizeHeader(field) === norm || ALIASES[field].includes(norm)) {
        used.add(field);
        return field;
      }
    }
    return 'ignore';
  });
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export interface ParsedDate {
  month: number;
  day: number;
  year: number | null;
  /** True when day and month could be swapped and the order setting decided. */
  ambiguous: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function valid(month: number, day: number, year: number | null): boolean {
  if (!isValidMonthDay(month, day)) return false;
  if (year !== null) {
    if (year < 1900 || year > 2100) return false;
    if (month === 2 && day === 29 && !isLeapYear(year)) return false;
  }
  return true;
}

function expandYear(y: string): number {
  const n = Number(y);
  if (y.length === 2) return n > 30 ? 1900 + n : 2000 + n;
  return n;
}

/** Parse the many ways people write dates in spreadsheets. */
export function parseFlexibleDate(raw: string, order: DateOrder = 'DMY'): ParsedDate | null {
  const v = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!v) return null;

  // ISO date or date-time: 1990-03-07, 1990-03-07T00:00:00Z
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(v);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return valid(month, day, year) ? { month, day, year, ambiguous: false } : null;
  }
  // vCard-style month/day without year: --03-07
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    return valid(month, day, null) ? { month, day, year: null, ambiguous: false } : null;
  }
  // Numeric with separators: 07/03/1990, 3/7, 07-03-90, 07.03.1990
  m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? expandYear(m[3]) : null;
    const dmy = valid(b, a, year);
    const mdy = valid(a, b, year);
    if (dmy && !mdy) return { month: b, day: a, year, ambiguous: false };
    if (mdy && !dmy) return { month: a, day: b, year, ambiguous: false };
    if (!dmy && !mdy) return null;
    const ambiguous = a !== b;
    return order === 'MDY' ? { month: a, day: b, year, ambiguous } : { month: b, day: a, year, ambiguous };
  }
  // Textual: 7 March 1990, 7 Mar, March 7 1990, Mar 7
  m = /^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/i.exec(v);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const month = MONTHS[m[2]!.toLowerCase()]!;
    const day = Number(m[1]);
    const year = m[3] ? Number(m[3]) : null;
    return valid(month, day, year) ? { month, day, year, ambiguous: false } : null;
  }
  m = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/i.exec(v);
  if (m && MONTHS[m[1]!.toLowerCase()]) {
    const month = MONTHS[m[1]!.toLowerCase()]!;
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : null;
    return valid(month, day, year) ? { month, day, year, ambiguous: false } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

const CONSENT_SYNONYMS: Record<string, ConsentStatus> = {
  yes: 'granted', y: 'granted', true: 'granted', '1': 'granted', granted: 'granted', optedin: 'granted', optin: 'granted',
  subscribed: 'granted', subscribe: 'granted', consented: 'granted', express: 'granted', confirmed: 'granted', doubleoptin: 'granted',
  implied: 'implied', existingcustomer: 'implied', existingclient: 'implied', businessrelationship: 'implied',
  no: 'withdrawn', n: 'withdrawn', false: 'withdrawn', '0': 'withdrawn', withdrawn: 'withdrawn', optedout: 'withdrawn',
  optout: 'withdrawn', unsubscribed: 'withdrawn', revoked: 'withdrawn',
  unknown: 'unknown', '': 'unknown', na: 'unknown', none: 'unknown', pending: 'unknown',
};

export function parseConsent(raw: string): ConsentStatus | null {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if ((CONSENT_STATUSES as readonly string[]).includes(key)) return key as ConsentStatus;
  return CONSENT_SYNONYMS[key] ?? null;
}

const RELATIONSHIP_SYNONYMS: Record<string, RelationshipType> = {
  customer: 'client', clients: 'client', customers: 'client', account: 'client',
  prospect: 'lead', prospects: 'lead', leads: 'lead', opportunity: 'lead',
  dev: 'developer', engineer: 'developer', developers: 'developer',
  collaborators: 'collaborator', contractor: 'collaborator', freelancer: 'collaborator',
  partners: 'partner', vendor: 'partner', agency: 'partner',
  subscribers: 'subscriber', newsletter: 'subscriber', follower: 'subscriber',
  investors: 'investor', vc: 'investor', angel: 'investor', founder: 'other',
};

export function parseRelationship(raw: string): RelationshipType | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if ((RELATIONSHIP_TYPES as readonly string[]).includes(key)) return key as RelationshipType;
  return RELATIONSHIP_SYNONYMS[key] ?? null;
}

export function splitList(raw: string): string[] {
  return [...new Set(raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean))];
}

export function splitFullName(raw: string): { firstName: string | null; lastName: string | null } {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v) return { firstName: null, lastName: null };
  if (v.includes(',')) {
    const [last, first] = v.split(',').map((s) => s.trim());
    return { firstName: first || null, lastName: last || null };
  }
  const parts = v.split(' ');
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type CustomFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'url';

export interface CustomFieldDef {
  key: string;
  type: CustomFieldType;
  options?: string[] | null;
}

export interface ImportRecord {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  company: string | null;
  jobTitle: string | null;
  birthday: { month: number; day: number; year: number | null } | null;
  workAnniversary: string | null;
  relationshipType: RelationshipType | null;
  tags: string[];
  interests: string[];
  language: string | null;
  timezone: string | null;
  source: string | null;
  consentStatus: ConsentStatus | null;
  consentSource: string | null;
  notes: string | null;
  lastInteractionAt: string | null;
  customFields: Record<string, string | number | boolean | null>;
}

export interface RowResult {
  record: ImportRecord;
  errors: string[];
  warnings: string[];
}

export interface MapRowOptions {
  dateOrder: DateOrder;
  customFields: CustomFieldDef[];
}

export function parseCustomFieldValue(def: CustomFieldDef, raw: string, dateOrder: DateOrder = 'DMY'): { value: string | number | boolean | null; error?: string } {
  const v = raw.trim();
  if (v === '') return { value: null };
  switch (def.type) {
    case 'number': {
      const n = Number(v.replace(/,/g, ''));
      return Number.isFinite(n) ? { value: n } : { value: null, error: `"${def.key}" must be a number` };
    }
    case 'boolean': {
      const key = v.toLowerCase();
      if (['yes', 'y', 'true', '1'].includes(key)) return { value: true };
      if (['no', 'n', 'false', '0'].includes(key)) return { value: false };
      return { value: null, error: `"${def.key}" must be yes or no` };
    }
    case 'date': {
      const d = parseFlexibleDate(v, dateOrder);
      if (!d || d.year === null) return { value: null, error: `"${def.key}" must be a full date` };
      return { value: formatLocalDate({ year: d.year, month: d.month, day: d.day }) };
    }
    case 'select': {
      const match = def.options?.find((o) => o.toLowerCase() === v.toLowerCase());
      return match ? { value: match } : { value: null, error: `"${def.key}" must be one of: ${(def.options ?? []).join(', ')}` };
    }
    case 'url':
      return /^https?:\/\/\S+$/i.test(v) ? { value: v } : { value: null, error: `"${def.key}" must be an http(s) link` };
    default:
      return { value: v.slice(0, 2000) };
  }
}

function emptyRecord(): ImportRecord {
  return {
    firstName: null, lastName: null, email: null, company: null, jobTitle: null, birthday: null,
    workAnniversary: null, relationshipType: null, tags: [], interests: [], language: null, timezone: null,
    source: null, consentStatus: null, consentSource: null, notes: null, lastInteractionAt: null, customFields: {},
  };
}

const clip = (v: string, max: number) => (v.length > max ? v.slice(0, max) : v);

export function mapImportRow(cells: string[], mapping: ImportTarget[], options: MapRowOptions): RowResult {
  const record = emptyRecord();
  const errors: string[] = [];
  const warnings: string[] = [];
  let bMonth: number | null = null;
  let bDay: number | null = null;
  let bYear: number | null = null;

  mapping.forEach((target, idx) => {
    if (target === 'ignore') return;
    const raw = (cells[idx] ?? '').trim();
    if (target.startsWith('custom:')) {
      const key = target.slice(7);
      const def = options.customFields.find((f) => f.key === key);
      if (!def) return;
      const parsed = parseCustomFieldValue(def, raw, options.dateOrder);
      if (parsed.error) errors.push(parsed.error);
      else if (parsed.value !== null) record.customFields[key] = parsed.value;
      return;
    }
    if (raw === '') return;
    switch (target as ImportField) {
      case 'first_name':
        record.firstName = clip(raw, 100);
        break;
      case 'last_name':
        record.lastName = clip(raw, 100);
        break;
      case 'full_name': {
        const { firstName, lastName } = splitFullName(raw);
        record.firstName ??= firstName ? clip(firstName, 100) : null;
        record.lastName ??= lastName ? clip(lastName, 100) : null;
        break;
      }
      case 'email':
        if (isValidEmail(raw)) record.email = raw.toLowerCase();
        else errors.push(`Invalid e-mail address "${clip(raw, 80)}"`);
        break;
      case 'company':
        record.company = clip(raw, 150);
        break;
      case 'job_title':
        record.jobTitle = clip(raw, 150);
        break;
      case 'birthday': {
        const d = parseFlexibleDate(raw, options.dateOrder);
        if (!d) errors.push(`Unrecognised birthday "${clip(raw, 40)}"`);
        else {
          record.birthday = { month: d.month, day: d.day, year: d.year };
          if (d.ambiguous) warnings.push(`Birthday "${raw}" was read as ${d.day}/${d.month} (${options.dateOrder})`);
        }
        break;
      }
      case 'birthday_month': {
        const n = Number(raw) || MONTHS[raw.toLowerCase()] || 0;
        if (n >= 1 && n <= 12) bMonth = n;
        else errors.push(`Invalid birthday month "${clip(raw, 20)}"`);
        break;
      }
      case 'birthday_day': {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= 31) bDay = n;
        else errors.push(`Invalid birthday day "${clip(raw, 20)}"`);
        break;
      }
      case 'birth_year': {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1900 && n <= 2100) bYear = n;
        else errors.push(`Invalid birth year "${clip(raw, 20)}"`);
        break;
      }
      case 'work_anniversary': {
        const d = parseFlexibleDate(raw, options.dateOrder);
        if (!d || d.year === null) errors.push(`Work anniversary "${clip(raw, 40)}" needs a full date`);
        else record.workAnniversary = formatLocalDate({ year: d.year, month: d.month, day: d.day });
        break;
      }
      case 'relationship_type': {
        const r = parseRelationship(raw);
        if (r) record.relationshipType = r;
        else warnings.push(`Unknown relationship type "${clip(raw, 40)}" — using the default`);
        break;
      }
      case 'tags': {
        const tags = splitList(raw).filter((t) => TAG_NAME_RE.test(t)).map((t) => clip(t, 50));
        record.tags.push(...tags);
        break;
      }
      case 'interests':
        record.interests.push(...splitList(raw).map((t) => clip(t, 60)).slice(0, 30));
        break;
      case 'language':
        if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(raw)) record.language = raw.toLowerCase().replace(/-([a-z0-9]+)$/i, (_, r: string) => `-${r.toUpperCase()}`);
        else warnings.push(`Ignored language "${clip(raw, 20)}"`);
        break;
      case 'timezone':
        if (isValidTimeZone(raw)) record.timezone = raw;
        else warnings.push(`Ignored unknown time zone "${clip(raw, 40)}"`);
        break;
      case 'source':
        record.source = clip(raw, 120);
        break;
      case 'consent_status': {
        const c = parseConsent(raw);
        if (c) record.consentStatus = c;
        else errors.push(`Unrecognised consent value "${clip(raw, 40)}"`);
        break;
      }
      case 'consent_source':
        record.consentSource = clip(raw, 200);
        break;
      case 'notes':
        record.notes = clip(raw, 5000);
        break;
      case 'last_interaction_at': {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          const p = parseFlexibleDate(raw, options.dateOrder);
          if (p && p.year !== null) record.lastInteractionAt = new Date(Date.UTC(p.year, p.month - 1, p.day)).toISOString();
          else warnings.push(`Ignored last interaction "${clip(raw, 40)}"`);
        } else record.lastInteractionAt = d.toISOString();
        break;
      }
    }
  });

  if (!record.birthday && (bMonth !== null || bDay !== null)) {
    if (bMonth !== null && bDay !== null && isValidMonthDay(bMonth, bDay)) {
      const year = bYear !== null && !(bMonth === 2 && bDay === 29 && !isLeapYear(bYear)) ? bYear : null;
      record.birthday = { month: bMonth, day: bDay, year };
    } else {
      errors.push('Birthday month and day must both be present and valid');
    }
  } else if (record.birthday && bYear !== null && record.birthday.year === null) {
    const { month, day } = record.birthday;
    if (!(month === 2 && day === 29 && !isLeapYear(bYear))) record.birthday.year = bYear;
  }
  record.tags = [...new Set(record.tags)].slice(0, 50);
  if (!record.email && !record.firstName && !record.lastName) errors.push('Row has no e-mail address or name');
  if (!record.email && (record.firstName || record.lastName)) warnings.push('Row has no e-mail address; the contact cannot receive e-mail');
  return { record, errors, warnings };
}

export function isValidLocalDateString(value: string): boolean {
  return parseLocalDate(value) !== null;
}

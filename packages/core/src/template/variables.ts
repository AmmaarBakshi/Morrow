/**
 * Catalogue of personalisation variables available to templates. The UI uses it
 * for the variable picker, validation uses it to flag typos, and AI assistance
 * uses it to restrict generated copy to data Morrow actually has.
 */

export type VariableGroup = 'contact' | 'workspace' | 'sender' | 'occasion' | 'system' | 'custom' | 'event';

export interface VariableDefinition {
  key: string;
  label: string;
  group: VariableGroup;
  sample: string | number;
  description?: string;
}

export const STANDARD_VARIABLES: VariableDefinition[] = [
  { key: 'first_name', label: 'First name', group: 'contact', sample: 'Rahul', description: 'Falls back to the workspace greeting fallback when empty.' },
  { key: 'last_name', label: 'Last name', group: 'contact', sample: 'Mehta' },
  { key: 'full_name', label: 'Full name', group: 'contact', sample: 'Rahul Mehta' },
  { key: 'email', label: 'E-mail address', group: 'contact', sample: 'rahul@example.com' },
  { key: 'company', label: "Contact's company", group: 'contact', sample: 'Northwind Labs' },
  { key: 'job_title', label: 'Job title', group: 'contact', sample: 'CTO' },
  { key: 'relationship_type', label: 'Relationship type', group: 'contact', sample: 'client' },
  { key: 'birthday', label: 'Birthday (day and month)', group: 'contact', sample: '7 March' },
  { key: 'language', label: 'Preferred language', group: 'contact', sample: 'en' },

  { key: 'company_name', label: 'Your company name', group: 'workspace', sample: 'Cyphen' },
  { key: 'website_url', label: 'Your website', group: 'workspace', sample: 'https://example.com' },
  { key: 'collaboration_url', label: 'Collaboration link', group: 'workspace', sample: 'https://example.com/collaborate' },
  { key: 'latest_project_name', label: 'Latest project name', group: 'workspace', sample: 'Orbit Analytics' },
  { key: 'latest_project_url', label: 'Latest project link', group: 'workspace', sample: 'https://example.com/work/orbit' },
  { key: 'company_address', label: 'Postal address', group: 'workspace', sample: '221B Residency Road, Bengaluru 560025, India' },
  { key: 'brand_color', label: 'Brand colour', group: 'workspace', sample: '#4f46e5' },
  { key: 'logo_url', label: 'Logo URL', group: 'workspace', sample: '' },

  { key: 'sender_name', label: 'Sender name', group: 'sender', sample: 'Ammaar' },
  { key: 'sender_email', label: 'Sender e-mail', group: 'sender', sample: 'hello@example.com' },

  { key: 'occasion_date', label: 'Occasion date', group: 'occasion', sample: '2026-03-07', description: 'Birthday or anniversary date being celebrated.' },
  { key: 'years', label: 'Years since the occasion', group: 'occasion', sample: 3, description: 'Completed years for work anniversaries. Use with | ordinal.' },

  { key: 'unsubscribe_url', label: 'Unsubscribe link', group: 'system', sample: 'https://morrow.example/u/…' },
  { key: 'preferences_url', label: 'Preferences link', group: 'system', sample: 'https://morrow.example/u/…' },
  { key: 'current_year', label: 'Current year', group: 'system', sample: 2026 },
  { key: 'today', label: "Today's date", group: 'system', sample: '2026-10-16' },
];

const STANDARD_KEYS = new Set(STANDARD_VARIABLES.map((v) => v.key));

/** Keys of user-defined workspace variables, e.g. `latest_release`. */
export const WORKSPACE_VARIABLE_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

export function isKnownVariable(path: string, workspaceVariables: Iterable<string> = [], customFieldKeys: Iterable<string> = []): boolean {
  if (STANDARD_KEYS.has(path)) return true;
  if (path.startsWith('event.')) return true; // properties of custom events are dynamic
  const ws = new Set(workspaceVariables);
  if (ws.has(path)) return true;
  if (path.startsWith('custom.')) return new Set(customFieldKeys).has(path.slice(7));
  return false;
}

/** Sample data used for previews when no real contact is selected. */
export function sampleTemplateData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const v of STANDARD_VARIABLES) data[v.key] = v.sample;
  data.custom = {};
  data.event = {};
  return { ...data, ...overrides };
}

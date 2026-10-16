/**
 * E-mail address validation and normalisation used for duplicate detection,
 * suppression matching and sending.
 */

export interface NormalizeOptions {
  /**
   * Treat Gmail addresses with dots or +tags as the same mailbox
   * (r.a.hul+news@gmail.com → rahul@gmail.com). Off by default because it is
   * provider-specific; enable per workspace for duplicate detection.
   */
  gmailCanonical?: boolean;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Pragmatic RFC 5321/5322 subset that real mailbox providers accept.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length < 3 || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => DOMAIN_LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,63}$/i.test(tld) || /^xn--[a-z0-9-]{1,59}$/i.test(tld);
}

/** Lower-cased, trimmed address for matching. Returns null for invalid input. */
export function normalizeEmail(value: unknown, options: NormalizeOptions = {}): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().replace(/^mailto:/i, '').toLowerCase();
  if (!isValidEmail(email)) return null;
  if (!options.gmailCanonical) return email;
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split('+')[0]!.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Mask an address for logs and low-privilege views: r***@example.com */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/** Format a mailbox header value: "Name" <address>. */
export function formatMailbox(address: string, name?: string | null): string {
  const clean = (name ?? '').replace(/[\r\n"<>]/g, '').trim();
  return clean ? `"${clean}" <${address}>` : address;
}

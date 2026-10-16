import { describe, expect, it } from 'vitest';
import { formatMailbox, isValidEmail, maskEmail, normalizeEmail } from '../src/email';
import { checkEligibility, consentAllows, DEFAULT_CONSENT_POLICY, suppressionScopeFor, type EligibilitySubject } from '../src/consent';

describe('e-mail validation and normalisation', () => {
  it('accepts realistic addresses and rejects malformed ones', () => {
    for (const ok of ['rahul@example.com', 'r.mehta+news@cyphen.dev', "o'brien@example.co.uk", 'a@b.io', 'x@xn--80ak6aa92e.com']) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
    for (const bad of ['', 'rahul', 'rahul@', '@example.com', 'rahul@example', 'ra..hul@example.com', 'rahul@exa_mple.com', 'a b@c.com', `${'a'.repeat(65)}@x.com`]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it('normalises case and whitespace for duplicate detection', () => {
    expect(normalizeEmail('  Rahul.Mehta@Example.COM ')).toBe('rahul.mehta@example.com');
    expect(normalizeEmail('mailto:Hi@Cyphen.dev')).toBe('hi@cyphen.dev');
    expect(normalizeEmail('not an email')).toBeNull();
  });

  it('optionally canonicalises Gmail dots and plus tags', () => {
    expect(normalizeEmail('R.a.hul+news@googlemail.com', { gmailCanonical: true })).toBe('rahul@gmail.com');
    expect(normalizeEmail('r.a.hul+news@gmail.com')).toBe('r.a.hul+news@gmail.com');
    expect(normalizeEmail('r.a.hul+news@cyphen.dev', { gmailCanonical: true })).toBe('r.a.hul+news@cyphen.dev');
  });

  it('masks and formats mailboxes safely', () => {
    expect(maskEmail('rahul@example.com')).toBe('r***@example.com');
    expect(formatMailbox('hi@cyphen.dev', 'Cyphen "Team"\r\nBcc: x')).toBe('"Cyphen TeamBcc: x" <hi@cyphen.dev>');
  });
});

describe('consent and eligibility', () => {
  const base: EligibilitySubject = { email: 'rahul@example.com', emailValid: true, archived: false, consentStatus: 'granted', suppression: null };

  it('allows marketing only with granted consent by default', () => {
    expect(consentAllows('granted', 'marketing', DEFAULT_CONSENT_POLICY)).toBe(true);
    expect(consentAllows('implied', 'marketing', DEFAULT_CONSENT_POLICY)).toBe(false);
    expect(consentAllows('unknown', 'marketing', DEFAULT_CONSENT_POLICY)).toBe(false);
    expect(consentAllows('implied', 'marketing', { ...DEFAULT_CONSENT_POLICY, allowImpliedForMarketing: true })).toBe(true);
  });

  it('allows relationship messages with granted or implied consent', () => {
    expect(consentAllows('implied', 'relationship', DEFAULT_CONSENT_POLICY)).toBe(true);
    expect(consentAllows('unknown', 'relationship', DEFAULT_CONSENT_POLICY)).toBe(false);
    expect(consentAllows('unknown', 'relationship', { ...DEFAULT_CONSENT_POLICY, allowUnknownForRelationship: true })).toBe(true);
    expect(consentAllows('withdrawn', 'relationship', { ...DEFAULT_CONSENT_POLICY, allowUnknownForRelationship: true })).toBe(false);
  });

  it('never needs consent for transactional mail', () => {
    expect(checkEligibility({ ...base, consentStatus: 'withdrawn' }, 'transactional').eligible).toBe(true);
  });

  it('blocks unsubscribed contacts from marketing and relationship mail but not transactional', () => {
    const unsub: EligibilitySubject = { ...base, consentStatus: 'withdrawn', suppression: { reason: 'unsubscribed', scope: suppressionScopeFor('unsubscribed') } };
    expect(checkEligibility(unsub, 'marketing')).toEqual({ eligible: false, reasons: ['unsubscribed'] });
    expect(checkEligibility(unsub, 'relationship').eligible).toBe(false);
    expect(checkEligibility(unsub, 'transactional').eligible).toBe(true);
  });

  it('blocks hard-bounced addresses from everything', () => {
    const bounced: EligibilitySubject = { ...base, suppression: { reason: 'hard_bounce', scope: suppressionScopeFor('hard_bounce') } };
    expect(checkEligibility(bounced, 'transactional')).toEqual({ eligible: false, reasons: ['suppressed'] });
    expect(checkEligibility(bounced, 'marketing').reasons).toContain('suppressed');
  });

  it('reports every reason a contact is ineligible', () => {
    const r = checkEligibility({ email: null, emailValid: false, archived: true, consentStatus: 'unknown', suppression: null }, 'marketing');
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['no_email', 'archived', 'consent_missing']);
    expect(checkEligibility({ ...base, emailValid: false }, 'transactional').reasons).toEqual(['invalid_email']);
  });

  it('distinguishes withdrawn consent from missing consent', () => {
    expect(checkEligibility({ ...base, consentStatus: 'withdrawn' }, 'marketing').reasons).toEqual(['consent_withdrawn']);
  });
});

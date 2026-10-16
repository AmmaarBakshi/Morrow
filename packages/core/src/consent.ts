/**
 * Consent, suppression and eligibility rules.
 *
 * Having an e-mail address does not grant permission to send marketing.
 * Every message carries a category, and eligibility is evaluated when the
 * message is created and again at the final sending stage.
 */

export const MESSAGE_CATEGORIES = ['transactional', 'relationship', 'marketing'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export const MESSAGE_CATEGORY_LABELS: Record<MessageCategory, string> = {
  transactional: 'Transactional — account or service messages the recipient expects',
  relationship: 'Relationship — personal greetings and check-ins with existing contacts',
  marketing: 'Marketing — newsletters, announcements and promotional content',
};

/**
 * - granted:   express, recorded opt-in (form, double opt-in, written consent)
 * - implied:   existing business relationship, recorded with its source
 * - unknown:   no consent information (default for imports)
 * - withdrawn: the contact opted out
 */
export const CONSENT_STATUSES = ['granted', 'implied', 'unknown', 'withdrawn'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const SUPPRESSION_REASONS = ['unsubscribed', 'hard_bounce', 'complaint', 'invalid_address', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Scope of a suppression.
 * - `marketing` blocks marketing and relationship messages (unsubscribes).
 * - `all` blocks every message, including transactional (bounces, complaints, manual blocks).
 */
export type SuppressionScope = 'marketing' | 'all';

export function suppressionScopeFor(reason: SuppressionReason): SuppressionScope {
  return reason === 'unsubscribed' ? 'marketing' : 'all';
}

export interface ConsentPolicy {
  /** Allow `implied` consent to receive marketing (off by default). */
  allowImpliedForMarketing: boolean;
  /** Allow `unknown` consent to receive relationship messages (off by default). */
  allowUnknownForRelationship: boolean;
}

export const DEFAULT_CONSENT_POLICY: ConsentPolicy = {
  allowImpliedForMarketing: false,
  allowUnknownForRelationship: false,
};

export type IneligibleReason =
  | 'no_email'
  | 'invalid_email'
  | 'archived'
  | 'suppressed'
  | 'unsubscribed'
  | 'consent_missing'
  | 'consent_withdrawn';

export const INELIGIBLE_REASON_LABELS: Record<IneligibleReason, string> = {
  no_email: 'No e-mail address',
  invalid_email: 'Invalid e-mail address',
  archived: 'Contact is archived',
  suppressed: 'Address is suppressed (bounce, complaint or manual block)',
  unsubscribed: 'Contact unsubscribed',
  consent_missing: 'No consent recorded for this type of message',
  consent_withdrawn: 'Consent was withdrawn',
};

export interface EligibilitySubject {
  email: string | null;
  emailValid: boolean;
  archived: boolean;
  consentStatus: ConsentStatus;
  suppression?: { reason: SuppressionReason; scope: SuppressionScope } | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: IneligibleReason[];
}

export function requiresUnsubscribeLink(category: MessageCategory): boolean {
  return category !== 'transactional';
}

export function consentAllows(status: ConsentStatus, category: MessageCategory, policy: ConsentPolicy): boolean {
  switch (category) {
    case 'transactional':
      return true;
    case 'relationship':
      return status === 'granted' || status === 'implied' || (status === 'unknown' && policy.allowUnknownForRelationship);
    case 'marketing':
      return status === 'granted' || (status === 'implied' && policy.allowImpliedForMarketing);
  }
}

export function checkEligibility(
  subject: EligibilitySubject,
  category: MessageCategory,
  policy: ConsentPolicy = DEFAULT_CONSENT_POLICY,
): EligibilityResult {
  const reasons: IneligibleReason[] = [];
  if (!subject.email) reasons.push('no_email');
  else if (!subject.emailValid) reasons.push('invalid_email');
  if (subject.archived) reasons.push('archived');

  const s = subject.suppression;
  if (s) {
    if (s.scope === 'all') reasons.push('suppressed');
    else if (category !== 'transactional') reasons.push('unsubscribed');
  }
  if (category !== 'transactional') {
    if (subject.consentStatus === 'withdrawn') {
      if (!reasons.includes('unsubscribed')) reasons.push('consent_withdrawn');
    } else if (!consentAllows(subject.consentStatus, category, policy)) {
      reasons.push('consent_missing');
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

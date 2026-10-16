/**
 * Analytics calculations. Rates are null when the denominator is zero or when
 * the provider cannot report the underlying event — never a fabricated 0%.
 */

export interface MessageCounts {
  total: number;
  queued: number;
  pendingApproval: number;
  sent: number; // accepted by the provider
  delivered: number;
  bounced: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
  rejected: number;
  complained: number;
  unsubscribed: number;
  opened: number; // unique messages with at least one open
  clicked: number; // unique messages with at least one click
  suppressed: number;
  cancelled: number;
}

export function emptyCounts(): MessageCounts {
  return {
    total: 0, queued: 0, pendingApproval: 0, sent: 0, delivered: 0, bounced: 0, hardBounced: 0, softBounced: 0,
    failed: 0, rejected: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0, suppressed: 0, cancelled: 0,
  };
}

export interface ProviderReporting {
  deliveryEvents: boolean;
  openTracking: boolean;
  clickTracking: boolean;
}

export interface MessageRates {
  /** Delivered ÷ accepted. Null if the provider does not report deliveries. */
  deliveryRate: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
  unsubscribeRate: number | null;
  /** Estimated: privacy proxies and image blocking distort opens. */
  openRate: number | null;
  clickRate: number | null;
  clickToOpenRate: number | null;
}

export function rate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.min(1, Math.max(0, numerator / denominator));
}

export function computeRates(c: MessageCounts, reporting: ProviderReporting): MessageRates {
  const accepted = c.sent;
  // When delivery is reported, engagement is measured against delivered mail.
  const base = reporting.deliveryEvents ? c.delivered : accepted;
  return {
    deliveryRate: reporting.deliveryEvents ? rate(c.delivered, accepted) : null,
    bounceRate: rate(c.bounced, accepted),
    complaintRate: reporting.deliveryEvents ? rate(c.complained, base) : null,
    unsubscribeRate: rate(c.unsubscribed, base),
    openRate: reporting.openTracking ? rate(c.opened, base) : null,
    clickRate: reporting.clickTracking ? rate(c.clicked, base) : null,
    clickToOpenRate: reporting.openTracking && reporting.clickTracking ? rate(c.clicked, c.opened) : null,
  };
}

export function formatRate(value: number | null, digits = 1): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export const OPEN_TRACKING_DISCLAIMER =
  'Opens are estimates. Apple Mail Privacy Protection, image blocking and security scanners can inflate or hide opens, so treat open rates as a trend, not proof that a person read the e-mail.';

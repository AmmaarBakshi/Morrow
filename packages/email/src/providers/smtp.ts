import { classifySmtpError } from '../classify';
import { ProviderError, type EmailProvider, type OutboundEmail, type SendResult, type VerifyResult } from '../types';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true for implicit TLS (465); STARTTLS is used automatically otherwise. */
  secure: boolean;
  username?: string;
  password?: string;
  /** Upper bound on simultaneous SMTP connections. */
  maxConnections?: number;
}

type Transporter = {
  sendMail(options: Record<string, unknown>): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[]; response?: string }>;
  verify(): Promise<true>;
  close(): void;
};

/**
 * Generic SMTP delivery (Amazon SES SMTP, Mailgun, Postmark SMTP, Google
 * Workspace, self-hosted MTAs…). SMTP only reports acceptance by the next hop,
 * so Morrow never treats an SMTP send as "delivered".
 */
export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly capabilities = {
    deliveryEvents: false,
    bounceEvents: false,
    complaintEvents: false,
    openTracking: false,
    clickTracking: false,
    idempotencyKeys: false,
    webhooks: false,
    customHeaders: true,
  };

  private transporter: Transporter | null = null;

  constructor(private readonly config: SmtpConfig) {}

  private async transport(): Promise<Transporter> {
    if (this.transporter) return this.transporter;
    const nodemailer = (await import('nodemailer')) as unknown as {
      default?: { createTransport(o: unknown): Transporter };
      createTransport?(o: unknown): Transporter;
    };
    const create = nodemailer.default?.createTransport ?? nodemailer.createTransport!;
    this.transporter = create({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      pool: true,
      maxConnections: this.config.maxConnections ?? 3,
      auth: this.config.username ? { user: this.config.username, pass: this.config.password } : undefined,
      // Never let message content trigger file or URL access.
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    return this.transporter;
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const transporter = await this.transport();
    try {
      const info = await transporter.sendMail({
        from: { address: email.from.email, name: email.from.name ?? '' },
        to: { address: email.to.email, name: email.to.name ?? '' },
        replyTo: email.replyTo ?? undefined,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { ...email.headers, 'X-Morrow-Message-Id': email.messageId },
        messageId: `<${email.messageId}@morrow.local>`,
      });
      if (info.rejected && info.rejected.length > 0) {
        throw new ProviderError(info.response ?? 'Recipient rejected', { errorClass: 'permanent', code: 'smtp_rejected', invalidRecipient: true });
      }
      return { providerMessageId: info.messageId, acceptedAt: new Date().toISOString() };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifySmtpError(err as { responseCode?: number; code?: string; response?: string; message?: string });
    }
  }

  async verify(): Promise<VerifyResult> {
    try {
      await (await this.transport()).verify();
      return { ok: true, message: `Connected to ${this.config.host}:${this.config.port} and authenticated.` };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { ok: false, message: e.message ?? 'Could not connect to the SMTP server', details: { code: e.code } };
    }
  }

  close(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}

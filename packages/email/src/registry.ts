import { FakeProvider } from './providers/fake';
import { PostmarkProvider } from './providers/postmark';
import { ResendProvider } from './providers/resend';
import { SmtpProvider } from './providers/smtp';
import type { EmailProvider } from './types';

export type ProviderFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';

export interface ProviderField {
  key: string;
  label: string;
  type: ProviderFieldType;
  /** Secret fields are encrypted at rest and never returned by the API. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  defaultValue?: string | number | boolean;
}

export interface ProviderDescriptor {
  name: string;
  label: string;
  description: string;
  docsUrl?: string;
  /** Development-only providers are hidden in production unless explicitly allowed. */
  developmentOnly?: boolean;
  fields: ProviderField[];
  webhook: { supported: boolean; instructions: string };
  create(config: Record<string, unknown>, secrets: Record<string, string>): EmailProvider;
}

const registry = new Map<string, ProviderDescriptor>();

export function registerProvider(descriptor: ProviderDescriptor): void {
  registry.set(descriptor.name, descriptor);
}

export function getProviderDescriptor(name: string): ProviderDescriptor | undefined {
  return registry.get(name);
}

export function listProviders(): ProviderDescriptor[] {
  return [...registry.values()];
}

export class ProviderConfigError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'ProviderConfigError';
    this.missing = missing;
  }
}

/** Check required fields without instantiating the provider. */
export function missingProviderFields(name: string, config: Record<string, unknown>, secrets: Record<string, string>): string[] {
  const d = registry.get(name);
  if (!d) return [];
  return d.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = f.secret ? secrets[f.key] : config[f.key];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.label);
}

export function createProvider(name: string, config: Record<string, unknown> = {}, secrets: Record<string, string> = {}): EmailProvider {
  const d = registry.get(name);
  if (!d) throw new ProviderConfigError(`Unknown e-mail provider "${name}"`);
  const missing = missingProviderFields(name, config, secrets);
  if (missing.length) throw new ProviderConfigError(`Missing ${missing.join(', ')} for ${d.label}`, missing);
  return d.create(config, secrets);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v));

registerProvider({
  name: 'fake',
  label: 'Development inbox',
  description: 'Stores messages locally and simulates delivery, bounces and complaints. Nothing is sent.',
  developmentOnly: true,
  fields: [],
  webhook: { supported: false, instructions: 'Delivery events are simulated automatically.' },
  create: () => new FakeProvider(),
});

registerProvider({
  name: 'smtp',
  label: 'SMTP',
  description: 'Any SMTP relay: Amazon SES, Mailgun, Postmark, Google Workspace or your own server. Reports acceptance only.',
  fields: [
    { key: 'host', label: 'Host', type: 'text', secret: false, required: true, placeholder: 'email-smtp.ap-south-1.amazonaws.com' },
    { key: 'port', label: 'Port', type: 'number', secret: false, required: true, defaultValue: 587 },
    { key: 'secure', label: 'Implicit TLS (port 465)', type: 'boolean', secret: false, required: false, defaultValue: false },
    { key: 'username', label: 'Username', type: 'text', secret: false, required: false },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: false },
  ],
  webhook: {
    supported: false,
    instructions: 'SMTP has no delivery webhooks. Morrow records acceptance by the relay; bounces must be handled at the relay.',
  },
  create: (config, secrets) =>
    new SmtpProvider({
      host: str(config.host),
      port: Number(config.port ?? 587),
      secure: config.secure === true || config.secure === 'true',
      username: str(config.username) || undefined,
      password: secrets.password || undefined,
    }),
});

registerProvider({
  name: 'resend',
  label: 'Resend',
  description: 'Developer-friendly e-mail API with idempotent sends and signed delivery webhooks.',
  docsUrl: 'https://resend.com/docs',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, placeholder: 're_…' },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true, required: false, placeholder: 'whsec_…', help: 'From Resend → Webhooks. Required to record deliveries and bounces.' },
  ],
  webhook: {
    supported: true,
    instructions:
      'In Resend → Webhooks, add the Morrow webhook URL shown below and subscribe to sent, delivered, delivery_delayed, bounced, complained, opened and clicked events. Paste the signing secret here.',
  },
  create: (_config, secrets) => new ResendProvider({ apiKey: secrets.apiKey ?? '', webhookSecret: secrets.webhookSecret || undefined }),
});

registerProvider({
  name: 'postmark',
  label: 'Postmark',
  description: 'Transactional and broadcast streams with detailed bounce reporting.',
  docsUrl: 'https://postmarkapp.com/developer',
  fields: [
    { key: 'serverToken', label: 'Server API token', type: 'password', secret: true, required: true },
    { key: 'transactionalStream', label: 'Transactional stream', type: 'text', secret: false, required: false, defaultValue: 'outbound' },
    { key: 'broadcastStream', label: 'Broadcast stream (marketing)', type: 'text', secret: false, required: false, defaultValue: 'broadcast' },
    { key: 'webhookUsername', label: 'Webhook username', type: 'text', secret: false, required: false },
    { key: 'webhookPassword', label: 'Webhook password', type: 'password', secret: true, required: false },
  ],
  webhook: {
    supported: true,
    instructions:
      'In Postmark → Webhooks, add the Morrow webhook URL with HTTP Basic authentication (the username and password above) and enable Delivery, Bounce, Spam Complaint, Open, Click and Subscription Change.',
  },
  create: (config, secrets) =>
    new PostmarkProvider({
      serverToken: secrets.serverToken ?? '',
      transactionalStream: str(config.transactionalStream) || undefined,
      broadcastStream: str(config.broadcastStream) || undefined,
      webhookUsername: str(config.webhookUsername) || undefined,
      webhookPassword: secrets.webhookPassword || undefined,
    }),
});

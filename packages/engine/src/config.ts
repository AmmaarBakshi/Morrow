/**
 * Engine configuration, normally loaded from environment variables.
 * See `.env.example` for documentation of every variable.
 */

export type Environment = 'development' | 'test' | 'production';

export interface DefaultEmailConfig {
  provider: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface EngineConfig {
  env: Environment;
  /** Public base URL used in e-mails (unsubscribe, tracking, verification links). */
  publicUrl: string;
  /** Web application URL used in internal notifications. */
  appUrl: string;
  /** Master secret for encryption at rest and signed links. ≥ 32 characters in production. */
  secretKey: string;
  /** Provider used when a workspace has not configured its own. */
  defaultEmail: DefaultEmailConfig | null;
  /** Allow the development provider (never enabled in production unless explicitly set). */
  allowDevProvider: boolean;
  /** From address for system e-mails (invitations, sender verification, alerts). */
  systemFrom: { email: string; name: string } | null;
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
  };
  scheduler: {
    intervalMs: number;
  };
  sessionTtlDays: number;
  /**
   * Allow anyone to create an account and workspace. The very first account
   * can always be created; afterwards people join by invitation unless this is on.
   */
  allowPublicSignup: boolean;
  /** Keep succeeded jobs this long before pruning (frees dedupe keys and space). */
  jobRetentionDays: number;
  /** Optional AI assistance configured for every workspace (workspaces may override). */
  ai: { provider: string; model: string | null; apiKey: string } | null;
}

const DEV_SECRET = 'morrow-development-secret-change-me-0123456789';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Build the default provider from MORROW_EMAIL_PROVIDER and its variables. */
function defaultEmailFromEnv(env: Record<string, string | undefined>, environment: Environment): DefaultEmailConfig | null {
  const provider = (env.MORROW_EMAIL_PROVIDER ?? (environment === 'production' ? '' : 'fake')).trim();
  switch (provider) {
    case '':
      return null;
    case 'fake':
      return { provider: 'fake', config: {}, secrets: {} };
    case 'smtp':
      return {
        provider: 'smtp',
        config: {
          host: env.SMTP_HOST ?? '',
          port: Number(env.SMTP_PORT ?? 587),
          secure: bool(env.SMTP_SECURE, false),
          username: env.SMTP_USERNAME ?? '',
        },
        secrets: { password: env.SMTP_PASSWORD ?? '' },
      };
    case 'resend':
      return { provider: 'resend', config: {}, secrets: { apiKey: env.RESEND_API_KEY ?? '', webhookSecret: env.RESEND_WEBHOOK_SECRET ?? '' } };
    case 'postmark':
      return {
        provider: 'postmark',
        config: {
          transactionalStream: env.POSTMARK_TRANSACTIONAL_STREAM ?? 'outbound',
          broadcastStream: env.POSTMARK_BROADCAST_STREAM ?? 'broadcast',
          webhookUsername: env.POSTMARK_WEBHOOK_USERNAME ?? '',
        },
        secrets: { serverToken: env.POSTMARK_SERVER_TOKEN ?? '', webhookPassword: env.POSTMARK_WEBHOOK_PASSWORD ?? '' },
      };
    default:
      throw new ConfigError(`Unknown MORROW_EMAIL_PROVIDER "${provider}". Use fake, smtp, resend or postmark.`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  const raw = (env.MORROW_ENV ?? env.NODE_ENV ?? 'development').toLowerCase();
  const environment: Environment = raw === 'production' ? 'production' : raw === 'test' ? 'test' : 'development';
  const secretKey = env.MORROW_SECRET_KEY ?? (environment === 'production' ? '' : DEV_SECRET);
  if (environment === 'production' && (secretKey.length < 32 || secretKey === DEV_SECRET)) {
    throw new ConfigError('MORROW_SECRET_KEY must be set to a random value of at least 32 characters in production. Run `morrow init` to generate one.');
  }
  const port = env.PORT ?? '4400';
  const publicUrl = (env.MORROW_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const appUrl = (env.MORROW_APP_URL ?? publicUrl).replace(/\/$/, '');
  if (environment === 'production' && !/^https:\/\//.test(publicUrl)) {
    throw new ConfigError('MORROW_PUBLIC_URL must be an https:// URL in production (it appears in unsubscribe links).');
  }
  const fromEmail = env.MORROW_SYSTEM_FROM_EMAIL;
  return {
    env: environment,
    publicUrl,
    appUrl,
    secretKey,
    defaultEmail: defaultEmailFromEnv(env, environment),
    allowDevProvider: bool(env.MORROW_ALLOW_DEV_PROVIDER, environment !== 'production'),
    systemFrom: fromEmail ? { email: fromEmail, name: env.MORROW_SYSTEM_FROM_NAME ?? 'Morrow' } : null,
    worker: {
      concurrency: int(env.MORROW_WORKER_CONCURRENCY, 4, 1, 64),
      pollIntervalMs: int(env.MORROW_WORKER_POLL_MS, 1000, 50, 60_000),
      leaseMs: int(env.MORROW_JOB_LEASE_MS, 120_000, 5_000, 3_600_000),
    },
    scheduler: {
      intervalMs: int(env.MORROW_SCHEDULER_INTERVAL_MS, 30_000, 1_000, 3_600_000),
    },
    sessionTtlDays: int(env.MORROW_SESSION_TTL_DAYS, 14, 1, 365),
    allowPublicSignup: bool(env.MORROW_ALLOW_SIGNUP, environment !== 'production'),
    jobRetentionDays: int(env.MORROW_JOB_RETENTION_DAYS, 30, 1, 3650),
    ai: env.MORROW_AI_PROVIDER
      ? { provider: env.MORROW_AI_PROVIDER, model: env.MORROW_AI_MODEL || null, apiKey: env.ANTHROPIC_API_KEY ?? '' }
      : null,
  };
}

/** Configuration for tests: deterministic, fake provider, no network. */
export function testConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    ...loadConfig({ MORROW_ENV: 'test', MORROW_PUBLIC_URL: 'https://morrow.test', MORROW_SECRET_KEY: 'test-secret-key-that-is-long-enough-0001' }),
    ...overrides,
  };
}

import { newId, NotFoundError, PreconditionError, ValidationError, type EmailIntegrationDTO, type ProviderInfoDTO } from '@morrow/core';
import {
  createProvider,
  getProviderDescriptor,
  listProviders,
  ProviderConfigError,
  type EmailProvider,
  type ProviderDescriptor,
} from '@morrow/email';
import { fromJson, toJson, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import { decryptJson, encryptJson } from '../crypto';
import type { Engine } from '../engine';

export interface ResolvedProvider {
  provider: EmailProvider;
  name: string;
  source: 'workspace' | 'environment' | 'override';
  integrationId: string | null;
}

function providerInfo(d: ProviderDescriptor): ProviderInfoDTO {
  return {
    name: d.name,
    label: d.label,
    description: d.description,
    docsUrl: d.docsUrl,
    developmentOnly: Boolean(d.developmentOnly),
    fields: d.fields,
    webhook: d.webhook,
  };
}

/**
 * E-mail (and AI) integration settings. Secrets are encrypted with
 * MORROW_SECRET_KEY and never returned — the API only reports which secrets
 * are set. A workspace without its own integration falls back to the
 * environment-configured provider.
 */
export class IntegrationsService {
  private readonly cache = new Map<string, { stamp: string; resolved: ResolvedProvider }>();

  constructor(private readonly e: Engine) {}

  private async row(workspaceId: string, kind: 'email' | 'ai'): Promise<Row<'integrations'> | undefined> {
    return this.e.db.selectFrom('integrations').selectAll().where('workspace_id', '=', workspaceId).where('kind', '=', kind).executeTakeFirst();
  }

  private allowed(name: string): boolean {
    const d = getProviderDescriptor(name);
    return Boolean(d) && (!d!.developmentOnly || this.e.config.allowDevProvider);
  }

  availableProviders(): ProviderInfoDTO[] {
    return listProviders()
      .filter((d) => !d.developmentOnly || this.e.config.allowDevProvider)
      .map(providerInfo);
  }

  webhookUrl(provider: string, integrationId: string | 'default'): string {
    return `${this.e.config.publicUrl}/webhooks/${provider}/${integrationId}`;
  }

  /** The provider used to send for a workspace, or null when none is configured. */
  async resolveEmailProvider(workspaceId: string): Promise<ResolvedProvider | null> {
    if (this.e.providerOverride) {
      return { provider: this.e.providerOverride, name: this.e.providerOverride.name, source: 'override', integrationId: null };
    }
    const row = await this.row(workspaceId, 'email');
    if (row && this.allowed(row.provider)) {
      const stamp = `ws:${row.id}:${row.updated_at}`;
      const hit = this.cache.get(workspaceId);
      if (hit && hit.stamp === stamp) return hit.resolved;
      try {
        const provider = createProvider(row.provider, fromJson(row.config, {}), decryptJson(row.secrets, this.e.config.secretKey));
        const resolved: ResolvedProvider = { provider, name: row.provider, source: 'workspace', integrationId: row.id };
        this.cache.set(workspaceId, { stamp, resolved });
        return resolved;
      } catch (err) {
        this.e.log.warn('workspace e-mail provider is misconfigured', { workspaceId, error: err as Error });
        return null;
      }
    }
    const env = this.e.config.defaultEmail;
    if (env && this.allowed(env.provider)) {
      const stamp = `env:${env.provider}`;
      const hit = this.cache.get(`env`);
      if (hit && hit.stamp === stamp) return hit.resolved;
      try {
        const provider = createProvider(env.provider, env.config, env.secrets);
        const resolved: ResolvedProvider = { provider, name: env.provider, source: 'environment', integrationId: null };
        this.cache.set('env', { stamp, resolved });
        return resolved;
      } catch (err) {
        this.e.log.warn('environment e-mail provider is misconfigured', { error: err as Error });
        return null;
      }
    }
    return null;
  }

  /** Provider instance able to verify webhooks for an incoming request. */
  async webhookProvider(providerName: string, integrationId: string): Promise<{ provider: EmailProvider; workspaceId: string | null } | null> {
    if (integrationId === 'default') {
      const env = this.e.config.defaultEmail;
      if (!env || env.provider !== providerName) return null;
      return { provider: createProvider(env.provider, env.config, env.secrets), workspaceId: null };
    }
    const row = await this.e.db.selectFrom('integrations').selectAll().where('id', '=', integrationId).executeTakeFirst();
    if (!row || row.kind !== 'email' || row.provider !== providerName) return null;
    return {
      provider: createProvider(row.provider, fromJson(row.config, {}), decryptJson(row.secrets, this.e.config.secretKey)),
      workspaceId: row.workspace_id,
    };
  }

  async getEmail(ctx: WorkspaceContext): Promise<EmailIntegrationDTO> {
    authorize(ctx, 'workspace:read');
    const row = await this.row(ctx.workspaceId, 'email');
    const providers = this.availableProviders();
    if (row) {
      const d = getProviderDescriptor(row.provider);
      const secrets = decryptJson(row.secrets, this.e.config.secretKey);
      const resolved = await this.resolveEmailProvider(ctx.workspaceId);
      return {
        source: 'workspace',
        provider: row.provider,
        providerLabel: d?.label ?? row.provider,
        config: fromJson(row.config, {}),
        secretsSet: Object.fromEntries((d?.fields ?? []).filter((f) => f.secret).map((f) => [f.key, Boolean(secrets[f.key])])),
        status: row.status as EmailIntegrationDTO['status'],
        lastTestedAt: row.last_tested_at,
        lastTestResult: row.last_test_result,
        webhookUrl: d?.webhook.supported ? this.webhookUrl(row.provider, row.id) : null,
        capabilities: resolved?.provider.capabilities ?? null,
        providers,
      };
    }
    const env = this.e.config.defaultEmail;
    if (env && this.allowed(env.provider)) {
      const d = getProviderDescriptor(env.provider);
      const resolved = await this.resolveEmailProvider(ctx.workspaceId);
      return {
        source: 'environment',
        provider: env.provider,
        providerLabel: d?.label ?? env.provider,
        config: {},
        secretsSet: {},
        status: resolved ? 'ok' : 'error',
        lastTestedAt: null,
        lastTestResult: resolved ? null : 'The environment provider is missing required settings.',
        webhookUrl: d?.webhook.supported ? this.webhookUrl(env.provider, 'default') : null,
        capabilities: resolved?.provider.capabilities ?? null,
        providers,
      };
    }
    return {
      source: 'none',
      provider: null,
      providerLabel: null,
      config: {},
      secretsSet: {},
      status: 'unconfigured',
      lastTestedAt: null,
      lastTestResult: null,
      webhookUrl: null,
      capabilities: null,
      providers,
    };
  }

  /**
   * Save provider settings. For secrets, an empty string keeps the stored
   * value and `null` clears it, so forms never need to echo secrets back.
   */
  async setEmail(
    ctx: WorkspaceContext,
    input: { provider: string; config?: Record<string, unknown>; secrets?: Record<string, string | null> },
  ): Promise<EmailIntegrationDTO> {
    authorize(ctx, 'integrations:manage');
    const d = getProviderDescriptor(input.provider);
    if (!d || !this.allowed(input.provider)) throw new ValidationError(`Unknown or unavailable provider "${input.provider}".`, [{ path: 'provider', message: 'Unknown provider.' }]);
    const existing = await this.row(ctx.workspaceId, 'email');
    const config: Record<string, unknown> = {};
    for (const f of d.fields.filter((x) => !x.secret)) {
      const v = input.config?.[f.key];
      if (v === undefined || v === null || v === '') continue;
      config[f.key] = f.type === 'number' ? Number(v) : f.type === 'boolean' ? v === true || v === 'true' : String(v).slice(0, 500);
    }
    const previous = existing && existing.provider === input.provider ? decryptJson(existing.secrets, this.e.config.secretKey) : {};
    const secrets: Record<string, string> = { ...previous };
    for (const f of d.fields.filter((x) => x.secret)) {
      const v = input.secrets?.[f.key];
      if (v === null) delete secrets[f.key];
      else if (typeof v === 'string' && v !== '') secrets[f.key] = v.slice(0, 2000);
    }
    try {
      createProvider(input.provider, config, secrets);
    } catch (err) {
      if (err instanceof ProviderConfigError) {
        throw new ValidationError(err.message, err.missing.map((m) => ({ path: m, message: 'Required.' })));
      }
      throw err;
    }
    const now = this.e.nowIso();
    const values = {
      provider: input.provider,
      config: toJson(config),
      secrets: Object.keys(secrets).length ? encryptJson(secrets, this.e.config.secretKey) : null,
      status: 'unconfigured',
      last_tested_at: null,
      last_test_result: null,
      updated_at: now,
    };
    if (existing) {
      await this.e.db.updateTable('integrations').set(values).where('id', '=', existing.id).execute();
    } else {
      await this.e.db
        .insertInto('integrations')
        .values({ id: newId('int'), workspace_id: ctx.workspaceId, kind: 'email', webhook_secret: null, created_at: now, ...values })
        .execute();
    }
    this.cache.delete(ctx.workspaceId);
    await this.e.audit.record(ctx, 'integration.email.updated', { type: 'integration', id: existing?.id ?? 'new' }, {
      provider: input.provider,
      secretsChanged: Object.keys(input.secrets ?? {}).filter((k) => input.secrets?.[k] !== ''),
    });
    return this.getEmail(ctx);
  }

  async testEmail(ctx: WorkspaceContext): Promise<{ ok: boolean; message: string }> {
    authorize(ctx, 'integrations:manage');
    const resolved = await this.resolveEmailProvider(ctx.workspaceId);
    if (!resolved) throw new PreconditionError('No e-mail provider is configured for this workspace.');
    const result = await resolved.provider.verify().catch((err: Error) => ({ ok: false, message: err.message }));
    if (resolved.source === 'workspace' && resolved.integrationId) {
      await this.e.db
        .updateTable('integrations')
        .set({ status: result.ok ? 'ok' : 'error', last_tested_at: this.e.nowIso(), last_test_result: result.message.slice(0, 500) })
        .where('id', '=', resolved.integrationId)
        .execute();
      this.cache.delete(ctx.workspaceId);
    }
    await this.e.audit.record(ctx, 'integration.email.tested', null, { provider: resolved.name, ok: result.ok });
    return { ok: result.ok, message: result.message };
  }

  async removeEmail(ctx: WorkspaceContext): Promise<void> {
    authorize(ctx, 'integrations:manage');
    const row = await this.row(ctx.workspaceId, 'email');
    if (!row) throw new NotFoundError('E-mail integration');
    await this.e.db.deleteFrom('integrations').where('id', '=', row.id).execute();
    this.cache.delete(ctx.workspaceId);
    await this.e.audit.record(ctx, 'integration.email.removed', { type: 'integration', id: row.id }, { provider: row.provider });
  }

  // ---------------------------------------------------------------- AI

  async aiSettings(workspaceId: string): Promise<{ provider: string; config: Record<string, unknown>; secrets: Record<string, string> } | null> {
    const row = await this.row(workspaceId, 'ai');
    if (!row) return null;
    return { provider: row.provider, config: fromJson(row.config, {}), secrets: decryptJson(row.secrets, this.e.config.secretKey) };
  }

  async setAi(
    ctx: WorkspaceContext,
    input: { provider: string | null; config?: Record<string, unknown>; secrets?: Record<string, string | null> },
  ): Promise<void> {
    authorize(ctx, 'integrations:manage');
    const existing = await this.row(ctx.workspaceId, 'ai');
    if (!input.provider) {
      if (existing) await this.e.db.deleteFrom('integrations').where('id', '=', existing.id).execute();
      await this.e.audit.record(ctx, 'integration.ai.disabled');
      return;
    }
    const previous = existing && existing.provider === input.provider ? decryptJson(existing.secrets, this.e.config.secretKey) : {};
    const secrets: Record<string, string> = { ...previous };
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (v === null) delete secrets[k];
      else if (v) secrets[k] = v.slice(0, 2000);
    }
    const config = Object.fromEntries(
      Object.entries(input.config ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v]),
    );
    const now = this.e.nowIso();
    const values = {
      provider: input.provider,
      config: toJson(config),
      secrets: Object.keys(secrets).length ? encryptJson(secrets, this.e.config.secretKey) : null,
      status: 'ok',
      updated_at: now,
    };
    if (existing) await this.e.db.updateTable('integrations').set(values).where('id', '=', existing.id).execute();
    else
      await this.e.db
        .insertInto('integrations')
        .values({ id: newId('int'), workspace_id: ctx.workspaceId, kind: 'ai', webhook_secret: null, last_tested_at: null, last_test_result: null, created_at: now, ...values })
        .execute();
    await this.e.audit.record(ctx, 'integration.ai.updated', null, { provider: input.provider });
  }
}

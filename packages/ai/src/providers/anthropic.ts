import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiError, type AiJsonRequest, type AiProvider } from '../types';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  /** Injected client for tests. */
  client?: Anthropic;
}

/**
 * Claude via the official Anthropic SDK. Uses structured outputs so every
 * response is schema-validated JSON, and opts into server-side refusal
 * fallbacks so a policy decline is retried on the configured fallback model.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey && !options.client) throw new AiError('auth', 'An Anthropic API key is required.');
    this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 2, timeout: 120_000 });
  }

  async generateJson<T>(request: AiJsonRequest<T>): Promise<T> {
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: request.system,
        output_config: { effort: request.effort ?? 'medium', format: betaZodOutputFormat(request.schema) },
        messages: [{ role: 'user', content: request.prompt }],
      });
      if (response.stop_reason === 'refusal') {
        throw new AiError('refused', response.stop_details?.explanation ?? 'The model declined this request.');
      }
      if (response.stop_reason === 'max_tokens') throw new AiError('invalid_output', 'The response was cut off. Try a shorter request.');
      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new AiError('invalid_output', 'The model returned an unexpected format.');
      }
      return response.parsed_output as T;
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiError('auth', 'The Anthropic API key was rejected.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new AiError('rate_limited', 'The AI provider is rate limiting requests. Try again shortly.');
      if (err instanceof Anthropic.BadRequestError) throw new AiError('invalid_output', `The AI request was rejected: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new AiError('unavailable', `The AI provider returned an error (${err.status ?? 'network'}).`);
      throw new AiError('unavailable', (err as Error).message ?? 'The AI provider could not be reached.');
    }
  }
}

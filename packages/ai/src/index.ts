import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic';
import { AiError, type AiProvider } from './types';

export * from './types';
export * from './assistant';
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic';

export interface AiProviderInfo {
  name: string;
  label: string;
  defaultModel: string;
  fields: Array<{ key: string; label: string; secret: boolean; required: boolean; placeholder?: string }>;
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    name: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'sk-ant-…' },
      { key: 'model', label: 'Model', secret: false, required: false, placeholder: DEFAULT_ANTHROPIC_MODEL },
    ],
  },
];

/**
 * Create an AI provider. AI is optional: callers treat a missing provider as
 * "AI assistance disabled" and every other feature keeps working.
 */
export function createAiProvider(name: string, config: Record<string, unknown> = {}, secrets: Record<string, string> = {}): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: secrets.apiKey ?? '', model: typeof config.model === 'string' ? config.model : undefined });
    default:
      throw new AiError('disabled', `Unknown AI provider "${name}".`);
  }
}

import type { z } from 'zod';

/**
 * Provider-independent AI contract. Morrow only ever asks for structured JSON,
 * so any provider that can follow a schema can be plugged in. AI output is
 * always a draft for a human to review — it never sends, approves or bypasses
 * consent, suppression or sending limits.
 */
export interface AiJsonRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateJson<T>(request: AiJsonRequest<T>): Promise<T>;
}

export type AiErrorCode = 'disabled' | 'refused' | 'invalid_output' | 'rate_limited' | 'auth' | 'unavailable';

export class AiError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

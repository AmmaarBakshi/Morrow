import { MorrowApiError, MorrowNetworkError } from './errors';

export type QueryValue = string | number | boolean | null | undefined | string[];
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Send a raw string body (e.g. CSV) with this content type instead of JSON. */
  raw?: { body: string; contentType: string };
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface TransportOptions {
  /** Server origin, e.g. `https://morrow.example.com` (no /api/v1). */
  baseUrl: string;
  /** API key (`mrw_…`) or a session token from `auth.login({ issueToken: true })`. */
  token?: string | null;
  /** Act in this workspace (sessions only; API keys are bound to one workspace). */
  workspaceId?: string | null;
  /** Browser use: include cookies and echo this CSRF token on writes. */
  credentials?: 'include' | 'same-origin' | 'omit';
  csrfToken?: string | (() => string | null | undefined) | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Minimal fetch wrapper: JSON in and out, typed errors, timeouts. */
export class Transport {
  constructor(public options: TransportOptions) {}

  url(path: string, query?: Query): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/api/v1${path}${buildQuery(query)}`;
  }

  async send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    let body: string | undefined;
    if (options.raw) {
      headers['content-type'] = options.raw.contentType;
      body = options.raw.body;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const { token, workspaceId, csrfToken, userAgent } = this.options;
    if (token) headers.authorization = `Bearer ${token}`;
    if (workspaceId) headers['x-morrow-workspace'] = workspaceId;
    if (userAgent) headers['user-agent'] = userAgent;
    if (method !== 'GET' && csrfToken) {
      const value = typeof csrfToken === 'function' ? csrfToken() : csrfToken;
      if (value) headers['x-csrf-token'] = value;
    }
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const timeout = this.options.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      res = await doFetch(this.url(path, options.query), { method, headers, body, credentials: this.options.credentials, signal: controller.signal });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      throw new MorrowNetworkError(aborted ? `Request timed out after ${timeout} ms` : `Could not reach Morrow at ${this.options.baseUrl}: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async json<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const res = await this.send(method, path, options);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async text(method: string, path: string, options?: RequestOptions): Promise<string> {
    return (await this.send(method, path, options)).text();
  }
}

async function toApiError(res: Response): Promise<MorrowApiError> {
  const requestId = res.headers.get('x-request-id');
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
    if (parsed.error) return new MorrowApiError(res.status, parsed.error.code ?? 'error', parsed.error.message ?? res.statusText, parsed.error.details, requestId);
  } catch {
    // Not JSON (proxy error page, etc.).
  }
  return new MorrowApiError(res.status, res.status === 404 ? 'not_found' : 'http_error', text.slice(0, 300) || res.statusText || `HTTP ${res.status}`, undefined, requestId);
}

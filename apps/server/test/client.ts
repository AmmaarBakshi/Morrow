import { createHarness, type Harness, type HarnessOptions } from '@morrow/engine/testing';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/http/rate-limit';
import type { ServerOptions } from '../src/types';

export interface TestResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

/** A tiny browser: keeps the session cookie and echoes the CSRF token like the web app does. */
export class TestClient {
  cookie: string | null = null;
  csrf: string | null = null;
  bearer: string | null = null;

  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly ip = '203.0.113.7',
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<TestResponse<T>> {
    const h = new Headers(headers);
    if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
    if (this.cookie) h.set('cookie', this.cookie);
    if (this.csrf && !h.has('x-csrf-token')) h.set('x-csrf-token', this.csrf);
    if (this.bearer) h.set('authorization', `Bearer ${this.bearer}`);
    h.set('x-forwarded-for', this.ip);
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await this.app.request(path, { method, headers: h, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie?.startsWith('morrow_session=')) {
      const value = setCookie.split(';')[0]!;
      this.cookie = value === 'morrow_session=' ? null : value;
    }
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('application/json')) parsed = JSON.parse(text);
    return { status: res.status, headers: res.headers, body: parsed as T, text };
  }

  get = <T = any>(path: string, headers?: Record<string, string>) => this.request<T>('GET', path, undefined, headers);
  post = <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => this.request<T>('POST', path, body, headers);
  patch = <T = any>(path: string, body: unknown = {}) => this.request<T>('PATCH', path, body);
  put = <T = any>(path: string, body: unknown = {}) => this.request<T>('PUT', path, body);
  delete = <T = any>(path: string, body?: unknown) => this.request<T>('DELETE', path, body);

  /** Sign in as the harness owner and keep the cookie + CSRF token. */
  async login(email = 'owner@cyphen.dev', password = 'correct horse battery staple'): Promise<TestResponse> {
    const res = await this.post('/api/v1/auth/login', { email, password });
    if (res.status === 200) this.csrf = res.body.session.csrfToken;
    return res;
  }
}

export interface ServerHarness extends Harness {
  app: ReturnType<typeof createApp>;
  limiter: RateLimiter;
  client(ip?: string): TestClient;
}

export async function createServerHarness(options: HarnessOptions & { server?: Partial<ServerOptions> } = {}): Promise<ServerHarness> {
  const h = await createHarness(options);
  const limiter = new RateLimiter(() => h.clock.now().getTime());
  const app = createApp({ engine: h.engine, limiter, trustProxy: true, ...options.server });
  return Object.assign(h, { app, limiter, client: (ip?: string) => new TestClient(app, ip) });
}

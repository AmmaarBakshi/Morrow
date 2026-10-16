import { MorrowClient } from '@morrow/sdk';
import { readConfig, type Profile } from './config';
import { Output, type Writer } from './output';

export interface GlobalOptions {
  json?: boolean;
  profile?: string;
  url?: string;
  token?: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliContext {
  output: Output;
  options: GlobalOptions;
  env: NodeJS.ProcessEnv;
  /** Lazily resolves credentials; ops commands never need them. */
  client(): MorrowClient;
  profileName(): string;
  profile(): Profile | null;
  fetch?: typeof fetch;
}

export function createContext(options: GlobalOptions, deps: { env?: NodeJS.ProcessEnv; writer?: Writer; fetch?: typeof fetch } = {}): CliContext {
  const env = deps.env ?? process.env;
  const output = new Output(Boolean(options.json), deps.writer);
  const profileName = () => options.profile ?? env.MORROW_PROFILE ?? readConfig().current;
  const profile = () => readConfig().profiles[profileName()] ?? null;
  let client: MorrowClient | null = null;
  return {
    output,
    options,
    env,
    fetch: deps.fetch,
    profileName,
    profile,
    client() {
      if (client) return client;
      const p = profile();
      const url = options.url ?? env.MORROW_URL ?? p?.url;
      const token = options.token ?? env.MORROW_API_KEY ?? env.MORROW_TOKEN ?? p?.token;
      if (!url || !token) {
        throw new CliError('Not signed in. Run `morrow login --url <server> --api-key <key>` or set MORROW_URL and MORROW_API_KEY.');
      }
      client = new MorrowClient({ baseUrl: url, token, workspaceId: p?.kind === 'session' ? p.workspaceId ?? null : null, fetch: deps.fetch, userAgent: 'morrow-cli' });
      return client;
    },
  };
}

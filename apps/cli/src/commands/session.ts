import pc from 'picocolors';
import { MorrowClient } from '@morrow/sdk';
import { readConfig, removeProfile, saveProfile } from '../config';
import { CliError } from '../context';
import { ask, readStdin } from '../prompt';
import type { Register } from './ops';

/** login, logout, whoami and profiles. */
export const registerSession: Register = (program, run) => {
  program
    .command('login')
    .description('connect the CLI to a Morrow server with an API key or your account')
    .option('--url <url>', 'server URL', process.env.MORROW_URL ?? 'http://localhost:4400')
    .option('--api-key <key>', 'API key (create one in Settings → API keys)')
    .option('--email <email>', 'sign in with an account instead of an API key')
    .option('--password-stdin', 'read the password from stdin')
    .option('--name <profile>', 'save as this profile', 'default')
    .action(
      run(async (ctx, opts: { url: string; apiKey?: string; email?: string; passwordStdin?: boolean; name: string }) => {
        const url = opts.url.replace(/\/+$/, '');
        const base = new MorrowClient({ baseUrl: url, fetch: ctx.fetch, userAgent: 'morrow-cli' });
        let token: string;
        let kind: 'api_key' | 'session';
        if (opts.apiKey) {
          token = opts.apiKey.trim();
          kind = 'api_key';
        } else {
          const email = opts.email ?? (await ask('E-mail: '));
          const password = opts.passwordStdin ? (await readStdin()).trim() : await ask('Password: ', { hidden: true });
          const res = await base.auth.login({ email, password, issueToken: true });
          if (!res.token) throw new CliError('The server did not issue a token.');
          token = res.token;
          kind = 'session';
        }
        const who = await base.configure({ token }).auth.whoami();
        const label = who.user ? `${who.user.name} <${who.user.email}>` : `API key "${who.apiKey?.name}"`;
        saveProfile(opts.name, { url, token, kind, label, workspaceId: who.workspace.id });
        ctx.output.result({ profile: opts.name, url, kind, workspace: who.workspace.name, role: who.role }, () =>
          ctx.output.success(`Signed in to ${pc.bold(who.workspace.name)} as ${label} (${who.role}) — profile "${opts.name}"`),
        );
      }),
    );

  program
    .command('logout')
    .description('forget the saved credentials (and end the session on the server)')
    .action(
      run(async (ctx) => {
        const name = ctx.profileName();
        const p = ctx.profile();
        if (!p) throw new CliError(`No profile named "${name}".`);
        if (p.kind === 'session') await ctx.client().auth.logout().catch(() => undefined);
        removeProfile(name);
        ctx.output.result({ profile: name, removed: true }, () => ctx.output.success(`Signed out of profile "${name}"`));
      }),
    );

  program
    .command('whoami')
    .description('show who the CLI is acting as')
    .action(
      run(async (ctx) => {
        const who = await ctx.client().auth.whoami();
        ctx.output.result(who, () =>
          ctx.output.fields([
            ['Workspace', `${who.workspace.name} (${who.workspace.id})`],
            ['As', who.user ? `${who.user.name} <${who.user.email}>` : `API key "${who.apiKey?.name}"`],
            ['Role', who.role],
            ['Time zone', who.workspace.timezone],
            ['Profile', ctx.profileName()],
          ]),
        );
      }),
    );

  program
    .command('profiles')
    .description('list saved server profiles')
    .action(
      run(async (ctx) => {
        const config = readConfig();
        const rows = Object.entries(config.profiles).map(([name, p]) => ({ name, current: name === config.current, url: p.url, kind: p.kind, label: p.label ?? '' }));
        ctx.output.result(rows, () =>
          ctx.output.table(
            rows,
            [
              { label: '', value: (r) => (r.current ? pc.green('●') : ' ') },
              { label: 'Profile', value: (r) => r.name },
              { label: 'Server', value: (r) => r.url },
              { label: 'Credential', value: (r) => r.kind },
              { label: 'Identity', value: (r) => r.label },
            ],
            'No profiles yet. Run `morrow login`.',
          ),
        );
      }),
    );
};

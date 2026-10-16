import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { MorrowApiError, MorrowNetworkError } from '@morrow/sdk';
import { MORROW_VERSION } from '@morrow/engine';
import { registerAutomations } from './commands/automations';
import { registerCampaigns } from './commands/campaigns';
import { registerContacts } from './commands/contacts';
import { registerOps } from './commands/ops';
import { registerSession } from './commands/session';
import { registerWorkspace } from './commands/workspace';
import { CliError, createContext, type CliContext, type GlobalOptions } from './context';
import { processWriter, type Writer } from './output';

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  writer?: Writer;
  fetch?: typeof fetch;
}

/** Map any failure to a message and an exit code (1 = failed, 2 = could not connect). */
export function reportError(ctx: CliContext, err: unknown): number {
  if (err instanceof MorrowApiError) {
    if (ctx.output.json) ctx.output.result({ error: { status: err.status, code: err.code, message: err.message, details: err.details, requestId: err.requestId } });
    else {
      ctx.output.error(err.message);
      for (const issue of err.issues) ctx.output.error(`  ${issue.path || 'input'}: ${issue.message}`);
      if (err.status === 401) ctx.output.error(pc.dim('  Run `morrow login` to sign in again.'));
      if (err.retryAfterSeconds) ctx.output.error(pc.dim(`  Try again in ${err.retryAfterSeconds}s.`));
    }
    return 1;
  }
  const message = (err as Error)?.message ?? String(err);
  if (ctx.output.json) ctx.output.result({ error: { code: err instanceof MorrowNetworkError ? 'network_error' : 'cli_error', message } });
  else ctx.output.error(message);
  if (ctx.env.MORROW_DEBUG && err instanceof Error && err.stack) ctx.output.error(pc.dim(err.stack));
  if (err instanceof MorrowNetworkError) return 2;
  if (err instanceof CliError) return err.exitCode;
  return 1;
}

export function buildProgram(deps: CliDeps = {}, onExit: (code: number) => void = () => undefined): Command {
  const writer = deps.writer ?? processWriter;
  const program = new Command('morrow')
    .description('Morrow — automated e-mail and relationship management for software teams.')
    .version(MORROW_VERSION, '-v, --version')
    .option('--json', 'machine-readable JSON output')
    .option('--profile <name>', 'use a saved server profile')
    .option('--url <url>', 'server URL (overrides the profile)')
    .option('--token <token>', 'API key or session token (overrides the profile)')
    .showHelpAfterError('(add --help for usage)')
    .configureOutput({ writeOut: (s) => writer.out(s), writeErr: (s) => writer.err(s) })
    .exitOverride();

  const run =
    (action: (ctx: CliContext, ...args: any[]) => Promise<void>) =>
    async (...args: any[]): Promise<void> => {
      const cmd = args[args.length - 1] as Command;
      const ctx = createContext(cmd.optsWithGlobals() as GlobalOptions, { ...deps, writer });
      try {
        await action(ctx, ...args.slice(0, -1));
      } catch (err) {
        onExit(reportError(ctx, err));
      }
    };

  registerOps(program, run);
  registerSession(program, run);
  registerContacts(program, run);
  registerAutomations(program, run);
  registerCampaigns(program, run);
  registerWorkspace(program, run);

  // Subcommands inherit output routing and must not exit the process themselves.
  const configure = (cmd: Command) => {
    for (const sub of cmd.commands) {
      sub.configureOutput({ writeOut: (s) => writer.out(s), writeErr: (s) => writer.err(s) }).exitOverride();
      configure(sub);
    }
  };
  configure(program);
  return program;
}

/** Run the CLI and resolve with the exit code (never calls process.exit). */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  let code = 0;
  const program = buildProgram(deps, (c) => (code = c));
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
  return code;
}

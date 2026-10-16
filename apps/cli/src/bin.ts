/**
 * `morrow` entry point. Loads ./.env when present so operator commands see
 * the same configuration as the server.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCli } from './program';

const envFile = resolve(process.env.MORROW_ENV_FILE ?? '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    process.stderr.write(`Could not read ${envFile}: ${(err as Error).message}\n`);
  }
}

runCli(process.argv.slice(2))
  .then((code) => {
    // Long-running commands (start, worker…) keep the event loop alive themselves.
    process.exitCode = code;
  })
  .catch((err: Error) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });

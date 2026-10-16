#!/usr/bin/env node
/**
 * `npm run dev`: API + worker + scheduler with reload (port 4400) and the
 * Vite dev server for the web app (port 5173, proxying /api to 4400).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const colors = { api: '\x1b[36m', web: '\x1b[35m' };
const reset = '\x1b[0m';

if (!existsSync('.env')) {
  console.log('No .env found — using development defaults. Run `npm run morrow -- init` to create one.');
}

const children = [];
function start(name, args, env = {}) {
  const child = spawn(npx, args, { env: { ...process.env, FORCE_COLOR: '1', ...env }, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${colors[name]}${name.padEnd(3)}${reset} │ `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const envFile = existsSync('.env') ? ['--env-file=.env'] : [];
start('api', ['tsx', 'watch', '--clear-screen=false', ...envFile, 'apps/cli/src/bin.ts', 'start', '--no-web']);
start('web', ['vite', '--config', 'apps/web/vite.config.ts']);

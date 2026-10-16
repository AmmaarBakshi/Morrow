#!/usr/bin/env node
/**
 * Run the test suite against PostgreSQL (embedded PGlite — no server needed).
 * Extra arguments are passed to vitest, e.g. `npm run test:pg -- packages/engine`.
 */
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const result = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, MORROW_TEST_DB: 'postgres' },
});
process.exit(result.status ?? 1);

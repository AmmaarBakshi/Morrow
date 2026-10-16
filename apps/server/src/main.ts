/**
 * `tsx src/main.ts` / `node dist/main.js` — run Morrow from the server package.
 * MORROW_ROLES picks the processes (default: server,worker,scheduler).
 */
import { handleSignals, startRuntime, type RuntimeRole } from './runtime';

const roles = (process.env.MORROW_ROLES ?? 'server,worker,scheduler')
  .split(',')
  .map((r) => r.trim())
  .filter((r): r is RuntimeRole => r === 'server' || r === 'worker' || r === 'scheduler');

startRuntime({ roles: roles.length ? roles : undefined })
  .then(handleSignals)
  .catch((err: Error) => {
    console.error(`Morrow failed to start: ${err.message}`);
    process.exit(1);
  });

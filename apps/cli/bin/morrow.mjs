#!/usr/bin/env node
// Launcher: run the bundled build when present, otherwise the TypeScript source via tsx.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'bin.js');

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(join(here, '..', 'src', 'bin.ts')).href);
}

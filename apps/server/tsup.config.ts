import { defineConfig } from 'tsup';

/**
 * Bundle the server with the workspace packages (which ship TypeScript
 * source) into plain ESM for `node dist/main.js`. Native and CommonJS-heavy
 * dependencies stay external and are installed from npm.
 */
export default defineConfig({
  entry: { main: 'src/main.ts', index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@morrow\//],
  external: ['better-sqlite3', 'pg', 'pg-native', '@electric-sql/pglite', 'nodemailer', '@anthropic-ai/sdk'],
  banner: { js: "import { createRequire as __morrowCreateRequire } from 'node:module'; const require = __morrowCreateRequire(import.meta.url);" },
});

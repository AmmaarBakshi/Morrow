import { defineConfig } from 'tsup';

/** Bundle `morrow` (with the server runtime for `morrow start`) into dist/bin.js. */
export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@morrow\//],
  external: ['better-sqlite3', 'pg', 'pg-native', '@electric-sql/pglite', 'nodemailer', '@anthropic-ai/sdk', 'tsx'],
  banner: { js: "import { createRequire as __morrowCreateRequire } from 'node:module'; const require = __morrowCreateRequire(import.meta.url);" },
});

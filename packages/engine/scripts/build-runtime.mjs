// Bundles the browser runtime (src/runtime/main.ts) into dist/runtime/runtime.js.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'runtime', 'runtime.js');
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'runtime', 'main.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`runtime bundle written to ${outfile}`);

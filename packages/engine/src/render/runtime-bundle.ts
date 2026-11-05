/**
 * The browser runtime as a script string.
 *
 * An installed package ships it prebuilt (dist/runtime/runtime.js). In a source checkout the
 * prebuilt file may be stale, so the runtime is bundled from source with esbuild instead, in
 * memory, once per process.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MergeStoryError } from '../core/errors.ts';

let cached: Promise<string> | null = null;

async function bundleFromSource(entry: string): Promise<string | null> {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = await import('esbuild');
  } catch {
    return null; // esbuild is a development dependency
  }
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      logLevel: 'silent',
    });
    const output = result.outputFiles[0];
    if (!output) throw new Error('esbuild produced no output');
    return output.text;
  } catch (err) {
    throw new MergeStoryError('RENDER_FAILED', 'The video runtime could not be bundled from source.', {
      hint: 'Fix the error in src/runtime or run "npm run build:runtime".',
      cause: err,
    });
  }
}

async function load(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceEntry = join(here, '..', 'runtime', 'main.ts');
  if (existsSync(sourceEntry)) {
    const bundled = await bundleFromSource(sourceEntry);
    if (bundled !== null) return bundled;
  }
  // From dist/render the bundle is ../runtime/runtime.js; from src/render it is ../../dist/runtime/runtime.js.
  for (const file of [
    join(here, '..', 'runtime', 'runtime.js'),
    join(here, '..', '..', 'dist', 'runtime', 'runtime.js'),
  ]) {
    if (existsSync(file)) return readFile(file, 'utf8');
  }
  throw new MergeStoryError('RENDER_FAILED', 'The video runtime is missing.', {
    hint: 'Run "npm run build" (or "npm run build:runtime") in the engine package, or reinstall mergestory.',
  });
}

/** The runtime script (an IIFE that defines window.__MERGESTORY__). Cached for the process. */
export function loadRuntimeBundle(): Promise<string> {
  cached ??= load().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

/** mergestory cache clear */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { CacheNamespace } from '../../core/cache.ts';
import type { CliRuntime } from '../runtime.ts';
import { loadConfig } from './shared.ts';

/** The only folders this command removes, so a mistaken MERGESTORY_HOME can never delete anything else. */
const NAMESPACES: CacheNamespace[] = ['tts', 'llm', 'files'];

/** Add the `cache` command. */
export function registerCache(program: Command, rt: CliRuntime): void {
  const cache = program
    .command('cache')
    .description('Manage the local cache of speech clips and model answers');
  cache
    .command('clear')
    .description('Delete everything in the cache')
    .action(async (_options: unknown, cmd: Command) => {
      const env = rt.env(cmd);
      const config = await loadConfig(env);
      const { homeLayout } = await import('../../core/paths.ts');
      const { cache: root } = homeLayout(config.home);
      const cleared: CacheNamespace[] = [];
      for (const name of NAMESPACES) {
        const dir = join(root, name);
        if (!(await stat(dir).catch(() => null))) continue;
        await rm(dir, { recursive: true, force: true });
        cleared.push(name);
      }
      if (env.json) {
        env.emitJson({ ok: true, path: root, cleared });
        return;
      }
      env.say(cleared.length > 0 ? `Cache cleared: ${root}` : `The cache is already empty: ${root}`);
      if (cleared.length > 0)
        env.say('A paid speech or model provider may bill again for work that was cached.');
    });
}

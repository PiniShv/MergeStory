/** mergestory theme preview */
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { CliRuntime } from '../runtime.ts';
import { loadConfig } from './shared.ts';

interface PreviewFlags {
  out?: string;
  allowLowContrast?: boolean;
}

/** Add the `theme` command. */
export function registerTheme(program: Command, rt: CliRuntime): void {
  const theme = program.command('theme').description('Look at the video themes');
  theme
    .command('preview')
    .description(
      'Draw a theme on sample scenes and show the stills on one page. No model, no voice, no network',
    )
    .argument(
      '<theme>',
      'midnight, paper, high-contrast, terminal, a theme of yours in ~/.mergestory/themes, or the path of a theme folder',
    )
    .option('--out <dir>', 'folder for the stills and the page (default: ~/.mergestory/previews/<theme>)')
    .option('--allow-low-contrast', 'draw a theme that fails the contrast check, with a warning')
    .action(async (value: string, flags: PreviewFlags, cmd: Command) => {
      const env = rt.env(cmd);
      const config = await loadConfig(env);
      // Loaded here, so that --help and the small commands stay quick to start.
      const [{ THEME_NAME }, { loadTheme }, { homeLayout }, { createRunContext }, { previewTheme }] =
        await Promise.all([
          import('../../core/config.ts'),
          import('../../core/theme.ts'),
          import('../../core/paths.ts'),
          import('../../core/context.ts'),
          import('../../render/theme-preview.ts'),
        ]);
      const resolved = await loadTheme(THEME_NAME.test(value) ? value : resolve(env.io.cwd, value), {
        home: config.home,
        allowLowContrast: flags.allowLowContrast === true,
        warn: (message) => env.logger.warn(message),
      });
      const outDir = flags.out
        ? resolve(env.io.cwd, flags.out)
        : join(homeLayout(config.home).previews, resolved.name);
      const ctx = createRunContext({
        config,
        runId: 'theme-preview',
        runDir: outDir,
        logger: env.logger,
        signal: env.signal,
      });
      const { sheet, stills } = await previewTheme(resolved, outDir, ctx);
      if (env.json) {
        env.emitJson({ ok: true, theme: resolved.name, base: resolved.base, sheet, stills });
        return;
      }
      env.say(`Theme ${resolved.name} (${resolved.base}): ${stills.length} stills.`);
      env.say(`Open ${sheet}`);
    });
}

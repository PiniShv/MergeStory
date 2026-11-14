/** mergestory theme preview, mergestory theme init */
import { randomBytes } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Command, Option } from 'commander';
import { BUILT_IN_THEMES } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import type { CliRuntime } from '../runtime.ts';
import { loadConfig } from './shared.ts';

interface PreviewFlags {
  out?: string;
  allowLowContrast?: boolean;
}

interface InitFlags {
  accent?: string;
  accent2?: string;
  brand?: string;
  logo?: string;
  from: string;
  force?: boolean;
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

  theme
    .command('init')
    .description('Make a theme from your brand colors and save it in ~/.mergestory/themes')
    .argument('<name>', 'the name of the new theme: 1-40 characters, a-z, 0-9 and "-"')
    .option('--accent <color>', 'the main brand color, for example "#ff7a1a"')
    .option('--accent-2 <color>', 'a second brand color, for labels and highlights')
    .option(
      '--brand <file>',
      'a file with your brand colors (CSS, JSON or a list): its first color that labels can use, and the next one of a clearly different hue',
    )
    .option(
      '--logo <file>',
      'your logo for the top bar and the end card: PNG or JPEG, at most 256 KB and 2048x2048 pixels',
    )
    .addOption(
      new Option('--from <theme>', 'the built-in theme to start from; it makes the theme dark or light')
        .choices([...BUILT_IN_THEMES, 'dark', 'light'])
        .default('midnight'),
    )
    .option(
      '--force',
      'replace the theme.json of an existing theme with this name (pass --logo again to keep a logo)',
    )
    .option('--allow-low-contrast', 'save a theme that fails the contrast check, with a warning')
    .action(async (name: string, flags: InitFlags, cmd: Command) => {
      const env = rt.env(cmd);
      const config = await loadConfig(env);
      const [
        { checkLogo, createTheme, MAX_LOGO_BYTES },
        { assertNoLinks, ensureDir, homeLayout },
        { LIMITS, readFileBytes, readTextFile },
      ] = await Promise.all([
        import('../../core/theme.ts'),
        import('../../core/paths.ts'),
        import('../files.ts'),
      ]);
      let lowContrast = false;
      const brand = flags.brand
        ? await readTextFile(flags.brand, { label: '--brand', maxBytes: LIMITS.brandBytes, cwd: env.io.cwd })
        : undefined;
      const logo = flags.logo
        ? await readFileBytes(flags.logo, { label: '--logo', maxBytes: MAX_LOGO_BYTES, cwd: env.io.cwd })
        : undefined;
      // Named for what its bytes are, whatever the name of the file given.
      const logoName =
        logo && (checkLogo(logo, `${flags.logo}`).src.startsWith('data:image/png') ? 'logo.png' : 'logo.jpg');
      const { file } = await createTheme({
        name,
        from: flags.from,
        accent: flags.accent,
        accent2: flags.accent2,
        brand,
        allowLowContrast: flags.allowLowContrast === true,
        warn: (message) => {
          lowContrast = true;
          env.logger.warn(message);
        },
      });
      const { themes } = homeLayout(config.home);
      const folder = join(themes, name);
      await assertNoLinks(themes, false);
      await assertNoLinks(folder);
      if (!flags.force && (await stat(folder).catch(() => null))) {
        throw new MergeStoryError('USAGE', `There is already a theme named "${name}": ${folder}`, {
          hint: 'Pass --force to replace its theme.json, or choose another name.',
        });
      }
      const path = join(folder, 'theme.json');
      const logoPath = logoName ? join(folder, logoName) : null;
      const temps: string[] = [];
      // New files renamed into place: never written through a hard link to a file elsewhere.
      const place = async (target: string, data: string | Buffer) => {
        const temp = join(folder, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
        temps.push(temp);
        await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
        await rename(temp, target);
      };
      try {
        await ensureDir(themes);
        await ensureDir(folder);
        // The logo first, so that theme.json never names a logo that is not there.
        if (logo && logoPath) await place(logoPath, logo);
        await place(path, `${JSON.stringify(logoName ? { ...file, logo: logoName } : file, null, 2)}\n`);
      } catch (err) {
        await Promise.all(temps.map((temp) => rm(temp, { force: true }).catch(() => undefined)));
        throw new MergeStoryError('USAGE', `The theme could not be saved in ${folder}.`, {
          hint: 'The files of the theme there must be plain files. Remove the folder, or choose another name.',
          cause: err,
        });
      }
      const colors = file.colors?.dark ?? file.colors?.light ?? {};
      const base = file.colors?.dark ? 'dark' : 'light';
      if (env.json) {
        env.emitJson({ ok: true, theme: name, base, path, colors, ...(logoPath && { logo: logoPath }) });
        return;
      }
      const second = colors['accent-2'] ? ` and accent-2 ${colors['accent-2']}` : '';
      env.say(`Theme ${name} (${base}, from ${file.extends}): accent ${colors.accent}${second}.`);
      env.say(`Saved ${path}`);
      if (logoPath) env.say(`Saved ${logoPath}`);
      const allow = lowContrast ? ' --allow-low-contrast' : '';
      env.say(`See it: mergestory theme preview ${name}${allow}`);
      env.say(`Use it: mergestory generate --theme ${name}${allow}`);
    });
}

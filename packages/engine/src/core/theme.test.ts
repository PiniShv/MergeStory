import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_CSS } from '../runtime/styles.ts';
import {
  BUILT_IN_THEMES,
  colorProblem,
  LOCKED_TOKENS,
  loadTheme,
  parseColor,
  readThemeFile,
  THEME_TOKENS,
} from './theme.ts';

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-theme-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A theme folder holding `theme` as its theme.json; a string is written as it is. */
async function themeFolder(theme: unknown): Promise<string> {
  const folder = join(dir, `theme-${n++}`);
  await mkdir(folder);
  await writeFile(join(folder, 'theme.json'), typeof theme === 'string' ? theme : JSON.stringify(theme));
  return folder;
}

const dark = (colors: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  name: 'mine',
  colors: { dark: colors },
  ...extra,
});

/** The message of the error that loading `theme` gives. */
async function problem(theme: unknown): Promise<string> {
  const error = await loadTheme(await themeFolder(theme)).catch((err: Error) => err);
  if (!(error instanceof Error)) throw new Error('the theme was accepted');
  return error.message;
}

/** The token values of a block of the runtime's base styles. */
function cssTokens(selector: string): Record<string, string> {
  const block = BASE_CSS.split(`${selector} {`)[1]!.split('\n}')[0]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe('built-in themes', () => {
  it('all load, pass the contrast check and extend nothing', async () => {
    for (const name of BUILT_IN_THEMES) {
      const theme = await loadTheme(name);
      expect(theme.name).toBe(name);
      expect(
        Object.keys(theme.colors).every((token) => (THEME_TOKENS as readonly string[]).includes(token)),
      ).toBe(true);
    }
    expect((await loadTheme('high-contrast')).base).toBe('dark');
    expect((await loadTheme('terminal')).shiki).toBe('gruvbox-dark-hard');
  });

  it('keep the old names: dark is midnight and light is paper', async () => {
    expect(await loadTheme('dark')).toEqual(await loadTheme('midnight'));
    expect(await loadTheme('light')).toEqual(await loadTheme('paper'));
    expect((await loadTheme('paper')).base).toBe('light');
  });

  it('midnight and paper hold exactly the colors of the dark and light styles', async () => {
    const darkCss = cssTokens(':root');
    const lightCss = { ...darkCss, ...cssTokens(":root[data-theme='light']") };
    for (const [name, css] of [
      ['midnight', darkCss],
      ['paper', lightCss],
    ] as const) {
      const { colors } = await loadTheme(name);
      for (const token of THEME_TOKENS) {
        // A token that follows another one (glow follows accent on dark) is left to the styles.
        if (css[token]!.startsWith('var(')) expect(colors[token], `${name} ${token}`).toBeUndefined();
        else expect(colors[token], `${name} ${token}`).toBe(css[token]);
      }
    }
  });

  it('resolves to one plain JSON object: data, never code', async () => {
    const theme = await loadTheme('terminal');
    expect(Object.keys(theme).sort()).toEqual(['base', 'colors', 'name', 'shiki']);
    expect(JSON.parse(JSON.stringify(theme))).toEqual(theme);
    expect(Object.values(theme.colors).every((value) => typeof value === 'string')).toBe(true);
  });
});

describe('finding a theme', () => {
  it('looks for a name among the built-in themes first, then in $MERGESTORY_HOME/themes', async () => {
    const home = join(dir, `home-${n++}`);
    for (const name of ['midnight', 'brand']) {
      await mkdir(join(home, 'themes', name), { recursive: true });
      await writeFile(
        join(home, 'themes', name, 'theme.json'),
        JSON.stringify(dark({ accent: '#ff8800' }, { name })),
      );
    }
    expect((await loadTheme('midnight', { home })).colors.accent).toBe('#8c7bff');
    const brand = await loadTheme('brand', { home });
    expect(brand.colors.accent).toBe('#ff8800');
    // A theme without "extends" starts from midnight (dark) or paper (light).
    expect(brand.colors['text-0']).toBe('#f4f6ff');
    expect(brand.shiki).toBe('github-dark-default');
    await expect(loadTheme('nothing-here', { home })).rejects.toThrow(
      'There is no theme named "nothing-here"',
    );
  });

  it('takes the full path of a theme folder or of its theme.json, and nothing relative', async () => {
    const folder = await themeFolder(dark({ accent: '#ff8800' }));
    expect((await loadTheme(folder)).name).toBe('mine');
    expect((await loadTheme(join(folder, 'theme.json'))).name).toBe('mine');
    await expect(loadTheme('./mine')).rejects.toThrow('not a theme name or the full path');
    await expect(loadTheme('themes/mine')).rejects.toThrow('not a theme name or the full path');
  });

  it('extends one built-in theme, and keeps its look', async () => {
    const theme = await loadTheme(
      await themeFolder({
        schema: 1,
        name: 'mine',
        extends: 'paper',
        colors: { light: { accent: '#5b21b6' } },
      }),
    );
    expect(theme.base).toBe('light');
    expect(theme.colors.accent).toBe('#5b21b6');
    expect(theme.colors['bg-0']).toBe('#eef1f8');
    expect(theme.shiki).toBe('github-light-default');
    expect(await problem({ schema: 1, name: 'mine', extends: 'terminal', colors: { light: {} } })).toContain(
      'extends terminal, a dark theme, so its colors go under colors.dark',
    );
    expect(await problem({ schema: 1, name: 'mine', extends: 'my-other-theme' })).toContain('extends');
  });
});

describe('theme.json', () => {
  it('is strict: one JSON object, schema 1, known keys only', async () => {
    expect(await problem('[]')).toContain('not valid');
    expect(await problem('"midnight"')).toContain('not valid');
    expect(await problem('{ "schema": 1, ')).toContain('not valid JSON');
    expect(await problem({ ...dark({}), schema: 2 })).toContain('schema');
    expect(await problem({ ...dark({}), logo: 'logo.png' })).toContain('logo');
    expect(await problem({ ...dark({}), name: '../evil' })).toContain('name');
    expect(await problem({ ...dark({}), colors: { dark: {}, light: {} } })).toContain(
      'both colors.dark and colors.light',
    );
    expect(await problem({ ...dark({}), colors: { dim: {} } })).toContain('dim');
    expect(await problem(dark({}, { code: { shiki: 'my-colors' } }))).toContain('not a Shiki theme');
    expect(await problem(dark({}, { code: { shiki: 'github-dark', css: 'x' } }))).toContain('css');
  });

  it('sets only the colors a theme may change, never the meaning colors or the badges', async () => {
    for (const token of LOCKED_TOKENS) {
      expect(await problem(dark({ [token]: '#123456' })), token).toContain(`${token}: cannot be changed`);
    }
    expect(await problem(dark({ 'mask-text': '#000000' }))).toContain('not a color a theme can set');
    expect(await problem(dark({ 'font-ui': '#000000' }))).toContain('not a color a theme can set');
  });

  it('takes colors in hex, rgb() or hsl() only, and nothing that could load or inject anything', async () => {
    for (const bad of ['://', 'url(', '@import', 'expression', '<', ';']) {
      expect(colorProblem(`#fff${bad}`), bad).toContain(`contains "${bad}"`);
    }
    expect(colorProblem('URL(x.png)')).toContain('contains "url("');
    expect(colorProblem('red; background: url(https://example.com/x.png)')).toContain('contains');
    for (const bad of [
      'red',
      'transparent',
      'var(--accent)',
      'color-mix(in srgb, red, blue)',
      '#ggg',
      '#12345',
    ]) {
      expect(colorProblem(bad), bad).toContain('is not a color');
    }
    for (const bad of [
      'rgb(256, 0, 0)',
      'rgba(0, 0, 0, 1.5)',
      'hsl(0, 101%, 50%)',
      'rgb(1,\n2,3)',
      'rgb(-1, 0, 0)',
    ]) {
      expect(colorProblem(bad), bad).toContain('is not a color');
    }
    expect(await problem(dark({ accent: 'url(x)' }))).toContain('contains "url("');
  });

  it('reads the usual ways of writing a color', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseColor('#8C7BFF')).toEqual([140, 123, 255, 1]);
    expect(parseColor('rgb(20, 28, 54)')).toEqual([20, 28, 54, 1]);
    expect(parseColor('rgba(20, 28, 54, 0.78)')).toEqual([20, 28, 54, 0.78]);
    expect(parseColor('rgb(20 28 54 / 50%)')).toEqual([20, 28, 54, 0.5]);
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 1]);
    expect(parseColor('hsla(120deg 100% 25% / 0.5)')).toEqual([0, 127.5, 0, 0.5]);
  });
});

describe('the files of a theme folder', () => {
  it('reads only a plain file inside the folder', async () => {
    const folder = await themeFolder(dark({}));
    await expect(readThemeFile(folder, '../theme.json')).rejects.toThrow(
      'not a file inside the theme folder',
    );
    await expect(readThemeFile(folder, '/etc/passwd')).rejects.toThrow('not a file inside the theme folder');
    await expect(readThemeFile(folder, 'missing.json')).rejects.toThrow('has no missing.json');
    expect(await readThemeFile(folder, 'theme.json')).toContain('"schema":1');
  });

  it('refuses a theme.json that is a symbolic link or a hard link', async () => {
    const secret = join(dir, `secret-${n++}.json`);
    await writeFile(secret, JSON.stringify(dark({})));
    const linked = join(dir, `linked-${n++}`);
    await mkdir(linked);
    await symlink(secret, join(linked, 'theme.json'));
    await expect(loadTheme(linked)).rejects.toThrow('must be a plain file, not a link');
    const hard = join(dir, `hard-${n++}`);
    await mkdir(hard);
    await link(secret, join(hard, 'theme.json'));
    await expect(loadTheme(hard)).rejects.toThrow('not a hard link');
  });

  it('refuses a theme folder that is a symbolic link, and a theme.json over 64 KB', async () => {
    const folder = await themeFolder(dark({}));
    const alias = join(dir, `alias-${n++}`);
    await symlink(folder, alias);
    await expect(loadTheme(alias)).rejects.toThrow('symbolic link');
    await expect(loadTheme(await themeFolder(`${' '.repeat(65 * 1024)}{}`))).rejects.toThrow(
      'larger than 64 KB',
    );
  });
});

describe('the contrast check', () => {
  it('refuses text that is hard to read, unless asked to warn instead', async () => {
    const grey = dark({ 'text-2': '#3a3f4f' });
    expect(await problem(grey)).toMatch(/text-2 reaches \d\.\d\d:1 on .*; it needs 4\.5:1/);
    const warnings: string[] = [];
    const theme = await loadTheme(await themeFolder(grey), {
      allowLowContrast: true,
      warn: (message) => warnings.push(message),
    });
    expect(theme.colors['text-2']).toBe('#3a3f4f');
    expect(warnings).toEqual([expect.stringContaining('text-2 reaches')]);
  });

  it('asks 3:1 for muted text and 7:1 for captions over any scene', async () => {
    expect(await problem(dark({ 'text-3': '#3a3f4f' }))).toContain('it needs 3:1');
    // Fine on the dark backgrounds, but a see-through pill over a bright screenshot is not.
    expect(await problem(dark({ 'cap-bg': 'rgba(5, 8, 18, 0.4)' }))).toContain('they need 7:1');
  });

  it('wants an opaque background and code colors made for the base', async () => {
    expect(await problem(dark({ 'bg-0': 'rgba(0, 0, 0, 0.5)' }))).toContain('bg-0 must be opaque');
    expect(await problem(dark({}, { code: { shiki: 'github-light' } }))).toContain(
      'is a light theme on a dark video',
    );
  });
});

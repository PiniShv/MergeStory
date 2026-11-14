import { link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadTheme } from '../../core/theme.ts';
import { dir, run } from '../../testing/cli.ts';
import { makeJpeg, makePng } from '../../testing/png.ts';

vi.mock('../../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

describe('theme init', () => {
  const home = () => join(dir, 'home');

  it('saves a theme made from brand colors, which then loads like any theme', async () => {
    await writeFile(join(dir, 'brand.css'), ':root { --grey: #222222; --red: #e50914; --sky: #0ea5e9; }');
    const { code, stdout } = await run(['theme', 'init', 'stream', '--brand', 'brand.css']);
    expect(code).toBe(0);
    expect(stdout).toContain('accent #e50914 and accent-2 #0ea5e9');
    const path = join(home(), 'themes', 'stream', 'theme.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schema: 1, extends: 'midnight' });
    expect((await loadTheme('stream', { home: home() })).colors.accent).toBe('#e50914');
  });

  it('never replaces a theme unless asked, and never writes through a link', async () => {
    expect((await run(['theme', 'init', 'twice', '--accent', '#1ed760'])).code).toBe(0);
    const again = await run(['theme', 'init', 'twice', '--accent', '#ff7a1a']);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already a theme named "twice"');
    const forced = await run([
      'theme',
      'init',
      'twice',
      '--accent',
      '#c2410c',
      '--from',
      'light',
      '--force',
      '--json',
    ]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({ ok: true, theme: 'twice', base: 'light' });
    const saved = JSON.parse(await readFile(join(home(), 'themes', 'twice', 'theme.json'), 'utf8'));
    expect(saved).toMatchObject({ extends: 'paper', colors: { light: { accent: '#c2410c' } } });

    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    await symlink(join(dir, 'elsewhere'), join(home(), 'themes', 'linked'));
    const linked = await run(['theme', 'init', 'linked', '--accent', '#ff7a1a', '--force']);
    expect(linked.code).toBe(2);
    expect(linked.stderr).toContain('symbolic link');
  });

  it('replaces a theme.json that is a hard link without touching the file it shares', async () => {
    const outside = join(dir, 'precious.txt');
    await writeFile(outside, 'keep me');
    await mkdir(join(home(), 'themes', 'shared'), { recursive: true });
    await link(outside, join(home(), 'themes', 'shared', 'theme.json'));
    const { code } = await run(['theme', 'init', 'shared', '--accent', '#ff7a1a', '--force']);
    expect(code).toBe(0);
    expect(await readFile(outside, 'utf8')).toBe('keep me');
    expect((await stat(join(home(), 'themes', 'shared', 'theme.json'))).nlink).toBe(1);
    expect((await loadTheme('shared', { home: home() })).colors.accent).toBe('#ff7a1a');
  });

  it('copies a logo into the theme, named for what it is, and takes only PNG or JPEG', async () => {
    await writeFile(join(dir, 'brand-mark'), makePng(240, 60));
    const { code, stdout } = await run([
      'theme',
      'init',
      'marked',
      '--accent',
      '#ff7a1a',
      '--logo',
      'brand-mark',
    ]);
    expect(code).toBe(0);
    const folder = join(home(), 'themes', 'marked');
    expect(stdout).toContain(`Saved ${join(folder, 'logo.png')}`);
    expect(JSON.parse(await readFile(join(folder, 'theme.json'), 'utf8'))).toMatchObject({
      logo: 'logo.png',
    });
    expect((await loadTheme('marked', { home: home() })).logo).toMatchObject({ width: 240, height: 60 });

    // A JPEG is saved as logo.jpg, whatever its name says.
    await writeFile(join(dir, 'photo.png'), makeJpeg(300, 100));
    const jpeg = await run(['theme', 'init', 'photo', '--accent', '#ff7a1a', '--logo', 'photo.png']);
    expect(jpeg.code).toBe(0);
    expect(JSON.parse(await readFile(join(home(), 'themes', 'photo', 'theme.json'), 'utf8'))).toMatchObject({
      logo: 'logo.jpg',
    });
    expect((await loadTheme('photo', { home: home() })).logo?.src).toMatch(/^data:image\/jpeg;base64,/);

    await writeFile(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const svg = await run(['theme', 'init', 'vector', '--accent', '#ff7a1a', '--logo', 'logo.svg']);
    expect(svg.code).toBe(2);
    expect(svg.stderr).toContain('must be a PNG or JPEG image');
    expect(await stat(join(home(), 'themes', 'vector')).catch(() => null)).toBeNull();
  });

  it('prints the next commands with --allow-low-contrast when the theme needed it', async () => {
    const { code, stdout } = await run([
      'theme',
      'init',
      'pale',
      '--accent',
      '#ffcc33',
      '--from',
      'light',
      '--allow-low-contrast',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('mergestory theme preview pale --allow-low-contrast');
    expect(stdout).toContain('mergestory generate --theme pale --allow-low-contrast');
  });
});

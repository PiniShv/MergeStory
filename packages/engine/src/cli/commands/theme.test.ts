import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadTheme } from '../../core/theme.ts';
import { dir, run } from '../../testing/cli.ts';

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

    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    await symlink(join(dir, 'elsewhere'), join(home(), 'themes', 'linked'));
    const linked = await run(['theme', 'init', 'linked', '--accent', '#ff7a1a', '--force']);
    expect(linked.code).toBe(2);
    expect(linked.stderr).toContain('symbolic link');
  });
});

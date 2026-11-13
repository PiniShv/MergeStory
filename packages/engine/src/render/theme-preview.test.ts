import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeResolved, RenderPlan } from '../core/render-plan.ts';
import { loadTheme } from '../core/theme.ts';
import { testContext } from '../testing/context.ts';
import { previewTheme, recolorCode } from './theme-preview.ts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-preview-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('recolorCode', () => {
  it('colors the code of a plan again for another Shiki theme, and keeps its text', async () => {
    const sample = new URL('../../assets/preview/templates-sample.json', import.meta.url);
    const plan = JSON.parse(await readFile(sample, 'utf8')) as RenderPlan;
    const code = (plan.scenes.find((s) => s.visual.type === 'code')!.visual as CodeResolved).code;
    const text = () => code.lines.map((line) => line.tokens.map((token) => token.t).join(''));
    const colors = () => code.lines.flatMap((line) => line.tokens.map((token) => token.c));
    const [beforeText, beforeColors] = [text(), colors()];
    await recolorCode(plan, 'github-light-default');
    expect(text()).toEqual(beforeText);
    expect(colors()).not.toEqual(beforeColors);
  });
});

describe('previewTheme', () => {
  it('never writes over other files or through a link', async () => {
    const theme = await loadTheme('paper');
    const { ctx } = testContext({ home: join(dir, 'home'), runDir: dir });
    const project = join(dir, 'project');
    await mkdir(project);
    await writeFile(join(project, 'index.html'), '<p>mine</p>');
    await writeFile(join(project, 'package.json'), '{}');
    await expect(previewTheme(theme, project, ctx)).rejects.toThrow('already holds other files');
    expect(await readFile(join(project, 'index.html'), 'utf8')).toBe('<p>mine</p>');

    const planted = join(dir, 'planted');
    await mkdir(planted);
    await symlink(join(project, 'package.json'), join(planted, 'index.html'));
    await expect(previewTheme(theme, planted, ctx)).rejects.toThrow('symbolic link');
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{}');
  });
});

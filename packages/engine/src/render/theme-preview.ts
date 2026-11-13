/**
 * A contact sheet of a theme: stills of the sample plans, drawn with the theme, on one page. No
 * model, no voice and no network: the plans ship with MergeStory, and only their code is colored
 * again for the theme's Shiki theme.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunContext } from '../core/context.ts';
import type { RenderPlan, ResolvedCode } from '../core/render-plan.ts';
import type { ResolvedTheme } from '../core/theme.ts';
import { highlightText } from '../visuals/highlight.ts';
import { renderStillFrames } from './chromium-renderer.ts';

const SAMPLES = fileURLToPath(new URL('../../assets/preview/', import.meta.url));

/** One moment in every scene, after it has come in, and the end card. */
const SHOTS = [
  { plan: 'core-sample', times: [4, 12, 17, 25.5, 31, 39.5] },
  { plan: 'templates-sample', times: [4.5, 10.5, 16, 21.5, 27, 32.5, 38, 41.5] },
] as const;

/** Color the code of a plan again with another Shiki theme. */
async function recolorCode(plan: RenderPlan, shiki: string): Promise<void> {
  const blocks: ResolvedCode[] = [];
  for (const { visual } of plan.scenes) {
    if (visual.type === 'code') blocks.push(visual.code);
    if (visual.type === 'before-after') {
      for (const panel of [visual.before, visual.after]) if (panel.kind === 'code') blocks.push(panel.code);
    }
  }
  for (const code of blocks) {
    const text = code.lines.map((line) => line.tokens.map((token) => token.t).join('')).join('\n');
    const lines = await highlightText(text, { language: code.language, theme: shiki });
    code.lines.forEach((line, i) => {
      line.tokens = lines[i] ?? [];
    });
  }
}

function contactSheet(theme: ResolvedTheme, stills: string[]): string {
  // The theme name is only a-z, 0-9 and "-" (theme.json schema), and the paths are made here.
  const images = stills.map((src) => `<img src="${src}" alt="">`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Theme ${theme.name}</title>
<style>
body { margin: 24px; background: #8a8f99; color: #111; font: 16px/1.4 system-ui, sans-serif; }
main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
img { display: block; width: 100%; border-radius: 6px; }
</style></head>
<body><h1>Theme ${theme.name} (${theme.base})</h1><main>
${images}
</main></body></html>
`;
}

export interface ThemePreview {
  /** The page that shows all stills. */
  sheet: string;
  stills: string[];
}

/** Draw the sample stills of a theme into `outDir`, with a page that shows them together. */
export async function previewTheme(
  theme: ResolvedTheme,
  outDir: string,
  ctx: RunContext,
): Promise<ThemePreview> {
  const stills: string[] = [];
  for (const shot of SHOTS) {
    const plan = JSON.parse(await readFile(join(SAMPLES, `${shot.plan}.json`), 'utf8')) as RenderPlan;
    Object.assign(plan, { theme: theme.base, colors: theme.colors, width: 960, height: 540 });
    await recolorCode(plan, theme.shiki);
    stills.push(...(await renderStillFrames(plan, [...shot.times], join(outDir, shot.plan), ctx)));
  }
  const sheet = join(outDir, 'index.html');
  const sources = stills.map((file) => relative(outDir, file).split(sep).join('/'));
  await writeFile(sheet, contactSheet(theme, sources), { mode: 0o600 });
  return { sheet, stills };
}

// Development tool: render chosen frames of a RenderPlan JSON file to PNGs for a visual check.
//
//   node scripts/preview-frames.mjs <plan.json> <outDir> [time1,time2,...]
//
// Uses the renderer's own still-frame path, so a preview is drawn like the final video. In a checkout
// the runtime is bundled from src/runtime/main.ts on the fly, so template changes show up at once.
// The browser is found as the renderer finds it (MERGESTORY_BROWSER_PATH, then Playwright, then Chrome).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveConfig } from '../src/core/config.ts';
import { createRunContext } from '../src/core/context.ts';
import { renderStillFrames } from '../src/render/chromium-renderer.ts';

const [planPath, outDir, timesArg] = process.argv.slice(2);
if (!planPath || !outDir) {
  console.error('usage: node scripts/preview-frames.mjs <plan.json> <outDir> [t1,t2,...]');
  process.exit(2);
}

const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
const times = timesArg
  ? timesArg.split(',').map(Number)
  : plan.scenes.map((s) => Math.round((s.startSec + Math.min(s.durationSec - 0.2, 3.5)) * 100) / 100);

const config = resolveConfig({ skipFile: true });
const ctx = createRunContext({ config, runId: 'preview', runDir: resolve(outDir) });
for (const file of await renderStillFrames(plan, times, outDir, ctx)) console.log(file);

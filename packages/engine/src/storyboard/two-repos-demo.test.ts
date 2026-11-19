/**
 * The third demo, one video for a change in two repositories: both repositories are built by the
 * script in examples/two-repos-demo, and its hand-written storyboard has to stay clean. The render
 * test needs FFmpeg and a browser and is skipped (visibly) when either is missing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { GenerateResult } from '../core/types.ts';
import { checkStoryboard, generate } from '../pipeline/index.ts';
import { locateBrowser } from '../render/browser.ts';
import { testContext } from '../testing/context.ts';

const DEMO = fileURLToPath(new URL('../../../../examples/two-repos-demo/', import.meta.url));
const RANGE = { base: 'main', head: 'fix/total-cents' };

const config = testContext().ctx.config;
const ffmpeg = await resolveFfmpeg(config).catch(() => null);
const browser = await locateBrowser(config).catch(() => null);

describe('the two-repositories demo', () => {
  let root = '';
  let storyboard: unknown;
  let context: { task: string; notes: string };
  const original = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };

  const options = () => ({
    source: join(root, 'repos', 'orders-api'),
    sources: [
      { kind: 'local' as const, repoPath: join(root, 'repos', 'orders-api'), ...RANGE },
      { kind: 'local' as const, repoPath: join(root, 'repos', 'storefront'), ...RANGE },
    ],
    storyboard,
    context,
    config: { home: join(root, 'home'), tts: { provider: 'none' as const }, quality: 'draft' as const },
  });

  beforeAll(async () => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    root = await mkdtemp(join(tmpdir(), 'mergestory-two-repos-'));
    execFileSync('bash', [join(DEMO, 'create-demo-repos.sh'), join(root, 'repos')], { stdio: 'pipe' });
    storyboard = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8'));
    context = {
      task: await readFile(join(DEMO, 'task.md'), 'utf8'),
      notes: await readFile(join(DEMO, 'notes.md'), 'utf8'),
    };
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('has a hand-written storyboard with nothing to report, repair or remove', async () => {
    const result = await checkStoryboard(options());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.groundedClaims).toBeGreaterThan(0);
  });

  it('cites ids of both repositories, shows code of both and draws components of both', () => {
    const text = JSON.stringify(storyboard);
    expect(text).toMatch(/"A\.[A-Z]+\d/);
    expect(text).toMatch(/"B\.[A-Z]+\d/);
    expect(text).toContain('"path":"orders-api/src/handler.js"');
    expect(text).toContain('"path":"storefront/src/money.js"');
    const scenes = (
      storyboard as { scenes: { visual: { type: string; nodes?: { evidence: string[] }[] } }[] }
    ).scenes;
    expect(scenes.length).toBeGreaterThanOrEqual(6);
    expect(scenes.length).toBeLessThanOrEqual(8);
    const architecture = scenes.find((scene) => scene.visual.type === 'architecture')?.visual.nodes ?? [];
    const cited = architecture.flatMap((node) => node.evidence);
    expect(cited.some((id) => id.startsWith('A.'))).toBe(true);
    expect(cited.some((id) => id.startsWith('B.'))).toBe(true);
  });

  describe.skipIf(ffmpeg === null || browser === null)('rendered at draft quality', () => {
    it('gives the same video bytes with one worker and with three', async () => {
      const render = async (concurrency: number): Promise<{ result: GenerateResult; video: Buffer }> => {
        const base = options();
        const result = (await generate({
          ...base,
          config: {
            ...base.config,
            outDir: join(root, `out-${concurrency}`),
            render: { concurrency },
            publish: { provider: 'local' },
          },
        })) as GenerateResult;
        return { result, video: await readFile(result.files.video) };
      };
      const one = await render(1);
      const three = await render(3);
      expect(one.result.ok).toBe(true);
      expect(one.result.evidenceUsed).toEqual(expect.arrayContaining(['A.F1.H1', 'B.F1.H1']));
      expect(three.video.equals(one.video)).toBe(true);
    }, 300_000);
  });
});

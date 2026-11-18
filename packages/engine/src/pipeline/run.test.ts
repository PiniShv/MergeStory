/**
 * The pipeline from the source to the published result, on a real git repository. Speech is off and
 * the renderer and the publisher are stand-ins, so the tests are quick and need no browser, no
 * FFmpeg and no network. Everything else (source, analysis, storyboard, grounding, timeline, visuals,
 * files in the run folder) is the real thing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPublishResult } from '../cli/commands/publish.ts';
import { formatCost, formatError, formatValidation } from '../cli/format.ts';
import { describeError } from '../cli/runtime.ts';
import { createStyle } from '../cli/style.ts';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { ConfigInput } from '../core/config.ts';
import { estimateTokens } from '../core/cost.ts';
import { abortedError, MergeStoryError } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import type { PublishBundle, Publisher, Renderer } from '../core/providers.ts';
import { narrationWords } from '../core/storyboard-facts.ts';
import {
  BrowserVisualSchema,
  CodeVisualSchema,
  HighlightSchema,
  PanelSchema,
  SceneSchema,
  ScreenshotVisualSchema,
  STORYBOARD_LIMITS,
  type Storyboard,
  TitleVisualSchema,
} from '../core/storyboard-schema.ts';
import type { GenerateResult, PlanResult, PublishResult } from '../core/types.ts';
import { ensureKokoroInstalled } from '../narration/kokoro-install.ts';
import { createPublisher } from '../publish/index.ts';
import { createRenderer } from '../render/index.ts';
import { testConfig } from '../testing/context.ts';
import { makeClip } from '../testing/media.ts';
import { makePng, pngHeader } from '../testing/png.ts';
import { checkStoryboard, generate, prepareAuthoring, publishRun } from './index.ts';
import { EARLIER_RESULT_MISSING } from './types.ts';

vi.mock('../render/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../render/index.ts')>()),
  createRenderer: vi.fn(),
}));
vi.mock('../publish/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../publish/index.ts')>()),
  createPublisher: vi.fn(),
}));
// These tests never install the Kokoro voice: the install is a stub that fails unless a test says otherwise.
vi.mock('../narration/kokoro-install.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../narration/kokoro-install.ts')>()),
  ensureKokoroInstalled: vi.fn(async () => {
    throw new Error('the pipeline tests never install the Kokoro voice');
  }),
}));

const DEMO = fileURLToPath(new URL('../../../../examples/demo/', import.meta.url));
const RUN_ID = '20261104-101500-a1b2';

const originalEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
let base: string;
let repo: string;
let home: string;
let context: { task: string; notes: string; tests: [] };

beforeAll(async () => {
  // Keep the developer's own git settings out of the picture.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  base = await mkdtemp(join(tmpdir(), 'mergestory-pipeline-'));
  repo = join(base, 'demo');
  execFileSync('bash', [join(DEMO, 'create-demo-repo.sh'), repo], { stdio: 'pipe' });
  context = {
    task: await readFile(join(DEMO, 'task.md'), 'utf8'),
    notes: await readFile(join(DEMO, 'notes.md'), 'utf8'),
    tests: JSON.parse(await readFile(join(DEMO, 'tests.json'), 'utf8')) as [],
  };
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

/** Writes a video and a poster, like the real renderer does. */
const fakeRenderer: Renderer = {
  id: 'fake',
  ready: async () => {},
  render: async (input) => {
    const videoPath = join(input.outDir, 'video.mp4');
    const posterPath = join(input.outDir, 'poster.jpg');
    await writeFile(videoPath, Buffer.alloc(2048, 1));
    await writeFile(posterPath, 'POSTER');
    return {
      videoPath,
      posterPath,
      width: input.plan.width,
      height: input.plan.height,
      fps: input.plan.fps,
      durationSec: input.plan.durationSec,
      frames: 1,
      reusedFrames: 0,
      sizeBytes: 2048,
    };
  },
};

const publishMock = vi.mocked(createPublisher);
let uploads: PublishBundle[];

const uploaded: PublishResult = {
  provider: 's3',
  watchUrl: 'https://videos.example.com/mergestory/v/0123456789abcdef0123456789abcdef/index.html',
  videoUrl: 'https://videos.example.com/mergestory/v/0123456789abcdef0123456789abcdef/video.mp4',
  posterUrl: null,
  captionsUrl: null,
  expiresAt: null,
  visibility: 'protected',
  location: 's3://media/mergestory/v/0123456789abcdef0123456789abcdef/',
};

/** A publisher that records what it was given, then succeeds or fails. */
function fakePublisher(outcome: 'ok' | Error): Publisher {
  return {
    id: 's3',
    check: async () => null,
    plannedEgress: () => [],
    publish: async (bundle, ctx) => {
      uploads.push(bundle);
      if (outcome !== 'ok') {
        // Part of the upload went out before it failed.
        ctx.egress.record('videos.example.com', 'video upload', 2048, ['video']);
        throw outcome;
      }
      ctx.egress.record('videos.example.com', 'video upload', 2048, ['video']);
      return uploaded;
    },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(base, 'home-'));
  vi.stubEnv('MERGESTORY_HOME', home);
  uploads = [];
  vi.mocked(ensureKokoroInstalled).mockClear();
  vi.mocked(createRenderer).mockReturnValue(fakeRenderer);
  const actual = await vi.importActual<typeof import('../publish/index.ts')>('../publish/index.ts');
  publishMock.mockReset();
  publishMock.mockImplementation((config) => actual.createPublisher(config));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function options(overrides: { config?: ConfigInput; withContext?: boolean } & Record<string, unknown> = {}) {
  const { config, withContext = true, ...rest } = overrides;
  return {
    source: repo,
    base: 'main',
    head: 'feature/retry',
    runId: RUN_ID,
    ...(withContext ? { context } : {}),
    ...rest,
    config: { home, tts: { provider: 'none' as const }, quality: 'draft' as const, ...config },
  };
}

const S3_CONFIG: ConfigInput = {
  publish: {
    provider: 's3',
    visibility: 'protected',
    s3: { bucket: 'media', publicBaseUrl: 'https://videos.example.com', verifyProtection: false },
  },
};
const runDir = () => join(home, 'runs', RUN_ID);

async function plan(overrides: Parameters<typeof options>[0] = {}): Promise<PlanResult> {
  return (await generate({ ...options(overrides), dryRun: true })) as PlanResult;
}
async function run(overrides: Parameters<typeof options>[0] = {}): Promise<GenerateResult> {
  return (await generate(options(overrides))) as GenerateResult;
}
async function failure(promise: Promise<unknown>): Promise<MergeStoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MergeStoryError);
    return error as MergeStoryError;
  }
  throw new Error('expected the run to fail');
}
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('--max-duration', () => {
  it('trims a storyboard that is too long before anything is narrated, and says what it left out', async () => {
    const supplied = await readJson<unknown>(join(DEMO, 'storyboard.json'));
    const whole = await plan({ storyboard: supplied });
    expect(whole.warnings.filter((w) => w.includes('--max-duration'))).toEqual([]);

    const trimmed = await plan({ storyboard: supplied, config: { maxDurationSec: 60 } });
    expect(whole.estimatedDurationSec).toBeGreaterThan(60);
    expect(trimmed.estimatedDurationSec).toBeLessThanOrEqual(60);
    expect(trimmed.scenes.length).toBeLessThan(whole.scenes.length);
    const roles = trimmed.scenes.map((s) => s.role);
    expect(roles).toContain('mission');
    expect(roles).toContain('review');
    const notice = trimmed.warnings.find((w) => w.includes('--max-duration'));
    expect(notice).toContain(
      `The storyboard is estimated at ${whole.estimatedDurationSec} s, over the maximum of 60 s`,
    );
    expect(notice).toContain('Left out to shorten it');
    // The run folder holds the storyboard that would be rendered, not the longer one.
    const stored = await readJson<{ scenes: { id: string }[] }>(join(runDir(), 'storyboard.json'));
    expect(stored.scenes.map((s) => s.id)).toEqual(trimmed.scenes.map((s) => s.id));
  });

  it('also trims the offline storyboard when even its leanest form is too long', async () => {
    const lean = await plan({ config: { maxDurationSec: 30 } });
    expect(lean.estimatedDurationSec).toBeLessThanOrEqual(30);
    expect(lean.warnings.some((w) => w.includes('over the maximum of 30 s'))).toBe(true);
  });

  it('does not use the validator warning that compared only the words', async () => {
    const trimmed = await plan({ config: { maxDurationSec: 20 } });
    expect(trimmed.warnings.filter((w) => w.startsWith('scenes: the narration is about'))).toEqual([]);
    expect(trimmed.warnings.some((w) => w.includes('over the maximum of 20 s'))).toBe(true);
  });

  it('keeps the mission and review scenes and says that the limit cannot be reached', async () => {
    const result = await plan({ config: { maxDurationSec: 20, targetDurationSec: 20 } });
    const roles = result.scenes.map((s) => s.role);
    expect(roles).toContain('mission');
    expect(roles).toContain('review');
    expect(roles.every((role) => role === 'mission' || role === 'review')).toBe(true);
    if (result.estimatedDurationSec > 20) {
      expect(result.warnings.join(' ')).toContain('cannot be reached');
    }
  });

  it('warns after narration when a slower voice made the finished video longer than the limit', async () => {
    // The estimate fits, but this voice is slower than the estimate: every line takes twice as long.
    const slow = await import('../narration/index.ts');
    const spy = vi.spyOn(slow, 'synthesizeNarration').mockImplementation(async (storyboard) => ({
      provider: 'none',
      voice: null,
      clips: storyboard.scenes.flatMap((scene) =>
        scene.narration.map((line, beatIndex) => ({
          sceneId: scene.id,
          beatIndex,
          text: line.text,
          spokenText: line.text,
          audioPath: null,
          durationSec: (line.text.split(/\s+/).length / 2.5) * 2,
          cached: false,
        })),
      ),
    }));
    try {
      const whole = await plan({ config: { maxDurationSec: 150 } });
      const limit = Math.round(whole.estimatedDurationSec * 0.8);
      const result = await run({ config: { maxDurationSec: limit } });
      const late = result.warnings.find((w) => w.startsWith('The finished video is'));
      expect(late).toBeDefined();
      expect(late).toContain(`over the maximum of ${limit} s`);
      expect(late).toContain('the voice speaks more slowly');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the theme', () => {
  it('stops a run with a theme that cannot be used, before a storyboard is chosen', async () => {
    const error = await failure(plan({ config: { theme: join(home, 'no-such-theme') } }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('Theme folder not found');
    expect(existsSync(join(runDir(), 'storyboard.json'))).toBe(false);
  });

  it('refuses a theme that is hard to read, and only warns when that is allowed', async () => {
    const folder = join(home, 'grey-theme');
    await mkdir(folder, { recursive: true });
    const theme = { schema: 1, name: 'grey', colors: { dark: { 'text-2': '#3a3f4f' } } };
    await writeFile(join(folder, 'theme.json'), JSON.stringify(theme));
    expect((await failure(plan({ config: { theme: folder } }))).message).toContain('hard to read');
    const result = await plan({ config: { theme: folder }, allowLowContrast: true });
    expect(result.warnings).toContainEqual(expect.stringContaining('text-2 reaches'));
  });
});

describe('a dry run', () => {
  it('reports publishing that would fail, and plans no upload to a bucket that is not set', async () => {
    const result = await plan({ config: { publish: { provider: 's3' } } });
    const problem = result.warnings.find((w) => w.startsWith('Publishing would fail:'));
    expect(problem).toContain('No storage bucket is configured.');
    expect(problem).toContain('A real run stops before it spends anything.');
    expect(JSON.stringify(result.plannedEgress)).not.toContain('<bucket>');
    expect(result.plannedEgress).toEqual([]);
  });

  it('plans the upload to the real host and no pull request update for a change that is not a pull request', async () => {
    const result = await plan({
      config: {
        publish: {
          provider: 's3',
          s3: { bucket: 'media', endpoint: 'https://acct.r2.cloudflarestorage.com' },
        },
        github: { comment: true },
      },
    });
    expect(result.plannedEgress.map((e) => [e.destination, e.purpose])).toEqual([
      ['acct.r2.cloudflarestorage.com', 'video upload'],
    ]);
    expect(result.warnings.some((w) => w.includes('does not come from a GitHub pull request'))).toBe(true);
    expect(result.estimatedDurationSec).toBeGreaterThan(10);
  });

  it('plans with the Kokoro voice for English when it is not installed, and installs nothing', async () => {
    const result = await plan({ config: { tts: { provider: 'auto' }, language: 'en' } });
    expect(result.providers.tts).toBe('kokoro');
    const downloads = result.plannedEgress.filter((e) => e.purpose.includes('first run only'));
    expect(downloads).toEqual([
      {
        destination: 'registry.npmjs.org',
        purpose: 'voice package download (first run only)',
        bytes: 0,
        contains: [],
      },
      {
        destination: 'huggingface.co',
        purpose: 'voice model download (first run only)',
        bytes: 0,
        contains: [],
      },
    ]);
    const note = result.warnings.find((w) => w.includes('Kokoro'));
    expect(note).toContain('The first real run installs it once');
    expect(note).toContain('registry.npmjs.org');
    expect(note).toContain('huggingface.co');
    expect(vi.mocked(ensureKokoroInstalled)).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'plugins'))).toBe(false);
  });

  it('says what a real run does when the high estimate is above the budget', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-0123456789abcdef');
    const result = await plan({ config: { budgetUsd: 0.001, tts: { provider: 'openai' } } });
    const note = result.warnings.find((w) => w.includes('is above the budget of $0.00'));
    expect(note).toContain('This high estimate');
    expect(note).toContain('stops before any call that would go over it');
    expect(note).toContain('a repair is skipped');
  });

  describe('with a model', () => {
    const local = {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
    } as const;
    const speechOf = (result: PlanResult) => result.estimatedCost.records.find((r) => r.kind === 'tts');

    it('prices speech at the most narration that fits the length limit, because the model may write more than the stand-in', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-0123456789abcdef');
      const config = { maxDurationSec: 60, tts: { provider: 'openai' as const } };
      const offline = await plan({ config });
      const withModel = await plan({ config: { ...config, llm: local } });
      // 60 s x 2.5 words per second x 7 characters per word.
      expect(speechOf(withModel)?.characters).toBe(1050);
      expect(speechOf(offline)?.characters).toBeLessThan(1050);
      expect(speechOf(withModel)?.costUsd).toBeGreaterThan(speechOf(offline)?.costUsd ?? 0);
    });

    it('keeps pricing the actual narration of a storyboard that is real', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-0123456789abcdef');
      const supplied = await readJson<unknown>(join(DEMO, 'storyboard.json'));
      const config = { tts: { provider: 'openai' as const } };
      const plain = await plan({ storyboard: supplied, config });
      const withModel = await plan({ storyboard: supplied, config: { ...config, llm: local } });
      expect(speechOf(withModel)?.characters).toBe(speechOf(plain)?.characters);
    });

    it('counts a model server on this machine with no known price as $0, and says so', async () => {
      const result = await plan({ config: { llm: local } });
      expect(result.estimatedCost.records.find((r) => r.kind === 'llm')).toMatchObject({
        priceNote: 'local',
        costUsd: 0,
      });
      expect(formatCost(result.estimatedCost)).toContain(
        'a model server on this machine or your network counted as $0',
      );
    });
  });

  it('names the speech model that would be used, next to the price of that model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-0123456789abcdef');
    const speech = (result: PlanResult) => result.estimatedCost.records.find((r) => r.kind === 'tts');
    const hdPlan = await plan({ config: { tts: { provider: 'openai', model: 'tts-1-hd' } } });
    const hd = speech(hdPlan);
    expect(hd).toMatchObject({ provider: 'openai', model: 'tts-1-hd' });
    // The narration text goes to the speech provider, and the plan says so with the characters it counted.
    expect(hdPlan.plannedEgress).toEqual([
      {
        destination: 'api.openai.com',
        purpose: 'speech synthesis',
        bytes: hd?.characters,
        contains: ['narration-text'],
      },
    ]);
    // 30 dollars per million characters is the price of tts-1-hd.
    expect(hd?.costUsd).toBeCloseTo(((hd?.characters ?? 0) * 30) / 1_000_000, 8);
    // Without a configured model, the provider's own default is the one that would be used.
    expect(speech(await plan({ config: { tts: { provider: 'openai' } } }))?.model).toBe('gpt-4o-mini-tts');
  });

  it('does not warn that claims go unchecked in the offline storyboard of another language', async () => {
    const result = await plan({ config: { language: 'de' } });
    expect(result.warnings.some((w) => w.includes('only in English text'))).toBe(false);
  });

  it('says that supplied screenshots are not used by the offline storyboard', async () => {
    const shot = join(base, 'forecast.png');
    await writeFile(shot, makePng(8, 8));
    const result = await plan({
      withContext: false,
      context: { screenshots: [{ path: shot, caption: 'Forecast', moment: 'after' as const }] },
    });
    const warning = result.warnings.find((w) => w.includes('SS1'));
    expect(warning).toContain('The screenshot SS1 ("Forecast") is not shown in the video.');
    expect(warning).toContain('The offline storyboard never uses screenshots');
  });

  it('names a screenshot that only a step of the reproduction shows in evidenceUsed', async () => {
    const shot = join(base, 'bug.png');
    await writeFile(shot, makePng(8, 8));
    const demo = await readJson<Storyboard>(join(DEMO, 'storyboard.json'));
    const scene: Storyboard['scenes'][number] = {
      ...structuredClone(demo.scenes[0]!),
      id: 'repro',
      role: 'reproduction',
      narration: [{ text: 'In the reproduction, the page opens.', evidence: ['REPRO.1'] }],
      visual: { type: 'repro', steps: [{ step: 1, beat: 0 }] },
    };
    const result = await run({
      withContext: false,
      storyboard: { ...demo, scenes: [...demo.scenes, scene] },
      context: {
        screenshots: [{ path: shot, caption: 'Bug', moment: 'before' as const }],
        repro: { title: 'The bug', steps: [{ text: 'Open the page', screenshot: 'SS1' }] },
      },
    });
    expect(result.evidenceUsed).toContain('SS1');
    expect(result.warnings.some((w) => w.includes('not shown'))).toBe(false);
  });

  it('refuses a screenshot that is not an image before it analyses anything', async () => {
    const fake = join(base, 'fake.png');
    await writeFile(fake, 'not an image');
    const error = await failure(
      generate({
        ...options({
          withContext: false,
          context: { screenshots: [{ path: fake, caption: 'x', moment: 'other' as const }] },
        }),
        dryRun: true,
      }),
    );
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('is not a PNG or JPEG image');
    expect(existsSync(runDir())).toBe(false);
  });
});

describe('the run folder', () => {
  it('is not created when the run fails early', async () => {
    const badRef = await failure(generate(options({ base: 'no-such-branch' })));
    expect(badRef.code).toBe('SOURCE_NOT_FOUND');
    const badPath = await failure(generate(options({ source: join(base, 'missing') })));
    expect(badPath.code).toBe('SOURCE_NOT_FOUND');
    expect(existsSync(join(home, 'runs'))).toBe(false);
  });

  it('is never inside the repository, whatever set it: a subfolder as the source, a config setting, the home', async () => {
    const copy = join(base, 'repo-copy');
    await cp(repo, copy, { recursive: true });
    const inside = join(copy, 'src', 'out');
    // The source is a subfolder of the repository, so the folder is not inside it, but inside the repository.
    const bySubfolder = await failure(
      generate({ ...options({ source: join(copy, 'src'), config: { outDir: inside } }), dryRun: true }),
    );
    expect(bySubfolder.code).toBe('USAGE');
    expect(bySubfolder.message).toContain('inside the repository');
    expect(existsSync(inside)).toBe(false);

    const byHome = await failure(
      generate({ ...options({ source: copy, config: { home: join(copy, '.mergestory') } }), dryRun: true }),
    );
    expect(byHome.code).toBe('USAGE');
    expect(existsSync(join(copy, '.mergestory'))).toBe(false);

    const analysis = await failure(
      prepareAuthoring({ ...options({ source: join(copy, 'src') }), outDir: join(copy, 'authoring') }),
    );
    expect(analysis.code).toBe('USAGE');
    expect(existsSync(join(copy, 'authoring'))).toBe(false);
    // Nothing was added to the repository.
    expect((await readdir(copy)).sort()).toEqual((await readdir(repo)).sort());

    // A folder next to the repository is fine.
    const outside = join(base, 'outside-run');
    await generate({ ...options({ source: join(copy, 'src'), config: { outDir: outside } }), dryRun: true });
    expect(existsSync(join(outside, 'analysis.json'))).toBe(true);
  });
});

describe('generate: publishing', () => {
  it('writes result.json and publish-input.json before it publishes, and names no paths in the latter', async () => {
    let seen: { result: boolean; input: boolean } | null = null;
    publishMock.mockReturnValue({
      id: 's3',
      check: async () => null,
      plannedEgress: () => [],
      publish: async () => {
        seen = {
          result: existsSync(join(runDir(), 'result.json')),
          input: existsSync(join(runDir(), 'publish-input.json')),
        };
        return uploaded;
      },
    });
    const result = await run({ config: S3_CONFIG });
    expect(seen).toEqual({ result: true, input: true });
    expect(result.publish).toEqual(uploaded);
    const stored = await readJson<GenerateResult>(join(runDir(), 'result.json'));
    expect(stored.publish).toEqual(uploaded);
    expect(stored.elapsedSec).toBe(result.elapsedSec);
    expect(result.elapsedSec).toBeGreaterThan(0);
    const input = await readJson<Record<string, unknown>>(join(runDir(), 'publish-input.json'));
    expect(input.files).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain(home);
  });

  it('keeps a usable run when the upload fails, says how to try again, and then publishes it', async () => {
    publishMock.mockReturnValue(
      fakePublisher(
        new MergeStoryError('PUBLISH_FAILED', 'Uploading video.mp4 failed: the connection was reset.', {
          hint: 'Check your network connection.',
        }),
      ),
    );
    const error = await failure(generate(options({ config: S3_CONFIG })));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('the connection was reset');
    expect(error.hint).toContain('Check your network connection.');
    expect(error.hint).toContain(`The video was rendered and is saved in ${runDir()}.`);
    expect(error.hint).toContain(`mergestory publish ${runDir()} --publish s3 --visibility protected`);
    expect(error.details).toMatchObject({ runDir: runDir() });

    // The run is complete: video, watch page, publish input and a result that records what was sent.
    for (const name of [
      'video.mp4',
      'poster.jpg',
      'captions.vtt',
      'publish-input.json',
      'result.json',
      'watch/index.html',
    ]) {
      expect(existsSync(join(runDir(), name)), name).toBe(true);
    }
    const saved = await readJson<GenerateResult>(join(runDir(), 'result.json'));
    expect(saved.publish).toBeNull();
    expect(saved.egress.map((e) => e.purpose)).toContain('video upload');

    // `mergestory publish` picks it up where it stopped.
    publishMock.mockReturnValue(fakePublisher('ok'));
    const retried = await publishRun({ run: runDir(), config: S3_CONFIG });
    expect(retried.publish).toEqual(uploaded);
    expect(retried.title).toBe(saved.title);
    expect(retried.egress.filter((e) => e.purpose === 'video upload')).toHaveLength(2);
    expect((await readJson<GenerateResult>(join(runDir(), 'result.json'))).publish).toEqual(uploaded);
  });

  it('stops a refused public link before anything is narrated or rendered', async () => {
    const render = vi.fn(fakeRenderer.render);
    vi.mocked(createRenderer).mockReturnValue({ ...fakeRenderer, render });
    const error = await failure(
      generate(
        options({
          config: {
            publish: {
              provider: 's3',
              visibility: 'public',
              s3: { bucket: 'media', publicBaseUrl: 'https://videos.example.com' },
            },
          },
        }),
      ),
    );
    expect(error.code).toBe('PRIVACY_BLOCKED');
    expect(render).not.toHaveBeenCalled();
    // Nothing was written, spent or rendered.
    expect(existsSync(runDir())).toBe(false);
  });

  it('stops a missing bucket the same way, naming the setting', async () => {
    const error = await failure(generate(options({ config: { publish: { provider: 's3' } } })));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe('No storage bucket is configured.');
    expect(vi.mocked(createRenderer)).not.toHaveBeenCalled();
    expect(existsSync(runDir())).toBe(false);
  });

  it('can publish a run folder that was moved after it was made', async () => {
    publishMock.mockReturnValue(fakePublisher(new MergeStoryError('PUBLISH_FAILED', 'no network')));
    await failure(generate(options({ config: S3_CONFIG })));
    const moved = join(base, 'moved-run');
    await rename(runDir(), moved);

    publishMock.mockReturnValue(fakePublisher('ok'));
    const result = await publishRun({ run: moved, config: S3_CONFIG });
    expect(result.publish).toEqual(uploaded);
    expect(result.runDir).toBe(moved);
    expect(result.files.video).toBe(join(moved, 'video.mp4'));
    // What was uploaded came from the moved folder (the system may spell it through a link).
    const [bundle] = uploads.slice(-1);
    expect(bundle?.files.map((f) => f.name)).toEqual(['video.mp4', 'poster.jpg', 'captions.vtt']);
    for (const file of bundle?.files ?? []) expect(file.path.endsWith(`moved-run/${file.name}`)).toBe(true);
    expect((await readJson<GenerateResult>(join(moved, 'result.json'))).runDir).toBe(moved);
  });

  it('can publish a run whose result.json is gone', async () => {
    publishMock.mockReturnValue(fakePublisher(new MergeStoryError('PUBLISH_FAILED', 'no network')));
    const failed = await failure(generate(options({ config: S3_CONFIG })));
    await rm(join(runDir(), 'result.json'));
    publishMock.mockReturnValue(fakePublisher('ok'));
    const result = await publishRun({ run: runDir(), config: S3_CONFIG });
    expect(result.publish).toEqual(uploaded);
    expect(result.warnings.some((w) => w.startsWith(EARLIER_RESULT_MISSING))).toBe(true);
    // The publish output does not show $0 for costs that are not known.
    expect(formatPublishResult(result, createStyle(false))).toMatch(/Cost\s+not known/);
    expect(result.title.length).toBeGreaterThan(0);
    expect(failed.code).toBe('PUBLISH_FAILED');
  });
});

describe('generate: details', () => {
  it('writes the review items of the offline storyboard without a list of places', async () => {
    await run();
    const stored = await readJson<{
      reviewChecklist: { title: string; detail: string; ref: { path: string } | null }[];
    }>(join(runDir(), 'storyboard.json'));
    const fromAnalysis = stored.reviewChecklist.filter((item) => item.ref !== null);
    expect(fromAnalysis.length).toBeGreaterThan(0);
    // The page, the video and the comment show the reference next to the detail. A file and line in the detail
    // says the place twice.
    for (const item of fromAnalysis) expect(item.detail).not.toMatch(/\.[a-z]+:\d+/);
  });

  it('writes captions with the e-mail setting that the narration uses', async () => {
    const task =
      'Reported by dev@example.com: forecasts fail when the service is busy and callers retry by hand.';
    const readCaptions = async (maskEmails: boolean): Promise<string> => {
      await rm(runDir(), { recursive: true, force: true });
      await run({ withContext: false, context: { task }, config: { privacy: { maskEmails } } });
      return readFile(join(runDir(), 'captions.vtt'), 'utf8');
    };
    expect(await readCaptions(true)).not.toContain('dev@example.com');
    expect(await readCaptions(false)).toContain('dev@example.com');
  });

  it('stops with TTS_FAILED when the voice cannot be installed, and never speaks with say', async () => {
    const installFailure = new MergeStoryError(
      'TTS_FAILED',
      'The free Kokoro voice could not be installed: offline',
      {
        hint: 'Check the network and that npm works, then run `mergestory setup kokoro` to try again.',
      },
    );
    vi.mocked(ensureKokoroInstalled).mockRejectedValueOnce(installFailure);
    const error = await failure(run({ config: { tts: { provider: 'auto' }, language: 'en' } }));
    expect(error).toBe(installFailure);
    expect(vi.mocked(ensureKokoroInstalled)).toHaveBeenCalledTimes(1);
    expect(existsSync(join(runDir(), 'video.mp4'))).toBe(false);
  });

  it('does not call a deliberate --tts none "no speech provider available"', async () => {
    const off = await run();
    expect(off.warnings).toContain(
      'The video has no voice-over (speech is switched off); captions are included.',
    );
    expect(off.warnings.join(' ')).not.toContain('no speech provider available');
  });

  it('stops for a missing render tool before the storyboard is made', async () => {
    const missing = new MergeStoryError('BROWSER_NOT_FOUND', 'No browser.');
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      ready: async () => Promise.reject(missing),
    });
    expect(await failure(run())).toBe(missing);
    expect(existsSync(join(runDir(), 'storyboard.json'))).toBe(false);
  });

  it('finishes and publishes a video that has no poster', async () => {
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      render: async (input) => {
        const videoPath = join(input.outDir, 'video.mp4');
        await writeFile(videoPath, Buffer.alloc(2048, 1));
        return {
          videoPath,
          posterPath: null,
          width: input.plan.width,
          height: input.plan.height,
          fps: input.plan.fps,
          durationSec: input.plan.durationSec,
          frames: 1,
          reusedFrames: 0,
          sizeBytes: 2048,
        };
      },
    });
    publishMock.mockReturnValue(fakePublisher('ok'));
    const result = await run({ config: S3_CONFIG });
    expect(result.publish).toEqual(uploaded);
    expect(result.files.poster).toBeNull();
    expect(JSON.parse(await readFile(join(runDir(), 'result.json'), 'utf8')).files.poster).toBeNull();
    const [bundle] = uploads.slice(-1);
    expect(bundle?.files.map((f) => f.name)).toEqual(['video.mp4', 'captions.vtt']);
    expect(existsSync(join(runDir(), 'watch', 'index.html'))).toBe(true);
  });

  it('shows the local link as the watch page, with captions that read as written', async () => {
    const task = 'Make retries safe & automatic when status < 600 && status >= 500.';
    const result = await run({ withContext: false, context: { task } });
    expect(result.publish?.provider).toBe('local');
    const page = await readFile(join(runDir(), 'publish', 'index.html'), 'utf8');
    const cues =
      /<script type="application\/json" id="cues"[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '[]';
    const text = (
      JSON.parse(
        cues
          .replace(/\\u003c/gi, '<')
          .replace(/\\u003e/gi, '>')
          .replace(/\\u0026/gi, '&'),
      ) as [number, number, string][]
    )
      .map((cue) => cue[2])
      .join(' ');
    expect(text).toContain('safe & automatic');
    expect(text).not.toContain('&amp;');
  });
});

/** The caption settings that a watch page declares next to the cues it carries itself. */
function captionSettings(page: string): { lang: string; label: string; show: string } {
  const tag = /<script type="application\/json" id="cues"([^>]*)>/.exec(page)?.[1] ?? '';
  const attribute = (name: string): string => new RegExp(`data-${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  return { lang: attribute('lang'), label: attribute('label'), show: attribute('show') };
}

describe('generate: the captions of the watch page', () => {
  it('starts the page captions off when the video already shows them, and names the narration language', async () => {
    await run({ config: { language: 'de' } });
    const storyboard = await readJson<{ language: string }>(join(runDir(), 'storyboard.json'));
    expect(storyboard.language).toBe('de');
    const expected = { lang: storyboard.language, label: 'German', show: 'false' };
    // The local publisher's page and the page in the run folder come from the same watch data.
    expect(captionSettings(await readFile(join(runDir(), 'publish', 'index.html'), 'utf8'))).toEqual(
      expected,
    );
    expect(captionSettings(await readFile(join(runDir(), 'watch', 'index.html'), 'utf8'))).toEqual(expected);
  });

  it('starts them on when the video has no captions of its own', async () => {
    await run({ config: { captions: false } });
    const page = await readFile(join(runDir(), 'publish', 'index.html'), 'utf8');
    expect(captionSettings(page)).toEqual({ lang: 'en', label: 'English', show: 'true' });
  });

  it('gives an uploaded page a caption track in the narration language that is not switched on', async () => {
    publishMock.mockReturnValue(fakePublisher('ok'));
    await run({ config: { ...S3_CONFIG, language: 'de' } });
    const html = uploads[0]?.buildWatchPage({
      video: 'https://videos.example.com/v/video.mp4',
      poster: null,
      captions: 'https://videos.example.com/v/captions.vtt',
      linkExpiresAt: null,
    });
    const track = /<track [^>]*>/.exec(html ?? '')?.[0] ?? '';
    expect(track).toContain('srclang="de"');
    expect(track).toContain('label="German"');
    expect(track).not.toContain(' default');
  });

  it('keeps both settings for a video that is published later', async () => {
    await run({ config: { language: 'de' } });
    const stored = await readJson<{ watch: { captionsDefault?: boolean; language?: string } }>(
      join(runDir(), 'publish-input.json'),
    );
    expect(stored.watch).toMatchObject({ captionsDefault: false, language: 'de' });
    const later = join(base, 'published-later');
    await publishRun({ run: runDir(), config: { publish: { provider: 'local', localDir: later } } });
    expect(captionSettings(await readFile(join(later, 'index.html'), 'utf8'))).toEqual({
      lang: 'de',
      label: 'German',
      show: 'false',
    });
  });
});

describe('output folders', () => {
  const LINK = 'is a symbolic link or holds one.';

  it('never makes a work folder a run folder, but lets analyze write there', async () => {
    const work = join(home, 'work', 'draft');
    await expect(plan({ config: { outDir: work } })).rejects.toThrow(
      'The work folder holds drafts. It cannot be a run folder.',
    );
    // Another letter case names the same folder on a disk that ignores case, also before it exists.
    await expect(plan({ config: { outDir: join(home, 'WORK', 'draft') } })).rejects.toThrow(
      'It cannot be a run folder.',
    );
    await mkdir(join(work, 'run'), { recursive: true });
    await writeFile(join(work, 'run', 'publish-input.json'), '{}');
    await expect(publishRun({ run: join(work, 'run'), config: { home } })).rejects.toThrow(
      'It cannot be a run folder.',
    );
    const result = await prepareAuthoring({ ...options({ withContext: false }), outDir: work });
    expect(result.runDir).toBe(work);
  });

  it('sees a work folder behind a link, also for a run folder that does not exist yet', async () => {
    await mkdir(join(home, 'work'), { recursive: true });
    await symlink(join(home, 'work'), join(base, 'elsewhere'));
    await expect(plan({ config: { outDir: join(base, 'elsewhere', 'new-run') } })).rejects.toThrow(
      'It cannot be a run folder.',
    );
  });

  it.each([
    [
      'a link to a file',
      async (out: string) => symlink(join(base, 'secret.txt'), join(out, 'analysis.json')),
    ],
    [
      'a link to a folder',
      async (out: string) => {
        await mkdir(join(out, 'deep'));
        await symlink(base, join(out, 'deep', 'up'));
      },
    ],
    [
      'a link itself',
      async (out: string) => {
        await rm(out, { recursive: true });
        await symlink(base, out);
      },
    ],
  ])('refuses an output folder that holds %s', async (label, setup) => {
    await writeFile(join(base, 'secret.txt'), 'keep');
    const out = join(base, `out-${label.replace(/\W+/g, '-')}`);
    await mkdir(out);
    await setup(out);
    await expect(prepareAuthoring({ ...options({ withContext: false }), outDir: out })).rejects.toThrow(LINK);
    await expect(plan({ config: { outDir: out } })).rejects.toThrow(LINK);
    expect(await readFile(join(base, 'secret.txt'), 'utf8')).toBe('keep');
  });
});

describe('prepareAuthoring: AUTHORING.md', () => {
  it('says how many tokens the agent reads: the evidence pack and the guide, not the schema', async () => {
    const messages: string[] = [];
    const result = await prepareAuthoring(
      { ...options({ withContext: false }), outDir: join(base, 'authoring-tokens') },
      { onProgress: (event) => messages.push(event.message) },
    );
    const evidence = await readFile(result.files.evidence, 'utf8');
    const guide = await readFile(result.files.guide, 'utf8');
    const schema = await readFile(result.files.schema, 'utf8');
    const line = messages.find((m) => m.startsWith('Wrote the evidence pack'));
    const tokens = Number(
      /reads about (\d+) tokens: the evidence pack and the guide\.$/.exec(line ?? '')?.[1],
    );
    expect(tokens).toBe(estimateTokens(`${evidence}${guide}`));
    // The schema is still written, for looking up a schema error. It is the largest of the three files.
    expect(schema.length).toBeGreaterThan(guide.length);
    expect(guide).toContain('you do not need to read `storyboard.schema.json`');
  });

  it('names every field and every allowed value of the schema in AUTHORING.md', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-complete'),
    });
    const guide = await readFile(result.files.guide, 'utf8');
    const fields = new Set<string>();
    const names = new Set<string>();
    const fixed: string[][] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum)) fixed.push(record.enum.map(String));
      if (typeof record.const === 'string') names.add(record.const);
      for (const key of Object.keys((record.properties as object | undefined) ?? {})) fields.add(key);
      Object.values(record).forEach(walk);
    };
    walk(await readJson<unknown>(result.files.schema));
    expect(fields.size).toBeGreaterThan(50);
    expect(fixed.length).toBeGreaterThan(20);
    for (const field of fields) expect(guide, `the field ${field}`).toContain(`"${field}"`);
    for (const name of names) expect(guide, `the value ${name}`).toContain(`"${name}"`);
    // A list of the section holds the values of one field: all of them, in the order of the schema.
    const section = guide.slice(guide.indexOf('## Allowed values'));
    const lists = [...section.matchAll(/^- .*: (.+)\.$/gm)].map((match) => match[1]?.split(', '));
    for (const values of fixed) expect(lists, values.join(', ')).toContainEqual(values);
    // The rules that the guide leaves to the descriptions in the schema, such as how a table keeps its rows.
    for (const field of [
      SceneSchema.shape.title,
      TitleVisualSchema.shape.chips,
      CodeVisualSchema.shape.focus,
      BrowserVisualSchema.shape.blocks.element.shape.text,
      BrowserVisualSchema.shape.blocks.element.shape.items,
      ScreenshotVisualSchema.shape.highlights,
      ScreenshotVisualSchema.shape.focus,
      PanelSchema.shape.highlights,
      HighlightSchema.shape.label,
    ]) {
      expect(field.description).toBeTruthy();
      expect(guide).toContain(field.description);
    }
  });

  it('says what the text of every kind of browser block shows', () => {
    const { kind, text } = BrowserVisualSchema.shape.blocks.element.shape;
    // A kind comes before a colon or a comma, as in "heading, text: the text on the block. input: the label".
    for (const name of kind.options) expect(text.description, name).toMatch(new RegExp(`\\b${name}[,:]`));
  });

  it('states the limits for terminal lines and browser blocks, and where validate reports a trim', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-limits'),
    });
    const guide = await readFile(result.files.guide, 'utf8');
    const rules = guide.slice(guide.indexOf('## More field rules'));
    expect(rules).toContain(
      `"terminal" of a before-after panel: at most ${STORYBOARD_LIMITS.maxTerminalLines} lines.`,
    );
    expect(rules).toContain(
      `"blocks" of a browser visual: at most ${STORYBOARD_LIMITS.maxBrowserBlocks} blocks.`,
    );
    // A trim is a fix. The text output of validate lists fixes under a heading, and the JSON result under "fixes".
    const heading = 'Fixed automatically when rendering';
    expect(rules).toContain(`under "${heading}" ("fixes" in the \`--json\` result)`);
    const printed = formatValidation(
      {
        storyboard: null,
        errors: [],
        warnings: [],
        fixes: ['kept the first 8 of 11 blocks'],
        groundedClaims: 0,
      },
      createStyle(false),
    );
    expect(printed).toContain(heading);
  });

  it('says that the word budget is a guide, and what the longest video does', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-budget'),
    });
    const guide = await readFile(result.files.guide, 'utf8');
    expect(guide).toContain('This is a guide, not a limit: narration over it is kept as it is.');
    expect(guide).toContain(
      '`validate` warns (over-length) and `generate` leaves out the least important scenes and lines',
    );
    // The demo storyboard is over the budget that this guide gives. Nothing reports it and nothing is left out.
    const budget = Number(/about (\d+) words of narration in total/.exec(guide)?.[1]);
    const board = await readJson<Storyboard>(join(DEMO, 'storyboard.json'));
    expect(narrationWords(board)).toBeGreaterThan(budget);
    const checked = await checkStoryboard({ ...options(), storyboard: board });
    expect(checked.warnings.filter((w) => w.code === 'over-length')).toEqual([]);
    const planned = await plan({ storyboard: board });
    expect(planned.scenes).toHaveLength(board.scenes.length);
    expect(planned.warnings.filter((w) => w.includes('--max-duration'))).toEqual([]);
  });

  it('shows validate and generate with the source and the flags of the analysis', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-with-flags'),
      followUp: {
        source: repo,
        args: [
          '--base',
          'main',
          '--head',
          'feature/retry',
          '--task-file',
          '/work/my task.md',
          '--tests-file',
          '/work/tests.json',
        ],
      },
    });
    const guide = await readFile(result.files.guide, 'utf8');
    const storyboard = join(result.runDir, 'storyboard.json');
    expect(guide).toContain(
      `\`mergestory validate ${storyboard} ${repo} --base main --head feature/retry --task-file '/work/my task.md' --tests-file /work/tests.json\``,
    );
    expect(guide).toContain(
      `\`mergestory generate ${repo} --base main --head feature/retry --task-file '/work/my task.md' --tests-file /work/tests.json --storyboard ${storyboard}\``,
    );
    expect(guide).not.toContain('<source>');
    expect(guide).not.toContain('Give both commands the same source');
  });

  it('quotes a task that starts with #, so that a shell does not take it for a comment', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-hash'),
      followUp: { source: repo, args: ['--task', '#42', '--notes-file', '~/notes.md'] },
    });
    const guide = await readFile(result.files.guide, 'utf8');
    const storyboard = join(result.runDir, 'storyboard.json');
    expect(guide).toContain(
      `\`mergestory validate ${storyboard} ${repo} --task '#42' --notes-file '~/notes.md'\``,
    );
    expect(guide).toContain(
      `\`mergestory generate ${repo} --task '#42' --notes-file '~/notes.md' --storyboard ${storyboard}\``,
    );
  });

  it('shows the agent commands, which find the files by name, for the agent', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-agent'),
      followUp: { source: '.', args: ['--name', 'fix-1', '--base', 'main'], agent: true },
    });
    const guide = await readFile(result.files.guide, 'utf8');
    expect(guide).toContain('`mergestory agent validate . --name fix-1 --base main`');
    expect(guide).toContain('`mergestory agent render . --name fix-1 --base main`');
    expect(guide).toContain('`task.md`, `notes.md` in this folder');
    expect(guide).toContain('The steps that show the bug go in `repro.json` here.');
    expect(guide).not.toContain('mergestory generate');
    expect(guide).not.toContain('--storyboard');
  });

  it('tells the author to repeat the flags when the command line is not known', async () => {
    const result = await prepareAuthoring({
      ...options({ withContext: false }),
      outDir: join(base, 'authoring-plain'),
    });
    const guide = await readFile(result.files.guide, 'utf8');
    expect(guide).toContain('`mergestory validate storyboard.json <source>`');
    expect(guide).toContain('`mergestory generate <source> --storyboard storyboard.json`');
    expect(guide).toContain(
      'Give both commands the same source and the same `--base`, `--head`, `--task-file`',
    );
    expect(guide).toContain('`--repro-file`, `--screenshot` and `--recording` flags as the analysis');
    expect(guide).toContain('They create the ids TASK, NOTES, T1, REPRO, SS1 and RC1');
    expect(guide).toContain('Longest video: 150 seconds.');
  });
});

describe('checkStoryboard', () => {
  it('does not leave a run folder behind', async () => {
    const board = await readJson<unknown>(join(DEMO, 'storyboard.json'));
    await checkStoryboard({ ...options(), storyboard: board });
    expect(existsSync(runDir())).toBe(false);
  });

  it('says what rendering would leave out when the storyboard is over the limit', async () => {
    const shortBoard = await readJson<unknown>(join(DEMO, 'storyboard.json'));
    const verdict = await checkStoryboard({ ...options(), storyboard: shortBoard });
    const tight = await checkStoryboard({
      ...options({ config: { maxDurationSec: 20 } }),
      storyboard: shortBoard,
    });
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.filter((w) => w.code === 'over-length')).toEqual([]);
    const notice = tight.warnings.filter((w) => w.code === 'over-length');
    expect(notice).toHaveLength(1);
    expect(notice[0]?.message).toContain('Rendering would leave out');
    expect(notice[0]?.message).toContain('over the maximum of 20 s (--max-duration)');
  });

  it('logs one line when the storyboard has errors: how many, and how many of each code', async () => {
    type Board = {
      scenes: { narration: { evidence: string[] }[]; visual: { ref?: { path: string } } }[];
    };
    const check = async (uncitedScenes: number[]) => {
      const board = await readJson<Board>(join(DEMO, 'storyboard.json'));
      for (const index of uncitedScenes)
        for (const line of board.scenes[index]!.narration) line.evidence = [];
      // Scene 4 shows code from a file that is not in the change.
      board.scenes[3]!.visual.ref!.path = 'src/nope.ts';
      const lines: string[] = [];
      const events: { stage: string; status: string; message: string }[] = [];
      const result = await checkStoryboard(
        { ...options(), storyboard: board, logger: createLogger({ write: (line) => lines.push(line) }) },
        { onProgress: (event) => events.push(event) },
      );
      return { result, lines: lines.filter((line) => line.includes('[validate]')), events };
    };

    // The most frequent code comes first.
    const mixed = await check([0, 1]);
    expect(mixed.result.errors.map((error) => error.code).sort()).toEqual([
      'code-ref-unknown-path',
      'uncited-line',
      'uncited-line',
    ]);
    const summary = 'Storyboard has errors: 3 (uncited-line 2, code-ref-unknown-path 1)';
    expect(mixed.events.filter((event) => event.stage === 'validate')).toEqual([
      { stage: 'validate', status: 'warn', message: summary },
    ]);
    expect(mixed.lines).toEqual([`warn: [validate] ${summary}`]);

    // Codes with the same number are in alphabetical order, so the line does not depend on the order of the scenes.
    const tied = await check([0]);
    expect(tied.lines).toEqual([
      'warn: [validate] Storyboard has errors: 2 (code-ref-unknown-path 1, uncited-line 1)',
    ]);
  });

  it('logs no such line for a storyboard without errors', async () => {
    const board = await readJson<unknown>(join(DEMO, 'storyboard.json'));
    const lines: string[] = [];
    const result = await checkStoryboard({
      ...options(),
      storyboard: board,
      logger: createLogger({ write: (line) => lines.push(line) }),
    });
    expect(result.errors).toEqual([]);
    expect(lines.filter((line) => line.includes('Storyboard has errors'))).toEqual([]);
  });
});

describe('generate: a supplied storyboard with errors', () => {
  it('is refused with GROUNDING_FAILED, and each problem is in the details with its path, code and message', async () => {
    const board = await readJson<{ scenes: { visual: Record<string, unknown> }[] }>(
      join(DEMO, 'storyboard.json'),
    );
    // The first scene is a title card, and the heading is a required field.
    delete board.scenes[0]?.visual.heading;
    const error = await failure(generate({ ...options(), storyboard: board, dryRun: true }));
    expect(error.code).toBe('GROUNDING_FAILED');
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe('The supplied storyboard has 1 problem(s) that block rendering.');
    expect(error.hint).toBe(
      'Fix the listed problems and run again. `mergestory validate <storyboard.json> <source>` checks without rendering.',
    );
    expect(error.details).toEqual({
      errors: [{ path: 'scenes[0].visual.heading', code: 'schema', message: expect.any(String) }],
      warnings: [],
    });
  });

  it('holds at most 40 problems, and the text of the error says that more may follow', async () => {
    const board = await readJson<{ scenes: Record<string, unknown>[] }>(join(DEMO, 'storyboard.json'));
    // Five required fields are missing from each of the nine scenes: 45 schema problems.
    for (const scene of board.scenes)
      for (const field of ['id', 'role', 'title', 'visualDescription', 'transition']) delete scene[field];
    const error = await failure(generate({ ...options(), storyboard: board, dryRun: true }));
    expect(error.code).toBe('GROUNDING_FAILED');
    expect(error.details?.errors).toHaveLength(40);
    const lines = formatError(describeError(error), createStyle(false)).split('\n');
    expect(lines.filter((line) => line.startsWith('  error  '))).toHaveLength(40);
    expect(lines[41]).toContain('The list shows at most 40 problems.');
    expect(lines[42]).toMatch(/^hint: /);
  });
});

describe('generate: the result in the run folder', () => {
  it('puts watch.html next to the video, and names the files, the scenes and the evidence in the result', async () => {
    const result = await run();
    for (const name of [
      'video.mp4',
      'poster.jpg',
      'captions.vtt',
      'captions.srt',
      'watch.html',
      'result.json',
    ])
      expect(existsSync(join(runDir(), name)), name).toBe(true);
    // The page of the watch folder. It finds the video by its name, so it works next to the video as it is.
    const page = await readFile(join(runDir(), 'watch.html'), 'utf8');
    expect(page).toBe(await readFile(join(runDir(), 'watch', 'index.html'), 'utf8'));
    expect(page).toContain('"video.mp4"');
    expect(page).not.toContain(runDir());
    expect(result.files).toMatchObject({
      captionsSrt: join(runDir(), 'captions.srt'),
      watchHtml: join(runDir(), 'watch.html'),
    });

    // The scenes are the rendered ones, with the timing of the video.
    const rendered = await readJson<{
      scenes: {
        id: string;
        role: string;
        title: string;
        startSec: number;
        durationSec: number;
        visual: { type: string };
      }[];
    }>(join(runDir(), 'render-plan.json'));
    expect(rendered.scenes.length).toBeGreaterThan(2);
    expect(result.scenes).toEqual(
      rendered.scenes.map(({ id, role, title, startSec, durationSec, visual }) => ({
        id,
        role,
        title,
        visual: visual.type,
        startSec,
        durationSec,
      })),
    );
    expect(result.scenes?.[0]?.startSec).toBe(0);

    // Every id that the video cites exists, and each is named once.
    const analysis = await readJson<{ evidence: { id: string }[] }>(join(runDir(), 'analysis.json'));
    const known = new Set(analysis.evidence.map((item) => item.id));
    const used = result.evidenceUsed ?? [];
    expect(used.length).toBeGreaterThan(3);
    expect(new Set(used).size).toBe(used.length);
    expect(used.filter((id) => !known.has(id))).toEqual([]);
    expect(used).toContain('TASK');

    expect(await readJson(join(runDir(), 'result.json'))).toEqual(result);
  });

  it('leaves the error as result.json when a run fails after its folder exists, and no video', async () => {
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      render: async () => {
        throw new MergeStoryError(
          'RENDER_FAILED',
          'The browser stopped responding while capturing a frame.',
          {
            hint: 'Try another browser.',
          },
        );
      },
    });
    const error = await failure(generate(options()));
    expect(error.code).toBe('RENDER_FAILED');
    expect(await readJson(join(runDir(), 'result.json'))).toEqual({
      ok: false,
      runId: RUN_ID,
      runDir: runDir(),
      error: {
        code: 'RENDER_FAILED',
        message: 'The browser stopped responding while capturing a frame.',
        hint: 'Try another browser.',
        details: null,
      },
    });
    expect(existsSync(join(runDir(), 'video.mp4'))).toBe(false);
    expect(existsSync(join(runDir(), 'watch.html'))).toBe(false);
  });

  it('never leaves the video or the result of an earlier run in a folder that is used again', async () => {
    await run();
    expect((await readJson<{ ok: boolean }>(join(runDir(), 'result.json'))).ok).toBe(true);
    const delivered = [
      'video.mp4',
      'poster.jpg',
      'captions.vtt',
      'captions.srt',
      'watch.html',
      'publish-input.json',
      // The copies for watching and for the local publish folder.
      'watch/index.html',
      'watch/video.mp4',
      'watch/poster.jpg',
      'publish/index.html',
      'publish/video.mp4',
      'publish/poster.jpg',
    ];
    for (const name of delivered) expect(existsSync(join(runDir(), name)), name).toBe(true);

    // The same folder again, and this time the storyboard is refused.
    const error = await failure(generate(options({ storyboard: { version: 1 } })));
    expect(error.code).toBe('GROUNDING_FAILED');
    const stored = await readJson<{ ok: boolean; error: { code: string; details: { errors: unknown[] } } }>(
      join(runDir(), 'result.json'),
    );
    expect(stored.ok).toBe(false);
    expect(stored.error.code).toBe('GROUNDING_FAILED');
    expect(stored.error.details.errors.length).toBeGreaterThan(0);
    // Nothing a caller would upload, and nothing `mergestory publish` trusts, is left from the first run.
    for (const name of delivered) expect(existsSync(join(runDir(), name)), name).toBe(false);
    await expect(publishRun({ run: runDir() })).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });

    // A run that works replaces it again.
    await run();
    expect((await readJson<{ ok: boolean }>(join(runDir(), 'result.json'))).ok).toBe(true);
  });

  it('writes no result for a run that fails before it has read the change, and keeps an earlier one', async () => {
    const early = await failure(generate(options({ head: 'no-such-branch' })));
    expect(early.code).toBe('SOURCE_NOT_FOUND');
    expect(existsSync(runDir())).toBe(false);

    // The same in a folder that holds the result of an earlier run: that file is not touched.
    const first = await run();
    await failure(generate(options({ head: 'no-such-branch' })));
    expect(await readJson(join(runDir(), 'result.json'))).toEqual(first);
  });

  it('removes nothing from a folder that holds no earlier run, also when the run fails', async () => {
    // A folder that the user chose, with files of theirs that happen to have the fixed names.
    await mkdir(runDir(), { recursive: true });
    await writeFile(join(runDir(), 'video.mp4'), 'a video of mine');
    await writeFile(join(runDir(), 'result.json'), '{"score": 3}');
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      render: async () => {
        throw new MergeStoryError('RENDER_FAILED', 'The browser stopped responding.');
      },
    });
    await failure(generate(options()));
    expect(await readFile(join(runDir(), 'video.mp4'), 'utf8')).toBe('a video of mine');
    // The run still says what happened, in the file where a caller looks for it.
    expect(await readJson(join(runDir(), 'result.json'))).toMatchObject({
      ok: false,
      error: { code: 'RENDER_FAILED' },
    });
  });

  it('keeps the result of the finished video when only the upload fails', async () => {
    publishMock.mockReturnValue(
      fakePublisher(new MergeStoryError('PUBLISH_FAILED', 'Uploading video.mp4 failed.')),
    );
    await failure(generate(options({ config: S3_CONFIG })));
    const stored = await readJson<GenerateResult>(join(runDir(), 'result.json'));
    expect(stored).toMatchObject({ ok: true, publish: null });
    expect(stored.files.video).toBe(join(runDir(), 'video.mp4'));
  });

  it('writes no result for a dry run, and leaves an earlier one alone', async () => {
    await plan();
    expect(existsSync(join(runDir(), 'analysis.json'))).toBe(true);
    expect(existsSync(join(runDir(), 'result.json'))).toBe(false);
    await run();
    await plan();
    expect((await readJson<{ ok: boolean }>(join(runDir(), 'result.json'))).ok).toBe(true);
  });

  it('masks a secret that the error carries before it is written', async () => {
    const token = `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      render: async () => {
        throw new MergeStoryError('RENDER_FAILED', `The encoder said: ${token}`, {
          details: { line: token },
        });
      },
    });
    await failure(generate(options()));
    const text = await readFile(join(runDir(), 'result.json'), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted]');
  });
});

describe('generate: the time limit of the render', () => {
  /** A renderer that never finishes by itself. It stops when the run is cancelled, like the real one. */
  const endless = (onStart: () => void = () => undefined): Renderer => ({
    id: 'endless',
    ready: async () => {},
    render: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        const stop = (): void => reject(abortedError());
        if (ctx.signal.aborted) stop();
        else ctx.signal.addEventListener('abort', stop, { once: true });
        onStart();
      }),
  });

  it('stops a render that runs past render.maxSeconds with RENDER_TIMEOUT, exit code 8 and no video', async () => {
    vi.mocked(createRenderer).mockReturnValue(endless());
    const started = performance.now();
    const error = await failure(generate(options({ config: { render: { maxSeconds: 1 } } })));
    expect(error.code).toBe('RENDER_TIMEOUT');
    expect(error.exitCode).toBe(8);
    expect(error.message).toContain('the limit of 1 second,');
    expect(error.message).toContain('No video was written');
    expect(error.hint).toContain('--max-render-seconds');
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(existsSync(join(runDir(), 'video.mp4'))).toBe(false);
    expect(await readJson(join(runDir(), 'result.json'))).toMatchObject({
      ok: false,
      error: { code: 'RENDER_TIMEOUT' },
    });
  });

  it('reports a cancel during the render as a cancel, not as a timeout', async () => {
    const controller = new AbortController();
    vi.mocked(createRenderer).mockReturnValue(endless(() => setTimeout(() => controller.abort(), 20)));
    const error = await failure(
      generate({ ...options({ config: { render: { maxSeconds: 600 } } }), signal: controller.signal }),
    );
    expect(error.code).toBe('ABORTED');
    expect(await readJson(join(runDir(), 'result.json'))).toMatchObject({
      ok: false,
      error: { code: 'ABORTED' },
    });
  });

  it('counts a stop that is both a cancel and a time limit as a cancel', async () => {
    // The limit fires first. The renderer only gives up once the run is cancelled as well.
    const controller = new AbortController();
    vi.mocked(createRenderer).mockReturnValue({
      id: 'slow-to-stop',
      ready: async () => {},
      render: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              controller.abort();
              reject(abortedError());
            },
            { once: true },
          );
        }),
    });
    const error = await failure(
      generate({ ...options({ config: { render: { maxSeconds: 1 } } }), signal: controller.signal }),
    );
    expect(error.code).toBe('ABORTED');
  });

  it('stops its clock when the render is done, so a finished run does not wait for the limit', async () => {
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await run({ config: { render: { maxSeconds: 4321 } } });
      const index = set.mock.calls.findIndex((call) => call[1] === 4_321_000);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(set.mock.results[index]?.value);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it('lets a render that is quick enough finish, and gives the renderer the run as it is without a limit', async () => {
    expect((await run({ config: { render: { maxSeconds: 600 } } })).ok).toBe(true);
    let signal: AbortSignal | null = null;
    vi.mocked(createRenderer).mockReturnValue({
      ...fakeRenderer,
      render: async (input, ctx) => {
        signal = ctx.signal;
        return fakeRenderer.render(input, ctx);
      },
    });
    const controller = new AbortController();
    await generate({ ...options(), signal: controller.signal });
    expect(signal).toBe(controller.signal);
  });
});

const ffmpegTools = await resolveFfmpeg(testConfig()).catch(() => null);

describe('generate: a wide screenshot', () => {
  it('stops before any speech when it cannot be made smaller, naming it, and a dry run loads nothing', async () => {
    const wide = join(base, 'wide-page.png');
    await writeFile(wide, pngHeader(3000, 100));
    const broken = join(base, 'ffmpeg-fails-wide.sh');
    await writeFile(broken, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const demo = await readJson<Storyboard>(join(DEMO, 'storyboard.json'));
    const scene = structuredClone(demo.scenes[0]!);
    const storyboard: Storyboard = {
      ...demo,
      scenes: [
        ...demo.scenes,
        {
          ...scene,
          id: 'shot',
          role: 'under-the-hood',
          narration: [{ text: 'The page shows the failure.', evidence: ['SS1'] }],
          visual: {
            type: 'screenshot',
            screenshotId: 'SS1',
            caption: 'The page',
            highlights: [],
            focus: null,
          },
        },
      ],
    };
    const given = {
      storyboard,
      withContext: false,
      context: { screenshots: [{ path: wide, caption: 'Page', moment: 'before' as const }] },
      config: { render: { ffmpegPath: broken } },
    };
    await plan(given);
    const narration = await import('../narration/index.ts');
    const spy = vi.spyOn(narration, 'synthesizeNarration');
    try {
      const error = await failure(run(given));
      expect(error.code).toBe('USAGE');
      expect(error.message).toContain('Screenshot SS1 (wide-page.png)');
      expect(error.message).toContain('could not be made smaller');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(ffmpegTools === null)('generate: recordings', () => {
  let clip: string;
  let storyboard: Storyboard;
  beforeAll(async () => {
    clip = join(base, 'bug.mp4');
    expect(await makeClip(ffmpegTools!.ffmpeg, clip, { seconds: 3 })).toBe(true);
    const demo = await readJson<Storyboard>(join(DEMO, 'storyboard.json'));
    const scene = structuredClone(demo.scenes[0]!);
    storyboard = {
      ...demo,
      scenes: [
        ...demo.scenes,
        {
          ...scene,
          id: 'rec',
          role: 'under-the-hood',
          narration: [{ text: 'The recording shows the failure.', evidence: ['RC1'] }],
          visual: {
            type: 'recording',
            recordingId: 'RC1',
            caption: 'Failure',
            trim: null,
            speed: null,
            zoom: null,
            highlights: [],
            focus: null,
          },
        },
      ],
    };
  });
  const withClip = () => ({
    storyboard,
    context: { recordings: [{ path: clip, caption: 'Failure', moment: 'before' as const }] },
    withContext: false,
  });
  // The recording scene is appended to the scenes of the demo, so its place is the next number.
  const frames = () => join(runDir(), 'recording-frames', `s-${storyboard.scenes.length}`);

  it('cuts the frames before any speech is made', async () => {
    const narration = await import('../narration/index.ts');
    const original = narration.synthesizeNarration;
    let seen: string[] | null = null;
    const spy = vi.spyOn(narration, 'synthesizeNarration').mockImplementation(async (...args) => {
      seen = await readdir(frames()).catch(() => null);
      return original(...args);
    });
    try {
      const result = await run(withClip());
      expect(result.scenes?.find((s) => s.id === 'rec')?.visual).toBe('recording');
      expect(result.evidenceUsed).toContain('RC1');
    } finally {
      spy.mockRestore();
    }
    expect(seen).not.toBeNull();
    expect(seen!.length).toBeGreaterThan(20);
    const plan = await readJson<{ scenes: { id: string; visual: { frames?: { count: number } } }[] }>(
      join(runDir(), 'render-plan.json'),
    );
    expect(plan.scenes.find((s) => s.id === 'rec')?.visual.frames?.count).toBe(seen!.length);
  });

  it('leaves the e-mail address of an unused recording caption out of the warnings and the progress messages', async () => {
    const messages: string[] = [];
    const caption = 'Reported by jane.doe@example.com';
    const result = (await generate(
      options({ context: { ...context, recordings: [{ path: clip, caption, moment: 'before' as const }] } }),
      { onProgress: (event) => messages.push(event.message) },
    )) as GenerateResult;
    // The offline storyboard never shows a recording, so the warning names it.
    const warning = result.warnings.find((w) => w.includes('RC1'));
    expect(warning).toContain('is not shown in the video');
    expect(warning).toContain('j•••@example.com');
    for (const text of [...result.warnings, ...messages]) expect(text).not.toContain('jane.doe@');
  });

  it('stops before any speech when a recording cannot be decoded', async () => {
    const broken = join(base, 'ffmpeg-fails.sh');
    await writeFile(broken, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const narration = await import('../narration/index.ts');
    const spy = vi.spyOn(narration, 'synthesizeNarration');
    try {
      const error = await failure(run({ ...withClip(), config: { render: { ffmpegPath: broken } } }));
      expect(error.code).toBe('USAGE');
      expect(error.message).toContain('Recording RC1');
      expect(error.message).toContain('could not be decoded');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('cuts nothing in a dry run', async () => {
    await plan(withClip());
    expect(existsSync(join(runDir(), 'recording-frames'))).toBe(false);
  });

  it('removes the frames of an earlier run, but only from a folder that holds one', async () => {
    await run();
    await mkdir(join(runDir(), 'recording-frames', 'old'), { recursive: true });
    await writeFile(join(runDir(), 'recording-frames', 'old', 'f-00001.jpg'), 'x');
    await run();
    expect(existsSync(join(runDir(), 'recording-frames'))).toBe(false);

    // A folder that holds no result or publish file of a run is not touched.
    const other = join(home, 'other-folder');
    await mkdir(join(other, 'recording-frames', 'mine'), { recursive: true });
    await run({ outDir: other });
    expect(existsSync(join(other, 'recording-frames', 'mine'))).toBe(true);
  });
});

/**
 * One video for a change in two repositories, on real local git repositories. The renderer is a
 * stand-in that keeps the plan it was given; everything before it is the real thing.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Renderer } from '../core/providers.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import type { GenerateResult } from '../core/types.ts';
import { ensureKokoroInstalled } from '../narration/kokoro-install.ts';
import { createRenderer } from '../render/index.ts';
import { createSourceProvider } from '../sources/index.ts';
import { isolateGitConfig, makeRepo } from '../testing/repos.ts';
import { checkStoryboard, generate, prepareAuthoring } from './index.ts';

vi.mock('../render/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../render/index.ts')>()),
  createRenderer: vi.fn(),
}));
// A source that loads with no files (a pull request can) is put in place by one test.
vi.mock('../sources/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sources/index.ts')>();
  return { ...real, createSourceProvider: vi.fn(real.createSourceProvider) };
});
// The run that is refused must stop before it installs the voice.
vi.mock('../narration/kokoro-install.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../narration/kokoro-install.ts')>()),
  ensureKokoroInstalled: vi.fn(async () => {
    throw new Error('these tests never install the Kokoro voice');
  }),
}));

let restoreGit: () => void;
let base: string;
let home: string;
let api: string;
let web: string;
let plans: RenderPlan[];

const readmeMore = '\nA small part of a shop.\n';

beforeAll(async () => {
  restoreGit = isolateGitConfig();
  base = await mkdtemp(join(tmpdir(), 'mergestory-several-'));
  api = await makeRepo(
    base,
    'orders-api',
    'export function orderTotal(order) {\n  return order.lines.reduce((sum, line) => sum + line.price, 0);\n}\n',
    'export function orderTotal(order) {\n  const cents = order.lines.reduce((sum, line) => sum + line.priceCents, 0);\n  return { cents };\n}\n',
    readmeMore,
  );
  web = await makeRepo(
    base,
    'storefront',
    'export function showTotal(order) {\n  return order.total;\n}\n',
    'export function showTotal(order) {\n  return order.total.cents / 100;\n}\n',
    readmeMore,
  );
});

afterAll(async () => {
  restoreGit();
  await rm(base, { recursive: true, force: true });
});

const capturingRenderer: Renderer = {
  id: 'fake',
  ready: async () => {},
  render: async (input) => {
    plans.push(input.plan);
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

beforeEach(async () => {
  home = await mkdtemp(join(base, 'home-'));
  vi.stubEnv('MERGESTORY_HOME', home);
  plans = [];
  vi.mocked(createRenderer).mockReturnValue(capturingRenderer);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const range = { base: 'main', head: 'fix/total' };
const both = () => [
  { kind: 'local' as const, repoPath: api, ...range },
  { kind: 'local' as const, repoPath: web, ...range },
];
const config = () => ({ home, tts: { provider: 'none' as const }, quality: 'draft' as const });

/** A storyboard that cites both repositories and shows the code of both. */
function storyboard() {
  const scene = (id: string, role: string, narration: object[], visual: object) => ({
    id,
    role,
    title: id,
    narration,
    visual,
    visualDescription: 'A scene.',
    transition: 'fade',
    targetSeconds: null,
  });
  const code = (path: string) => ({
    type: 'code',
    ref: { path, side: 'head', startLine: 1, endLine: 3 },
    mode: 'diff',
    focus: [],
    caption: null,
  });
  return {
    version: 1,
    title: 'The total in cents',
    summary: 'The service returns cents and the page shows them.',
    style: 'technical',
    language: 'en',
    scenes: [
      scene(
        's1',
        'mission',
        [{ text: 'The total is wrong unless both changes are merged.', evidence: ['A.CM1', 'B.CM1'] }],
        {
          type: 'title',
          kicker: 'Two repositories',
          heading: 'The total in cents',
          subheading: null,
          chips: [],
        },
      ),
      scene(
        's2',
        'under-the-hood',
        [{ text: 'The service now returns cents.', evidence: ['A.F1.H1'] }],
        code('orders-api/src/total.js'),
      ),
      scene(
        's3',
        'under-the-hood',
        [{ text: 'The page divides the cents by one hundred.', evidence: ['B.F1.H1'] }],
        code('storefront/src/total.js'),
      ),
      scene('s4', 'conclusion', [{ text: 'Both changes are needed together.', evidence: ['A.F1', 'B.F1'] }], {
        type: 'summary',
        points: [{ text: 'Merge both changes together.', beat: 0 }],
        closing: null,
      }),
    ],
    reviewChecklist: [],
    uncertainties: [],
  };
}

describe('analyze with two sources', () => {
  const analyse = (sources: unknown[], extra: object = {}) =>
    prepareAuthoring({
      source: api,
      sources: sources as never,
      config: config(),
      outDir: join(home, 'out'),
      ...extra,
    });

  it('writes an analysis and an evidence pack with letters and folders', async () => {
    const result = await analyse(both());
    const analysis = JSON.parse(await readFile(result.files.analysis, 'utf8'));
    expect(analysis.files.map((f: { fileId: string }) => f.fileId)).toEqual(['A.F1', 'B.F1']);
    const evidence = await readFile(result.files.evidence, 'utf8');
    expect(evidence).toContain('Source A: orders-api');
    expect(evidence).toContain('A.F1.H1 orders-api/src/total.js');
    expect(evidence).toContain('B.F1.H1 storefront/src/total.js');
  });

  it('gives the same files whatever the order of the sources', async () => {
    const one = await analyse(both());
    const two = await analyse(both().reverse(), { outDir: join(home, 'out2') });
    for (const file of ['analysis', 'evidence'] as const) {
      expect(await readFile(two.files[file], 'utf8')).toBe(await readFile(one.files[file], 'utf8'));
    }
  });

  it('repeats every --source in the commands it shows, and shows no source argument', async () => {
    const result = await analyse(both(), {
      followUp: { source: '', args: ['--source', `${api}:main..fix/total`, '--source', web] },
    });
    const guide = await readFile(result.files.guide, 'utf8');
    expect(guide).toContain(
      `mergestory generate --source ${api}:main..fix/total --source ${web} --storyboard`,
    );
    expect(guide).toMatch(/mergestory validate \S+ --source /);
    expect(guide).not.toMatch(/mergestory (?:validate|generate) '' /);
    expect(guide).toContain('## Several sources');
  });

  it('leaves the paragraph about several sources out of the guide for one source', async () => {
    const result = await prepareAuthoring({
      source: api,
      ...range,
      config: config(),
      outDir: join(home, 'o1'),
    });
    expect(await readFile(result.files.guide, 'utf8')).not.toContain('Several sources');
  });

  it('with one source is exactly the analysis of the plain form', async () => {
    const plain = await prepareAuthoring({
      source: api,
      ...range,
      config: config(),
      outDir: join(home, 'plain'),
    });
    const listed = await analyse([{ kind: 'local', repoPath: api, ...range }], {
      outDir: join(home, 'listed'),
    });
    for (const file of ['analysis', 'evidence', 'guide'] as const) {
      expect(await readFile(listed.files[file], 'utf8'), file).toBe(
        await readFile(plain.files[file], 'utf8'),
      );
    }
  });

  it('names the source that has no changes', async () => {
    await expect(
      analyse([
        { kind: 'local', repoPath: api, ...range },
        { kind: 'local', repoPath: web, base: 'main', head: 'main' },
      ]),
    ).rejects.toMatchObject({ code: 'SOURCE_INVALID', message: expect.stringContaining('storefront') });
  });

  it('names the source that loads with no files, as a pull request with no files does', async () => {
    const real = (await vi.importActual<typeof import('../sources/index.ts')>('../sources/index.ts'))
      .createSourceProvider;
    vi.mocked(createSourceProvider)
      .mockImplementationOnce(real)
      .mockImplementationOnce((input) => {
        const provider = real(input);
        const load = provider.load.bind(provider);
        provider.load = async (i, c) => {
          const loaded = await load(i, c);
          return { ...loaded, changeSet: { ...loaded.changeSet, files: [] } };
        };
        return provider;
      });
    await expect(analyse(both())).rejects.toMatchObject({
      code: 'SOURCE_INVALID',
      message: expect.stringMatching(/^There are no changes to explain in local repository storefront /),
    });
  });

  it('refuses the same source twice, too many sources and refs next to sources', async () => {
    const same = both()[0];
    await expect(analyse([same, same])).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      analyse([...both(), { ...same, head: 'main' }, { ...same, base: 'x' }, { ...same, base: 'y' }]),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(analyse(both(), { base: 'main' })).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('validate and generate with two sources', () => {
  it('accepts a storyboard with ids and paths of both repositories', async () => {
    const result = await checkStoryboard({
      source: api,
      sources: both(),
      storyboard: storyboard(),
      config: config(),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
  });

  it('makes one video that shows the code of each repository, and lists the ids of both', async () => {
    const result = (await generate({
      source: api,
      sources: both(),
      storyboard: storyboard(),
      config: config(),
    })) as GenerateResult;
    expect(result.ok).toBe(true);
    expect(result.evidenceUsed).toEqual(expect.arrayContaining(['A.F1.H1', 'B.F1.H1']));
    // Both repositories have src/total.js: each scene shows its own file.
    const shown = (plans[0]?.scenes ?? []).flatMap((scene) =>
      scene.visual.type === 'code'
        ? [
            {
              path: scene.visual.code.path,
              text: scene.visual.code.lines.map((l) => l.tokens.map((t) => t.t).join('')).join('\n'),
            },
          ]
        : [],
    );
    expect(shown.map((c) => c.path)).toEqual(['orders-api/src/total.js', 'storefront/src/total.js']);
    expect(shown[0]?.text).toContain('priceCents');
    expect(shown[0]?.text).not.toContain('order.total.cents');
    expect(shown[1]?.text).toContain('order.total.cents');
    expect(shown[1]?.text).not.toContain('priceCents');
  });

  it('stores no single commit for the change: publish-input.json and the watch page have none', async () => {
    const result = (await generate({
      source: api,
      sources: both(),
      storyboard: storyboard(),
      config: config(),
    })) as GenerateResult;
    const stored = JSON.parse(await readFile(join(result.runDir, 'publish-input.json'), 'utf8'));
    expect(stored.headSha).toBe('');
    expect(stored.watch.headSha).toBe('');
    expect(await readFile(join(result.runDir, 'watch.html'), 'utf8')).not.toContain('<dt>Commit</dt>');
  });

  it('stops with a usage error and says what to do when there is no storyboard and no model', async () => {
    const error = await generate({ source: api, sources: both(), config: config() }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect((error as Error).message).toContain('needs a storyboard');
    expect(String((error as { hint?: string }).hint)).toMatch(/mergestory analyze.*--source.*--storyboard/);
    expect(plans).toHaveLength(0);
    // It stops before the voice is installed or the renderer is made ready.
    const voice = await generate({
      source: api,
      sources: both(),
      config: { ...config(), tts: { provider: 'auto' } },
    }).catch((e: unknown) => e);
    expect(voice).toMatchObject({ code: 'USAGE' });
    expect(vi.mocked(ensureKokoroInstalled)).not.toHaveBeenCalled();
    // One source still gets its offline storyboard.
    const one = (await generate({ source: api, ...range, config: config() })) as GenerateResult;
    expect(one.storyboardSource).toBe('heuristic');
  });

  describe('with a model that fails', () => {
    let server: Server;
    let llm: { provider: 'openai-compatible'; baseUrl: string; model: string };
    const requests: string[] = [];
    beforeAll(async () => {
      server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          requests.push(body);
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { content: 'this is not a storyboard' } }] }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      llm = {
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: 'm',
      };
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('fails with several sources and falls back to the offline storyboard with one', async () => {
      await expect(
        generate({ source: api, sources: both(), config: { ...config(), llm } }),
      ).rejects.toBeInstanceOf(Error);
      expect(plans).toHaveLength(0);
      const one = (await generate({ source: api, ...range, config: { ...config(), llm } })) as GenerateResult;
      expect(one.storyboardSource).toBe('heuristic');
    });

    it('gets the paragraph about letters and folders with several sources and not with one', async () => {
      requests.length = 0;
      await generate({ source: api, sources: both(), config: { ...config(), llm } }).catch(() => undefined);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((body) => body.includes('## Several sources'))).toBe(true);
      requests.length = 0;
      await generate({ source: api, ...range, config: { ...config(), llm } });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.some((body) => body.includes('Several sources'))).toBe(false);
    });
  });

  it('plans a run with a model for several sources, and a run with no model is refused even as a plan', async () => {
    const llm = { provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:9/v1', model: 'm' };
    const planned = await generate({
      source: api,
      sources: both(),
      dryRun: true,
      config: { ...config(), llm },
    });
    expect(planned).toMatchObject({ ok: true, dryRun: true });
    await expect(
      generate({ source: api, sources: both(), dryRun: true, config: config() }),
    ).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('says which ids with a letter exist when an id has none', async () => {
    const bad = storyboard() as unknown as { scenes: { narration: { evidence: string[] }[] }[] };
    bad.scenes[1]!.narration[0]!.evidence = ['F1.H1'];
    const result = await checkStoryboard({ source: api, sources: both(), storyboard: bad, config: config() });
    expect(result.fixes.join('\n')).toContain('did you mean A.F1.H1 or B.F1.H1?');
  });
});

import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import { languageForPath } from '../core/languages.ts';
import type { Analysis, RepoReader } from '../core/types.ts';
import { buildChange, type ChangeOptions, emptyInputs, type FixtureFile } from '../testing/change.ts';
import { testContext } from '../testing/context.ts';
import { analyze } from './analyze.ts';
import { buildEvidencePack, targetDuration } from './index.ts';

async function run(
  files: FixtureFile[],
  options: ChangeOptions = {},
  inputs = emptyInputs(),
  config: ConfigInput = {},
) {
  const ctx = testContext({ config }).ctx;
  const built = buildChange(files, { excludePaths: ctx.config.privacy.excludePaths, ...options });
  const analysis = await analyze(built.changeSet, built.reader, inputs, ctx);
  return { ...built, analysis };
}

const lines = (n: number, prefix = 'const v') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i};`).join('\n') + '\n';

describe('analyze: sizing and pacing', () => {
  const table: [number, string, number][] = [
    [20, 'xs', 45],
    [21, 's', 70],
    [120, 's', 70],
    [121, 'm', 100],
    [400, 'm', 100],
    [401, 'l', 130],
    [1200, 'l', 130],
    [1201, 'xl', 160],
  ];
  it.each(table)('%i meaningful lines -> size %s, %i s', async (count, size, seconds) => {
    const { analysis } = await run([{ path: 'src/a/x.ts', base: null, head: lines(count) }]);
    expect(analysis.meaningfulLines).toBe(count);
    expect(analysis.size).toBe(size);
    expect(analysis.suggestedDurationSec).toBe(seconds);
  });

  it('leaves trivial files out of the size', async () => {
    const { analysis } = await run([
      { path: 'src/a/x.ts', base: null, head: lines(10) },
      { path: 'package-lock.json', base: '{}\n', head: lines(3000, '"k') },
      { path: 'dist/out.js', base: null, head: lines(500) },
    ]);
    expect(analysis.meaningfulLines).toBe(10);
    expect(analysis.size).toBe('xs');
  });

  it('adds ten seconds when three or more components carry meaningful changes', async () => {
    const { analysis } = await run([
      { path: 'src/a/x.ts', base: null, head: lines(5) },
      { path: 'src/b/x.ts', base: null, head: lines(5) },
      { path: 'src/c/x.ts', base: null, head: lines(5) },
    ]);
    expect(analysis.suggestedDurationSec).toBe(55);
    const docsOnly = await run([
      { path: 'src/a/x.ts', base: null, head: lines(5) },
      { path: 'docs/a.md', base: null, head: 'a\n' },
      { path: 'docs/b/b.md', base: null, head: 'b\n' },
    ]);
    expect(docsOnly.analysis.suggestedDurationSec).toBe(45);
  });
});

describe('analyze: determinism', () => {
  const files: FixtureFile[] = [
    {
      path: 'packages/core/src/retry.ts',
      base: 'export function a() {\n  return 1;\n}\n',
      head: 'export function a() {\n  return eval("1");\n}\nexport function b() {}\n',
    },
    {
      path: 'packages/web/src/page.tsx',
      base: null,
      head: "import { a } from '../../core/src/retry.ts';\nexport const Page = () => <div>{a()}</div>;\n",
    },
    { path: 'package.json', base: '{"dependencies":{}}\n', head: '{"dependencies":{"zod":"^4"}}\n' },
  ];

  it('produces identical analyses and evidence ids for identical input', async () => {
    const first = await run(files);
    const second = await run(files);
    expect(JSON.stringify(second.analysis)).toBe(JSON.stringify(first.analysis));
    const ids = first.analysis.evidence.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('analyze: evidence index', () => {
  it('indexes every id the analysis uses, with labels and links', async () => {
    const { analysis } = await run(
      [
        {
          path: 'src/retry/index.ts',
          base: 'export function a() {\n  return 1;\n}\n',
          head: 'export function a() {\n  return 2;\n}\nexport function b() {}\n',
        },
        { path: 'package.json', base: '{"dependencies":{}}\n', head: '{"dependencies":{"zod":"^4"}}\n' },
      ],
      { commits: [{ subject: 'Add retry' }], issues: [{ title: 'Retries are missing' }] },
      emptyInputs({
        task: 'Add retry',
        notes: 'Chose exponential backoff.',
        tests: [{ id: 'T1', command: 'npm test', passed: true, summary: '12 passed', source: 'agent' }],
        screenshots: [
          { id: 'SS1', path: '/tmp/a.png', caption: 'Settings page after the change', moment: 'after' },
        ],
      }),
    );
    const byId = new Map(analysis.evidence.map((e) => [e.id, e]));
    for (const id of [
      'PR',
      'TASK',
      'NOTES',
      'T1',
      'IS1',
      'CM1',
      'F1',
      'F1.H1',
      'F2',
      'S1',
      'M1',
      'D1',
      'SS1',
      'REPO',
    ]) {
      expect(byId.has(id), id).toBe(true);
    }
    expect(byId.get('PR')).toMatchObject({
      kind: 'pr',
      label: 'PR description',
      url: 'https://github.com/example/weather/pull/42',
    });
    expect(byId.get('CM1')?.label).toBe('Commit 1111111: Add retry');
    expect(byId.get('IS1')).toMatchObject({
      kind: 'issue',
      url: 'https://github.com/example/weather/issues/10',
    });
    expect(byId.get('F1.H1')).toMatchObject({
      kind: 'hunk',
      label: 'src/retry/index.ts:1-4',
      ref: { path: 'src/retry/index.ts', side: 'head', startLine: 1, endLine: 4 },
    });
    expect(byId.get('F1.H1')?.url).toBe(
      'https://github.com/example/weather/blob/f6e5d4c3b2a1908172635445362718091a2b3c4d/src/retry/index.ts#L1-L4',
    );
    expect(byId.get('SS1')?.label).toBe('Settings page after the change');
    for (const r of analysis.risks) expect(byId.has(r.id)).toBe(true);
    for (const r of analysis.risks)
      for (const e of r.evidence) expect(byId.has(e), `${r.id} cites ${e}`).toBe(true);
    for (const m of analysis.components) expect(byId.has(m.id)).toBe(true);
    for (const h of analysis.keyHunks) expect(byId.has(h.id)).toBe(true);
  });

  it('links removed code to the base commit and has no links for local repositories', async () => {
    const { analysis } = await run([{ path: 'src/a.ts', base: 'a\nb\nc\n', head: null }]);
    const file = analysis.evidence.find((e) => e.id === 'F1')!;
    expect(file.url).toContain('/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/src/a.ts');
    const local = await run([{ path: 'src/a.ts', base: 'a\n', head: 'b\n' }], { webUrl: null, pr: null });
    expect(local.analysis.evidence.every((e) => e.url === null)).toBe(true);
    expect(local.analysis.evidence.some((e) => e.id === 'PR')).toBe(false);
  });

  it('gives sensitive files a file item but no hunk items, and never reads them', async () => {
    const { analysis, reads } = await run(
      [
        { path: '.env', base: null, head: 'TOKEN=abc\n', sensitive: true },
        { path: 'deploy/id_rsa', base: null, head: 'KEY\n' },
        { path: 'secrets/keys.txt', base: null, head: 'k\n' },
        { path: 'src/a.ts', base: null, head: 'export const a = 1;\n' },
      ],
      {},
      emptyInputs(),
      { privacy: { excludePaths: ['secrets/**'] } },
    );
    const ids = analysis.evidence.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['F1', 'F2', 'F3', 'F4', 'F4.H1']));
    expect(ids).not.toContain('F1.H1');
    expect(ids).not.toContain('F2.H1');
    expect(ids).not.toContain('F3.H1');
    expect([...reads.keys()].some((k) => /\.env|id_rsa|secrets\//.test(k))).toBe(false);
    expect(analysis.keyHunks.map((h) => h.fileId)).toEqual(['F4']);
    expect(analysis.files.filter((f) => !f.trivial).map((f) => f.importance)[0]).toBe(0.1);
    expect(analysis.files.map((f) => f.hidden)).toEqual([true, true, true, false]);
  });

  it('still hides built-in sensitive files that a hand-built change set did not mark', async () => {
    // A library caller can build the change set itself and leave every flag false.
    const { analysis, reads } = await run([
      { path: '.env', base: null, head: 'TOKEN=abc\n', sensitive: false },
      { path: 'deploy/id_rsa', base: null, head: 'KEY\n', sensitive: false },
      { path: 'src/a.ts', base: null, head: 'export const a = 1;\n', sensitive: false },
    ]);
    const ids = analysis.evidence.map((e) => e.id);
    expect(ids).not.toContain('F1.H1');
    expect(ids).not.toContain('F2.H1');
    expect(ids).toContain('F3.H1');
    expect([...reads.keys()].some((k) => /\.env|id_rsa/.test(k))).toBe(false);
    expect(analysis.files.map((f) => f.hidden)).toEqual([true, true, false]);
  });
});

describe('analyze: excluded paths', () => {
  it('ignores case and also protects files renamed away from an excluded path', async () => {
    const { analysis, reads } = await run(
      [
        { path: 'Secrets/Keys.txt', base: null, head: 'k\n' },
        {
          path: 'src/keys.ts',
          oldPath: 'secrets/old-keys.ts',
          status: 'renamed',
          base: 'export const a = 1;\n',
          head: 'export const a = 2;\n',
        },
        { path: 'src/ok.ts', base: null, head: 'export const b = 1;\n' },
      ],
      {},
      emptyInputs(),
      { privacy: { excludePaths: ['secrets/'] } },
    );
    const ids = analysis.evidence.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['F1', 'F2', 'F3', 'F3.H1']));
    expect(ids).not.toContain('F1.H1');
    expect(ids).not.toContain('F2.H1');
    expect([...reads.keys()].some((k) => /secrets/i.test(k))).toBe(false);
    expect(analysis.symbols.map((s) => s.name)).toEqual(['b']);
  });
});

describe('analyze: components, relationships and signals', () => {
  it('draws component edges from imports and test edges from test imports', async () => {
    const { analysis } = await run([
      {
        path: 'src/http/client.ts',
        base: null,
        head: "import { retry } from '../retry/index.ts';\nexport const get = () => retry(() => 1);\n",
      },
      { path: 'src/retry/index.ts', base: null, head: 'export const retry = (f: () => number) => f();\n' },
      {
        path: 'tests/retry.test.ts',
        base: null,
        head: "import { retry } from '../src/retry/index.ts';\nimport { it } from 'vitest';\nit('x', () => retry(() => 1));\n",
      },
      { path: 'tests/other.test.ts', base: null, head: "import { get } from '../src/http/client';\n" },
    ]);
    const name = (id: string) => analysis.components.find((m) => m.id === id)?.name;
    const edges = analysis.relationships
      .map((r) => `${name(r.from)} ${r.kind} ${name(r.to)} via ${r.evidence}`)
      .sort();
    expect(edges).toEqual([
      'http imports retry via F1',
      'tests tests http via F4',
      'tests tests retry via F3',
    ]);
  });

  it('resolves Python and Go imports', async () => {
    const py = await run([
      {
        path: 'app/api/views.py',
        base: null,
        head: 'from app.services import forecast\nfrom ..models import user\n',
      },
      { path: 'app/services/forecast.py', base: null, head: 'x = 1\n' },
      { path: 'app/models/user.py', base: null, head: 'y = 1\n' },
    ]);
    const n = (id: string) => py.analysis.components.find((m) => m.id === id)?.name;
    expect(py.analysis.relationships.map((r) => `${n(r.from)}>${n(r.to)}`).sort()).toEqual([
      'api>models',
      'api>services',
    ]);
    const go = await run(
      [
        {
          path: 'internal/server/server.go',
          base: null,
          head: 'package server\n\nimport (\n\t"fmt"\n\t"example.com/weather/internal/store"\n)\n',
        },
        { path: 'internal/store/store.go', base: null, head: 'package store\n' },
      ],
      { unchanged: { 'go.mod': 'module example.com/weather\n\ngo 1.22\n' } },
    );
    const g = (id: string) => go.analysis.components.find((m) => m.id === id)?.name;
    expect(go.analysis.relationships.map((r) => `${g(r.from)}>${g(r.to)}`)).toEqual(['server>store']);
  });

  it('reports architecture signals as facts from the diff', async () => {
    const { analysis } = await run([
      {
        path: 'packages/forecast/src/index.ts',
        base: null,
        head: "import express from 'express';\nconst app = express();\napp.get('/cities', (req, res) => res.json([]));\nexport const key = process.env.WEATHER_KEY;\n",
      },
      { path: 'packages/cli/src/main.ts', base: null, head: "program.command('serve').action(run);\n" },
      { path: 'db/migrations/0001_init.sql', base: null, head: 'CREATE TABLE cities (id int);\n' },
      { path: 'config/app.yaml', base: null, head: 'port: 1\n' },
      { path: 'packages/old/src/a.ts', base: 'a\n', head: null },
      { path: 'package.json', base: '{"devDependencies":{}}\n', head: '{"devDependencies":{"tsx":"^4"}}\n' },
      { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed', base: 'x\n', head: 'x\n' },
    ]);
    const text = analysis.architectureSignals.join('\n');
    expect(text).toContain('New package `packages/forecast`');
    expect(text).toContain('Deleted package `packages/old`');
    expect(text).toContain('New dependency tsx (npm, dev)');
    expect(text).toContain('New HTTP route GET /cities');
    expect(text).toContain('New CLI command `serve`');
    expect(text).toContain('New environment variable WEATHER_KEY');
    expect(text).toContain('New migration db/migrations/0001_init.sql');
    expect(text).toContain('New config file config/app.yaml');
    expect(text).toContain('Renamed src/old-name.ts to src/new-name.ts');
  });

  it('caps the renames at three and counts the rest', async () => {
    const { analysis } = await run(
      ['a', 'b', 'c', 'd', 'e'].map((n) => ({
        path: `src/new-${n}.ts`,
        oldPath: `src/old-${n}.ts`,
        status: 'renamed' as const,
        base: `${n}\n`,
        head: `${n}\n`,
      })),
    );
    const renames = analysis.architectureSignals.filter((s) => /renames?$|^Renamed/.test(s));
    expect(renames).toEqual([
      'Renamed src/old-a.ts to src/new-a.ts',
      'Renamed src/old-b.ts to src/new-b.ts',
      'Renamed src/old-c.ts to src/new-c.ts',
      '2 more renames',
    ]);
  });

  it('lists languages and test file changes', async () => {
    const { analysis } = await run([
      { path: 'src/a.ts', base: null, head: 'a\n', language: 'typescript' },
      { path: 'src/b.ts', base: null, head: 'b\n', language: 'typescript' },
      { path: 'tools/c.py', base: null, head: 'c\n', language: 'python' },
      { path: 'src/ui.tsx', base: null, head: 'u\n', language: 'tsx' },
      { path: 'README.md', base: null, head: 'r\n', language: 'markdown' },
      { path: 'src/a.test.ts', base: null, head: 't\n', language: 'typescript' },
      { path: 'src/b.test.ts', base: 'a\n', head: 'b\n', language: 'typescript' },
      { path: 'src/c.test.ts', base: 'a\n', head: null, language: 'typescript' },
    ]);
    expect(analysis.languages).toEqual([
      { language: 'typescript', files: 6 },
      { language: 'python', files: 1 },
    ]);
    expect(analysis.tests).toEqual({
      added: ['src/a.test.ts'],
      modified: ['src/b.test.ts'],
      removed: ['src/c.test.ts'],
    });
  });

  it('counts the languages that the sources name, and leaves out build, data and prose files', async () => {
    const paths = [
      'src/a.ts',
      'src/b.go',
      'Dockerfile',
      'docker/Dockerfile.dev',
      'Makefile',
      'rules.mk',
      'config/app.yaml',
      'data/seed.json',
      'notes.md',
    ];
    const { analysis } = await run(
      paths.map((path) => ({ path, base: null, head: 'x\n', language: languageForPath(path) })),
    );
    expect(analysis.languages).toEqual([
      { language: 'go', files: 1 },
      { language: 'typescript', files: 1 },
    ]);
  });

  it('does not guess the language of a file whose language is not known', async () => {
    const { analysis } = await run([
      { path: 'src/a.ts', base: null, head: 'a\n', language: null },
      { path: 'src/b.py', base: null, head: 'b\n' },
    ]);
    expect(analysis.languages).toEqual([]);
  });
});

describe('analyze: key hunks', () => {
  it('keeps at most 12 hunks ordered by score and skips trivial files', async () => {
    const files: FixtureFile[] = Array.from({ length: 16 }, (_, i) => ({
      path: `src/m${i}/x.ts`,
      base: 'a\n',
      head: `a\n${lines(i + 1)}`,
    }));
    files.push({ path: 'package-lock.json', base: '{}\n', head: lines(400) });
    const { analysis } = await run(files);
    expect(analysis.keyHunks.length).toBe(12);
    const scores = analysis.keyHunks.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(analysis.keyHunks.some((h) => h.path === 'package-lock.json')).toBe(false);
    expect(analysis.keyHunks[0]?.path).toBe('src/m15/x.ts');
  });

  it('points a hunk that only deletes at the base side', async () => {
    const { analysis } = await run([
      { path: 'src/a.ts', base: 'a\nb\nc\nd\ne\nf\ng\nh\n', head: 'a\nb\nc\ne\nf\ng\nh\n' },
    ]);
    expect(analysis.keyHunks[0]).toMatchObject({ side: 'base', startLine: 1, endLine: 7 });
  });

  it('gives a flagged hunk a higher score than an unflagged hunk of the same size', async () => {
    const { analysis } = await run([
      { path: 'src/a.ts', base: 'x\n', head: 'x\nconst v = eval(input);\n' },
      { path: 'src/b.ts', base: 'x\n', head: 'x\nconst v = Math.abs(input);\n' },
    ]);
    const [first] = analysis.keyHunks;
    expect(first?.path).toBe('src/a.ts');
    expect(first?.reasons.some((r) => r.startsWith('risk R'))).toBe(true);
  });
});

describe('analyze: robustness', () => {
  it('copes with a reader that fails', async () => {
    const { changeSet } = buildChange([{ path: 'src/a.ts', base: 'a\n', head: 'b\n' }]);
    const reader: RepoReader = {
      readFile: async () => {
        throw new Error('disk on fire');
      },
    };
    const analysis = await analyze(changeSet, reader, emptyInputs(), testContext().ctx);
    expect(analysis.files).toHaveLength(1);
  });

  it('stays fast on very long lines', async () => {
    const long = 'select a from b '.repeat(20_000);
    const started = Date.now();
    const { analysis, changeSet } = await run([
      { path: 'src/min.ts', base: 'a\n', head: `a\nconst q = "${long}";\n` },
    ]);
    const pack = buildEvidencePack(changeSet, analysis, emptyInputs(), {
      maxTokens: 24_000,
      llmContext: 'full',
      targetDurationSec: 60,
      style: 'hybrid',
      language: 'en',
    });
    expect(pack.markdown.length).toBeLessThan(60_000);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('asks for independent reads together, so a slow reader costs one round trip', async () => {
    const { changeSet, reader } = buildChange([
      { path: 'src/a.ts', base: 'export const a = 1;\nexport const b = 2;\n', head: 'export const a = 3;\n' },
      {
        path: 'package.json',
        base: '{"dependencies":{}}\n',
        head: '{"dependencies":{"left-pad":"1.0.0"}}\n',
      },
    ]);
    let open = 0;
    let peak = 0;
    const slow: RepoReader = {
      readFile: async (path, side) => {
        peak = Math.max(peak, ++open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        return reader.readFile(path, side);
      },
    };
    const analysis = await analyze(changeSet, slow, emptyInputs(), testContext().ctx);
    expect(peak).toBeGreaterThanOrEqual(4);
    expect(analysis.dependencies.map((d) => d.name)).toEqual(['left-pad']);
  });

  it('stops when the run is cancelled', async () => {
    const { changeSet, reader } = buildChange([{ path: 'src/a.ts', base: 'a\n', head: 'b\n' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyze(changeSet, reader, emptyInputs(), testContext({ signal: controller.signal }).ctx),
    ).rejects.toThrow();
  });

  it('handles an empty change', async () => {
    const analysis: Analysis = (await run([])).analysis;
    expect(analysis).toMatchObject({
      size: 'xs',
      meaningfulLines: 0,
      components: [],
      risks: [],
      keyHunks: [],
    });
  });

  it('computes the target duration from the analysis and config', async () => {
    const { analysis } = await run([{ path: 'src/a.ts', base: null, head: lines(150) }]);
    expect(targetDuration(analysis, { targetDurationSec: null, maxDurationSec: 150 })).toBe(100);
    expect(targetDuration(analysis, { targetDurationSec: null, maxDurationSec: 60 })).toBe(60);
    expect(targetDuration(analysis, { targetDurationSec: 30, maxDurationSec: 150 })).toBe(30);
    expect(targetDuration(analysis, { targetDurationSec: 15, maxDurationSec: 150 })).toBe(20);
  });
});

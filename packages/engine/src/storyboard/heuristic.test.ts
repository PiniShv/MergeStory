import { describe, expect, it } from 'vitest';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { expectCleanStoryboard, focusProblems, symbolsOffScreen } from '../testing/analysed.ts';
import { APP, lines, make, narration } from '../testing/heuristic.ts';
import {
  buildFixture,
  type Fixture,
  inventoryFixture,
  retryFixture,
  tinyFixture,
} from '../testing/storyboard-fixtures.ts';
import { validateStoryboard } from './validate.ts';

describe('heuristic storyboard passes the grounding validator', () => {
  const fixtures: [string, () => Fixture][] = [
    ['a GitHub pull request in a TypeScript service', () => retryFixture()],
    ['a local change in a Python project', () => inventoryFixture()],
    ['a single-file change', () => tinyFixture()],
  ];

  it.each(fixtures)('for %s', async (_name, create) => {
    const fx = create();
    const result = await validateStoryboard(make(fx), fx.deps);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.storyboard).not.toBeNull();
    expect(result.groundedClaims).toBeGreaterThanOrEqual(6);
  });

  it.each([20, 30, 60, 90, 150, 300])('at a target of %i seconds', async (targetSec) => {
    for (const [, create] of fixtures) {
      const fx = create();
      const result = await validateStoryboard(make(fx, targetSec), fx.deps);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.fixes).toEqual([]);
    }
  });

  it('for a change with no files', async () => {
    const fx = buildFixture({ source: 'local', pr: null, files: [], components: [] });
    const storyboard = make(fx);
    expect(storyboard.scenes.length).toBeGreaterThanOrEqual(2);
    const result = await validateStoryboard(storyboard, fx.deps);
    expect(result.errors).toEqual([]);
  });

  it('for a change where every file is hidden or trivial', async () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: '.env',
          base: ['A=1'],
          head: ['A=2'],
          component: 'root',
          role: 'config',
          sensitive: true,
          language: null,
        },
        {
          path: 'yarn.lock',
          status: 'modified',
          truncated: true,
          additions: 40,
          deletions: 30,
          component: 'root',
          role: 'lockfile',
          trivial: true,
          language: null,
        },
      ],
      components: [{ key: 'root', name: 'project files', path: '.', kind: 'config' }],
    });
    const storyboard = make(fx);
    const result = await validateStoryboard(storyboard, fx.deps);
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(storyboard)).not.toContain('.env');
  });

  it('for a change that only adds tests, or only deletes a file', async () => {
    const tests = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'test/a.test.ts',
          head: ["it('works', () => {", '  run();', '});'],
          component: 'app',
          role: 'test',
        },
      ],
      components: APP,
    });
    const removal = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/old.ts', base: ['export function gone() {', '  x();', '}'], component: 'app' }],
      components: APP,
      symbols: [
        { name: 'gone', kind: 'function', change: 'removed', file: 'src/old.ts', startLine: 1, endLine: 3 },
      ],
    });
    for (const fx of [tests, removal]) {
      for (const targetSec of [20, 60, 150]) {
        expect(await expectCleanStoryboard(fx.deps, make(fx, targetSec))).toEqual([]);
      }
    }
  });

  it('with every code range inside the code shown, and only code on screen described', async () => {
    for (const [, create] of fixtures) {
      for (const targetSec of [30, 60, 150, 300]) {
        const fx = create();
        const storyboard = make(fx, targetSec);
        expect(focusProblems(storyboard)).toEqual([]);
        expect(symbolsOffScreen(storyboard, fx.analysis)).toEqual([]);
      }
    }
  });
});

describe('heuristic storyboard respects privacy settings', () => {
  it('never shows or points at a path the user excluded, and still validates', async () => {
    const fx = retryFixture({ config: { privacy: { excludePaths: ['src/http/retry*', 'docs/'] } } });
    const storyboard = make(fx, 300);
    const text = JSON.stringify(storyboard);
    expect(text).not.toContain('retry.ts');
    expect(text).not.toContain('retry.test.ts');
    expect(text).not.toContain('retry.md');
    // client.ts is the only file left, so the only code shown is code of client.ts
    const shown = storyboard.scenes.flatMap((s) => {
      const v = s.visual;
      if (v.type === 'code') return [v.ref.path];
      if (v.type === 'before-after') {
        return [v.before, v.after].flatMap((panel) => (panel.codeRef ? [panel.codeRef.path] : []));
      }
      return [];
    });
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set(['src/http/client.ts']));
    const result = await validateStoryboard(storyboard, fx.deps);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('does not quote author text that names a file the user excluded, and still quotes the rest', async () => {
    const fx = retryFixture({
      config: { privacy: { excludePaths: ['src/http/retry.ts'] } },
      pr: {
        title: 'Add retry in src/http/retry.ts',
        body: 'The client reads the RETRIES setting for its limit. See retry.ts for details.',
      },
      inputs: { task: 'x', notes: '- The helper in retry.ts is small.' },
    });
    const storyboard = make(fx, 300);
    expect(JSON.stringify(storyboard)).not.toMatch(/retry\.ts/);
    // The title named the file, so the heading comes from the commit; the description is quoted up to the sentence that names it.
    expect(storyboard.scenes[0]!.visual).toMatchObject({ heading: 'Use the retry helper in ApiClient' });
    expect(lines(storyboard.scenes[0]!)[1]).toBe(
      'The description says: The client reads the RETRIES setting for its limit.',
    );
    expect(await expectCleanStoryboard(fx.deps, storyboard)).toEqual([]);
  });

  it('does not describe or cite a symbol of a file the user excluded', () => {
    const fx = retryFixture({ config: { privacy: { excludePaths: ['src/http/retry.ts'] } } });
    const storyboard = make(fx, 300);
    const text = narration(storyboard);
    // delayFor and MAX_RETRIES appear only in the excluded file. fetchWithBackoff is also called in client.ts,
    // which is on screen, so the narration may say that client.ts calls it; it may not cite the symbol.
    expect(text).not.toMatch(/delayFor|MAX_RETRIES/);
    expect(text).not.toMatch(/\b(?:function|constant) fetchWithBackoff/);
    const cited = storyboard.scenes.flatMap((s) => s.narration.flatMap((line) => line.evidence));
    for (const name of ['fetchWithBackoff', 'delayFor', 'MAX_RETRIES']) {
      expect(cited).not.toContain(fx.id.symbol(name));
    }
  });
});

describe('heuristic storyboard is deterministic', () => {
  it('gives the same result for the same input', () => {
    const a = make(retryFixture());
    const b = make(retryFixture());
    expect(a).toEqual(b);
  });

  it('uses the configured style and language', () => {
    const fx = retryFixture({ config: { style: 'product', language: 'fr' } });
    const storyboard = make(fx);
    expect(storyboard.style).toBe('product');
    expect(storyboard.language).toBe('fr');
    expect(storyboard.uncertainties.some((u) => u.includes('English'))).toBe(true);
  });

  it('always says it was built from the diff alone', () => {
    expect(make(retryFixture()).uncertainties[0]).toContain('diff alone');
  });

  it('leaves out the word "exported" for a product audience', () => {
    const fx = retryFixture({ config: { style: 'product' } });
    expect(narration(make(fx, 300))).not.toMatch(/exported/);
    expect(narration(make(retryFixture(), 300))).toMatch(/is new and exported/);
  });
});

describe('mission scene', () => {
  it('quotes the PR title and the first sentence of the description, citing the PR', () => {
    const fx = retryFixture();
    const scene = make(fx).scenes[0]!;
    expect(scene.role).toBe('mission');
    expect(scene.visual).toMatchObject({
      type: 'title',
      kicker: 'Pull request #42',
      heading: 'Add retry with backoff to the HTTP client',
    });
    expect(scene.narration[0]!.text).toContain('"Add retry with backoff to the HTTP client"');
    expect(scene.narration[0]!.evidence).toEqual(['PR']);
    expect(scene.narration[1]!.text).toBe(
      'The description says: Requests to the weather API now retry when the server answers with a 5xx status.',
    );
  });

  it('puts the names that matter most on the title card', () => {
    const scene = make(retryFixture()).scenes[0]!;
    expect(scene.visual.type === 'title' && scene.visual.chips).toEqual([
      'fetchWithBackoff',
      'delayFor',
      'MAX_RETRIES',
    ]);
  });

  it('does not use later paragraphs, headings, comments or ticket references from the description', () => {
    const fx = retryFixture({
      pr: {
        title: 'Retry requests',
        body: '<!-- Please fill in the template -->\n## Summary\n\nFixes #123\n\nThe client retries failed requests with a growing delay. More detail follows here.\n\n## Test plan\n\nRun the unit tests and check that everything passes.',
      },
    });
    const text = narration(make(fx, 150));
    expect(text).toContain('The client retries failed requests with a growing delay.');
    expect(text).not.toContain('More detail');
    expect(text).not.toContain('Test plan');
    expect(text).not.toContain('Please fill');
    expect(text).not.toContain('#123');
    expect(text).not.toContain('Run the unit tests');
  });

  it('uses the task when there is no PR, and cites TASK', () => {
    const fx = inventoryFixture({
      inputs: { task: 'Add a bonus to every report line. Keep the old totals for exports.' },
    });
    const scene = make(fx).scenes[0]!;
    expect(scene.narration[0]!.text).toBe('The task for this change was: Add a bonus to every report line.');
    expect(scene.narration[0]!.evidence).toEqual(['TASK']);
    expect(scene.visual).toMatchObject({
      kicker: 'Local change',
      heading: 'Add a bonus to every report line.',
    });
  });

  it('quotes the second sentence of the task as well, as what the task asks for', () => {
    const fx = inventoryFixture({
      inputs: { task: 'Add a bonus to every report line. Keep the old totals for exports.' },
    });
    expect(lines(make(fx).scenes[0]!)[1]).toBe('The task then asks: Keep the old totals for exports.');
  });

  it('takes the commit subject for the heading when the task is too long for a title', () => {
    const task =
      'Forecast requests sometimes fail with 429 or 503 during traffic spikes, and callers have to retry by hand. Add automatic retries to the client.';
    const fx = inventoryFixture({ inputs: { task } });
    const storyboard = make(fx);
    expect(storyboard.scenes[0]!.visual).toMatchObject({
      heading: 'Add a bonus to reports and drop the legacy export',
    });
    expect(storyboard.title).toBe('Add a bonus to reports and drop the legacy export');
    // The narration still starts from what the task says.
    expect(lines(storyboard.scenes[0]!)[0]).toBe(
      'The task for this change was: Forecast requests sometimes fail with 429 or 503 during traffic spikes, and callers have to retry by hand.',
    );
  });

  it('falls back to the commit subject, and then to a neutral line', () => {
    const fromCommit = make(inventoryFixture()).scenes[0]!;
    expect(fromCommit.narration[0]!.text).toContain('Add a bonus to reports and drop the legacy export');
    expect(fromCommit.narration[0]!.evidence).toEqual(['CM1']);

    const bare = make(tinyFixture()).scenes[0]!;
    expect(bare.narration[0]!.text).toBe('This video walks through a local change.');
    expect(bare.narration[0]!.evidence).toEqual(['F1']);
  });

  it('never repeats a claim from the author as fact', async () => {
    const fx = retryFixture({
      pr: {
        title: 'Production-ready retry, all tests pass',
        body: 'This is 3x faster and has no breaking changes. The client retries failed requests.',
      },
    });
    const storyboard = make(fx, 150);
    const text = `${narration(storyboard)}\n${JSON.stringify(storyboard.scenes[0]!.visual)}\n${storyboard.title}\n${storyboard.summary}`;
    expect(text).not.toMatch(/production-ready|all tests pass|3x faster|no breaking/i);
    const result = await validateStoryboard(storyboard, fx.deps);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('quotes the whole title in the narration, with single quotes inside, and shortens only the heading', () => {
    const title =
      'Add a "retry" helper to the HTTP client and use it for every request that the weather API receives';
    const fx = retryFixture({ pr: { title } });
    const storyboard = make(fx);
    const heading = storyboard.scenes[0]!.visual;
    expect(heading.type === 'title' && heading.heading.length).toBeLessThanOrEqual(
      STORYBOARD_LIMITS.maxTitleLength,
    );
    const first = storyboard.scenes[0]!.narration[0]!.text;
    expect(first).toContain("Add a 'retry' helper to the HTTP client");
    expect(first.match(/"/g)).toHaveLength(2);
    expect(first).toContain('weather API');
  });

  it('never repeats a web address from the author', async () => {
    const fx = retryFixture({
      pr: {
        title: 'Retry requests, see https://phish.attacker.dev/details',
        body: 'Read www.attacker.net first. The client retries failed requests with a growing delay.',
      },
    });
    const storyboard = make(fx, 150);
    const text = `${narration(storyboard)}\n${JSON.stringify(storyboard.scenes[0]!.visual)}\n${storyboard.title}\n${storyboard.summary}`;
    expect(text).not.toMatch(/phish\.attacker|attacker\.net|https?:\/\//);
    const result = await validateStoryboard(storyboard, fx.deps);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('masks secrets and e-mail addresses that appear in author text', () => {
    const fx = retryFixture({
      pr: {
        title: 'Retry requests',
        body: 'Ask jane.doe@example.com about the retry settings in the client.',
      },
    });
    const text = narration(make(fx, 150));
    expect(text).not.toContain('jane.doe');
    expect(text).toContain('@example.com');
  });

  it('keeps the heading within the title limit', () => {
    const fx = retryFixture({
      pr: { title: `Add retry ${'with a very long explanation of the change '.repeat(4)}`.trim() },
    });
    const storyboard = make(fx);
    expect(storyboard.title.length).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxTitleLength);
    const heading = storyboard.scenes[0]!.visual;
    expect(heading.type === 'title' && heading.heading.length).toBeLessThanOrEqual(
      STORYBOARD_LIMITS.maxTitleLength,
    );
  });
});

describe('big picture scene', () => {
  it('draws an architecture diagram when two or more components matter and are connected', () => {
    const fx = retryFixture();
    const scene = make(fx).scenes[1]!;
    expect(scene.role).toBe('big-picture');
    expect(scene.visual.type).toBe('architecture');
    if (scene.visual.type !== 'architecture') return;
    expect(scene.visual.nodes.map((n) => n.label)).toEqual(['http', 'http tests', 'docs']);
    expect(scene.visual.nodes.every((n) => n.evidence.length > 0)).toBe(true);
    expect(scene.visual.edges).toEqual([
      { from: 'M2', to: 'M1', label: 'tests', status: 'unchanged', beat: expect.any(Number) },
    ]);
    expect(scene.narration[0]!.text).toBe('The change touches 7 files in 3 components.');
    expect(scene.narration[1]!.text).toContain('the http module');
  });

  it('says how the components are connected, with the right verb for one test group or many', () => {
    const scene = make(retryFixture(), 300).scenes[1]!;
    expect(scene.narration[2]!.text).toBe('The http tests import from the http module.');
    expect(scene.narration[2]!.evidence).toEqual(['F3', 'M2', 'M1']);
    const inventory = make(inventoryFixture(), 300).scenes[1]!;
    expect(inventory.narration[2]!.text).toBe('The tests import from the reports module.');
  });

  it('adds the test files and the dependencies to the diagram when there is room', () => {
    const scene = make(retryFixture(), 300).scenes[1]!;
    expect(scene.narration[3]!.text).toBe(
      'Tests were added in retry.test.ts. It updates undici from 6.0.0 to 6.1.0.',
    );
    expect(scene.narration[3]!.evidence).toEqual(['F3', 'D1']);
    // The leaner levels have no room for it.
    expect(make(retryFixture(), 40).scenes[1]!.narration.length).toBeLessThan(4);
  });

  it('leaves out components that are only trivial or hidden files', () => {
    const fx = retryFixture();
    const scene = make(fx).scenes[1]!;
    expect(scene.visual.type === 'architecture' && scene.visual.nodes.map((n) => n.label)).not.toContain(
      'project files',
    );
  });

  it('shows the file list when only one component matters', () => {
    const fx = tinyFixture();
    const scene = make(fx).scenes[1]!;
    expect(scene.visual).toEqual({ type: 'files', highlightPaths: ['src/greet.ts'], caption: null });
    expect(lines(scene)).toEqual(['The only changed file is greet.ts, with 1 line added and 1 removed.']);
  });

  it('shows the file list when several components matter but nothing connects them', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/client.ts', head: ['export const a = 1;'], component: 'src' },
        {
          path: 'README.md',
          base: ['# A'],
          head: ['# A', '', 'More.'],
          component: 'root',
          role: 'docs',
          language: 'markdown',
        },
        {
          path: 'package.json',
          base: ['{}'],
          head: ['{ }'],
          component: 'root',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: [
        { key: 'src', name: 'src', path: 'src', kind: 'module' },
        { key: 'root', name: 'Project root', path: '.', kind: 'config' },
      ],
    });
    const scene = make(fx, 150).scenes[1]!;
    expect(scene.visual.type).toBe('files');
  });

  it('shows the file list when the components that matter are not connected to each other, whatever connects the rest', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/a.ts', head: ['export const a = 1;'], component: 'a' },
        { path: 'src/b.ts', head: ['export const b = 1;'], component: 'b' },
        { path: 'src/c.ts', head: ['export const c = 1;'], component: 'c', trivial: true },
        {
          path: 'docs/c.md',
          head: ['# c'],
          component: 'd',
          role: 'docs',
          language: 'markdown',
          trivial: true,
        },
      ],
      components: [
        { key: 'a', name: 'a', path: 'src/a', kind: 'module' },
        { key: 'b', name: 'b', path: 'src/b', kind: 'module' },
        { key: 'c', name: 'c', path: 'src/c', kind: 'module' },
        { key: 'd', name: 'd', path: 'docs', kind: 'docs' },
      ],
      relationships: [{ from: 'a', to: 'c', kind: 'imports', file: 'src/a.ts' }],
    });
    // The only relationship leads to a component of trivial files, which is not drawn.
    expect(make(fx, 150).scenes[1]!.visual.type).toBe('files');
  });

  it('names the biggest files with their status and size, and highlights only the files it names', () => {
    const fx = inventoryFixture({ relationships: [] });
    const scene = make(fx, 300).scenes[1]!;
    expect(scene.visual.type).toBe('files');
    expect(lines(scene)).toEqual([
      'The largest change is in report.py, with 9 lines added and 1 removed.',
      'Next come old_export.py (deleted, 8 lines removed) and test_report.py (new, 4 lines added).',
      'Tests were added in test_report.py.',
    ]);
    expect(scene.visual.type === 'files' && scene.visual.highlightPaths).toEqual([
      'app/reports/report.py',
      'app/legacy/old_export.py',
      'tests/test_report.py',
    ]);
  });

  it('says what happened to dependencies when there is no test line to say', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/a.ts', head: ['export const a = 1;'], component: 'app' },
        {
          path: 'package.json',
          base: ['{}'],
          head: ['{ }'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'undici',
          change: 'updated',
          from: '6.0.0',
          to: '6.1.0',
          dev: false,
          file: 'package.json',
        },
      ],
    });
    const scene = make(fx, 300).scenes[1]!;
    expect(lines(scene).at(-1)).toBe('It updates undici from 6.0.0 to 6.1.0.');
    expect(scene.narration.at(-1)!.evidence).toEqual(['D1']);
  });

  it('never highlights hidden or binary files', () => {
    const fx = retryFixture();
    const files = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/a.ts', head: ['export const a = 1;'], component: 'app' },
        { path: '.env', head: ['A=1'], component: 'app', sensitive: true, language: null },
        { path: 'img/x.png', binary: true, status: 'modified', component: 'app', language: null },
      ],
      components: [{ key: 'app', name: 'app', path: '.', kind: 'module' }],
    });
    const scene = make(files).scenes[1]!;
    expect(scene.visual).toMatchObject({ type: 'files', highlightPaths: ['src/a.ts'] });
    expect(fx).toBeDefined();
  });
});

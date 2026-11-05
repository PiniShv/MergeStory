import { describe, expect, it } from 'vitest';
import { diffViewSpan } from '../core/diff-view.ts';
import {
  buildFixture,
  type Fixture,
  inventoryFixture,
  retryFixture,
} from '../testing/storyboard-fixtures.ts';
import { baseStoryboard, codes, inventoryStoryboard, type Json, run, scene } from '../testing/validate.ts';
import { validateStoryboard } from './validate.ts';

describe('a grounded storyboard', () => {
  it('passes unchanged, with no fixes and no warnings', async () => {
    const fx = retryFixture();
    const result = await run(baseStoryboard(fx), fx);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.storyboard).not.toBeNull();
    expect(result.groundedClaims).toBe(6);
    expect(result.storyboard).toEqual(baseStoryboard(fx));
  });

  it('does not change the input object', async () => {
    const fx = retryFixture();
    const input = baseStoryboard(fx);
    scene(input, 1).visual.ref.endLine = 99;
    const copy = structuredClone(input);
    await run(input, fx);
    expect(input).toEqual(copy);
  });
});

describe('schema', () => {
  it('maps schema problems to paths and returns no storyboard', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    delete scene(sb, 1).visual.ref.endLine;
    scene(sb, 0).visual.type = 'nope';
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('scenes[1].visual.ref.endLine');
    expect(paths).toContain('scenes[0].visual.type');
    expect(result.errors.every((e) => e.code === 'schema')).toBe(true);
    expect(result.errors.find((e) => e.path === 'scenes[1].visual.ref.endLine')!.message).toContain(
      'required',
    );
  });

  it('never throws, whatever it is given', async () => {
    const fx = retryFixture();
    for (const input of [null, undefined, 42, 'text', [], {}, { version: 1 }, { scenes: 'x' }]) {
      const result = await run(input, fx);
      expect(result.storyboard).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('ignores fields it does not know', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.extra = 'ignored';
    scene(sb, 0).mood = 'upbeat';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard).not.toHaveProperty('extra');
  });
});

describe('limits', () => {
  it('trims to ten scenes, keeps the last one and says what was dropped', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    const extra = (n: number): Json => ({ ...structuredClone(scene(sb, 0)), id: `x${n}` });
    sb.scenes = [...sb.scenes.slice(0, 2), ...Array.from({ length: 10 }, (_, i) => extra(i)), sb.scenes[2]];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes).toHaveLength(10);
    expect(result.storyboard!.scenes.at(-1)!.id).toBe('s3');
    expect(result.fixes.some((f) => f.startsWith('scenes: dropped 3 scenes'))).toBe(true);
  });

  it('needs at least two scenes', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.scenes = [sb.scenes[0]];
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(codes(result.errors)).toContain('too-few-scenes');
  });

  it('renames duplicate scene ids', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).id = 's1';
    scene(sb, 2).id = 's1';
    const result = await run(sb, fx);
    expect(result.storyboard!.scenes.map((s) => s.id)).toEqual(['s1', 's1-2', 's1-3']);
    expect(result.fixes.filter((f) => f.includes('duplicate id'))).toHaveLength(2);
  });

  it('shortens an overlong title and a scene title', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.title = 'A very long title that keeps going well past the sixty character limit for titles';
    scene(sb, 0).title = 'Another chapter title that is also much too long to fit in the chapter list';
    const result = await run(sb, fx);
    expect(result.storyboard!.title.length).toBeLessThanOrEqual(60);
    expect(result.storyboard!.title.endsWith('…')).toBe(true);
    expect(result.storyboard!.scenes[0]!.title.length).toBeLessThanOrEqual(60);
    expect(result.fixes.some((f) => f.startsWith('title:'))).toBe(true);
  });

  it('keeps at most six narration lines per scene', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration = Array.from({ length: 8 }, (_, i) => ({
      text: `Point number ${i} is here.`,
      evidence: [fx.id.hunk('src/http/retry.ts')],
    }));
    const result = await run(sb, fx);
    expect(result.storyboard!.scenes[2]!.narration).toHaveLength(6);
    expect(result.fixes.some((f) => f.includes('kept the first 6 of 8 lines'))).toBe(true);
  });

  it('drops trailing sentences from a line that is over forty words', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    scene(sb, 2).narration[0].text = `${long}. Another sentence follows with ${long}.`;
    const result = await run(sb, fx);
    const text = result.storyboard!.scenes[2]!.narration[0]!.text;
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(result.fixes.some((f) => f.includes('stay within 40 words'))).toBe(true);
  });

  it('trims architecture nodes to nine and drops the edges that lost an end', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    const nodes = Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`,
      label: `Part ${i}`,
      detail: null,
      kind: 'module',
      status: 'unchanged',
      beat: 0,
      evidence: [],
    }));
    scene(sb, 2).visual = {
      type: 'architecture',
      direction: 'LR',
      nodes,
      edges: [
        { from: 'n0', to: 'n1', label: null, status: 'unchanged', beat: 0 },
        { from: 'n1', to: 'n10', label: null, status: 'unchanged', beat: 0 },
      ],
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'architecture' && visual.nodes).toHaveLength(9);
    expect(visual.type === 'architecture' && visual.edges).toHaveLength(1);
  });
});

describe('evidence', () => {
  it('removes unknown ids and keeps the line when a valid one is left', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).narration[0].evidence = ['PR', 'F99', 'nonsense'];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[0]!.narration[0]!.evidence).toEqual(['PR']);
    expect(result.fixes.some((f) => f.includes('unknown evidence ids "F99", "nonsense"'))).toBe(true);
  });

  it('drops a line that cites nothing valid, when the scene keeps another line', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration[0].evidence = ['F99'];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(codes(result.warnings)).toContain('uncited-line');
    expect(result.groundedClaims).toBe(5);
  });

  it('fails when no line of a scene cites valid evidence', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    for (const line of scene(sb, 2).narration) line.evidence = [];
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors.map((e) => e.path)).toContain('scenes[2].narration');
    expect(codes(result.errors)).toContain('uncited-line');
  });

  it('moves beats when a line is removed so they still point at the right line', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).narration.unshift({ text: 'An opening line without evidence.', evidence: [] });
    scene(sb, 1).visual.focus[0].beat = 1;
    scene(sb, 1).visual.focus[1].beat = 2;
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.focus.map((f) => f.beat)).toEqual([0, 1]);
  });

  it('removes unknown ids from nodes and review items, and warns about changes that cite nothing', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'architecture',
      direction: 'LR',
      nodes: [
        {
          id: 'a',
          label: 'http',
          detail: null,
          kind: 'module',
          status: 'modified',
          beat: 0,
          evidence: [fx.id.component('http'), 'M99'],
        },
        { id: 'b', label: 'reports', detail: null, kind: 'service', status: 'added', beat: 1, evidence: [] },
      ],
      edges: [{ from: 'a', to: 'b', label: 'calls', status: 'unchanged', beat: 1 }],
    };
    sb.reviewChecklist[0].evidence = [fx.id.risk(1), 'R77'];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'architecture' && visual.nodes[0]!.evidence).toEqual([fx.id.component('http')]);
    expect(result.storyboard!.reviewChecklist[0]!.evidence).toEqual([fx.id.risk(1)]);
    expect(
      result.warnings.some((w) => w.code === 'no-evidence' && w.path === 'scenes[2].visual.nodes[1]'),
    ).toBe(true);
  });
});

describe('code references', () => {
  it('rejects a path that is not part of the change, with a message an agent can act on', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref.path = 'src/foo.ts';
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors).toContainEqual({
      path: 'scenes[1].visual.ref',
      code: 'code-ref-unknown-path',
      message: 'src/foo.ts is not part of this change; use a path from the Files table',
    });
  });

  it('rejects sensitive and binary files', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref = { path: '.env', side: 'head', startLine: 1, endLine: 1 };
    sb.reviewChecklist[0].ref = { path: 'assets/logo.png', side: 'head', startLine: 1, endLine: 1 };
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(codes(result.errors)).toEqual(expect.arrayContaining(['code-ref-sensitive', 'code-ref-binary']));
  });

  it('rejects files that the user excluded in the config', async () => {
    const fx = retryFixture({ config: { privacy: { excludePaths: ['src/http/retry.*'] } } });
    const sb = baseStoryboard(fx);
    const result = await run(sb, fx);
    expect(codes(result.errors)).toContain('code-ref-sensitive');
  });

  it('clamps lines that run past the end of the file', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref.endLine = 99;
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref).toMatchObject({ startLine: 18, endLine: 29 });
    expect(result.fixes.some((f) => f.includes('clamped to lines 18-29 of 29'))).toBe(true);
  });

  it('swaps start and end when they are reversed', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    Object.assign(scene(sb, 1).visual.ref, { startLine: 29, endLine: 18 });
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref).toMatchObject({ startLine: 18, endLine: 29 });
  });

  it('shows the changed-files overview when the lines are entirely outside the file', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    Object.assign(scene(sb, 1).visual.ref, { startLine: 80, endLine: 90 });
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual).toEqual({ type: 'files', highlightPaths: ['src/http/retry.ts'], caption: null });
    expect(codes(result.warnings)).toContain('code-ref-out-of-range');
  });

  it('shows the changed-files overview when the file cannot be read', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    const failing = {
      ...fx.deps,
      reader: {
        readFile: async () => {
          throw new Error('disk error');
        },
      },
    };
    const result = await validateStoryboard(sb, failing);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[1]!.visual.type).toBe('files');
    expect(codes(result.warnings)).toContain('code-ref-unreadable');
  });

  it('shortens a long range to eighteen lines around the first focus range', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref = { path: 'src/http/retry.ts', side: 'head', startLine: 1, endLine: 29 };
    scene(sb, 1).visual.focus = [{ startLine: 25, endLine: 26, note: null, beat: 0 }];
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type).toBe('code');
    if (visual.type !== 'code') return;
    expect(visual.ref.endLine - visual.ref.startLine + 1).toBeLessThanOrEqual(18);
    expect(visual.ref.startLine).toBeLessThanOrEqual(25);
    expect(visual.ref.endLine).toBeGreaterThanOrEqual(26);
    expect(result.fixes.some((f) => f.includes('shortened to'))).toBe(true);
  });

  it('shortens a long range around the changed lines when there is no focus range', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref = { path: 'src/http/retry.ts', side: 'head', startLine: 1, endLine: 29 };
    scene(sb, 1).visual.focus = [];
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref.endLine - visual.ref.startLine + 1).toBe(18);
  });

  it('switches diff to snippet when the range misses every hunk', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual = {
      type: 'code',
      ref: { path: 'src/http/client.ts', side: 'head', startLine: 6, endLine: 8 },
      mode: 'diff',
      focus: [],
      caption: null,
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('snippet');
    expect(result.fixes.some((f) => f.includes('"diff" to "snippet"'))).toBe(true);
  });

  it('keeps diff mode when the range overlaps a hunk', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual = {
      type: 'code',
      ref: { path: 'src/http/client.ts', side: 'head', startLine: 11, endLine: 14 },
      mode: 'diff',
      focus: [],
      caption: null,
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('diff');
  });

  it('clamps focus ranges into the code shown and drops the ones outside it', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.focus = [
      { startLine: 10, endLine: 20, note: 'partly inside', beat: 0 },
      { startLine: 1, endLine: 5, note: 'outside', beat: 0 },
      { startLine: 27, endLine: 26, note: 'reversed', beat: 1 },
    ];
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.focus).toEqual([
      { startLine: 18, endLine: 20, note: 'partly inside', beat: 0 },
      { startLine: 26, endLine: 27, note: 'reversed', beat: 1 },
    ]);
  });

  it('puts a new file on its head side and a deleted file on its base side', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.ref.side = 'base';
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref.side).toBe('head');

    const inventory = inventoryFixture();
    const deleted = inventoryStoryboard(
      inventory,
      {
        type: 'code',
        ref: { path: 'app/legacy/old_export.py', side: 'head', startLine: 4, endLine: 8 },
        mode: 'diff',
        focus: [],
        caption: null,
      },
      [inventory.id.file('app/legacy/old_export.py')],
      'The legacy export is removed.',
    );
    const second = await validateStoryboard(deleted, inventory.deps);
    expect(second.errors).toEqual([]);
    const code = second.storyboard!.scenes[1]!.visual;
    expect(code.type === 'code' && code.ref.side).toBe('base');
  });

  it('reads the old version of a renamed file through its old path', async () => {
    const fx = inventoryFixture();
    const sb = inventoryStoryboard(
      fx,
      {
        type: 'code',
        ref: { path: 'app/utils/helpers.py', side: 'base', startLine: 1, endLine: 5 },
        mode: 'snippet',
        focus: [],
        caption: null,
      },
      [fx.id.file('app/utils/helpers.py')],
      'The helpers moved to a new file.',
    );
    const result = await validateStoryboard(sb, fx.deps);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref.path).toBe('app/utils/misc.py');
  });

  it('checks before-after code panels and checklist references', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'before-after',
      before: {
        label: 'Before',
        kind: 'code',
        codeRef: { path: 'src/http/client.ts', side: 'base', startLine: 10, endLine: 99 },
        bullets: [],
        terminal: [],
        screenshotId: null,
      },
      after: {
        label: 'After',
        kind: 'code',
        codeRef: { path: 'src/nope.ts', side: 'head', startLine: 1, endLine: 3 },
        bullets: [],
        terminal: [],
        screenshotId: null,
      },
      caption: null,
    };
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'scenes[2].visual.after.codeRef', code: 'code-ref-unknown-path' }),
    );
    expect(
      result.fixes.some((f) => f.includes('scenes[2].visual.before.codeRef') && f.includes('clamped')),
    ).toBe(true);
  });

  it('removes a checklist reference that cannot be read, but keeps the item', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.reviewChecklist[0].ref = { path: 'src/http/retry.ts', side: 'head', startLine: 500, endLine: 510 };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.reviewChecklist[0]!.ref).toBeNull();
    expect(codes(result.warnings)).toContain('code-ref-out-of-range');
  });
});

describe('the diff view of a code reference', () => {
  /** One function whose 14 lines are all replaced: the diff view needs a row for every old and every new line. */
  function swapFixture(): Fixture {
    const body = (tag: string): string[] => Array.from({ length: 14 }, (_, i) => `const ${tag}${i} = ${i};`);
    return buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          base: ['export function swap(): void {', ...body('old'), '}'],
          head: ['export function swap(): void {', ...body('new'), '}'],
          component: 'app',
        },
      ],
      components: [{ key: 'app', name: 'app', path: 'src', kind: 'module' }],
      symbols: [
        { name: 'swap', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 16 },
      ],
    });
  }

  function swapStoryboard(fx: Fixture, visual: Json): Json {
    return {
      version: 1,
      title: 'Swap is rewritten',
      summary: 'The function swap was rewritten.',
      style: 'technical',
      language: 'en',
      scenes: [
        {
          id: 's1',
          role: 'mission',
          title: 'What changed',
          narration: [{ text: 'The function swap was rewritten.', evidence: [fx.id.file('src/a.ts')] }],
          visual: { type: 'title', kicker: null, heading: 'Swap is rewritten', subheading: null, chips: [] },
          visualDescription: 'A title card.',
          transition: 'fade',
          targetSeconds: null,
        },
        {
          id: 's2',
          role: 'under-the-hood',
          title: 'The new body',
          narration: [
            { text: 'Every line of the body was replaced.', evidence: [fx.id.hunk('src/a.ts')] },
            { text: 'The last line closes the function.', evidence: [fx.id.hunk('src/a.ts')] },
          ],
          visual,
          visualDescription: 'The code.',
          transition: 'fade',
          targetSeconds: null,
        },
      ],
      reviewChecklist: [],
      uncertainties: [],
    };
  }

  const code = (overrides: Json): Json => ({
    type: 'code',
    ref: { path: 'src/a.ts', side: 'head', startLine: 1, endLine: 16 },
    mode: 'diff',
    focus: [],
    caption: null,
    ...overrides,
  });

  it('shows a snippet when the removed lines and the highlights do not fit in eighteen rows', async () => {
    const fx = swapFixture();
    const sb = swapStoryboard(
      fx,
      code({
        focus: [
          { startLine: 2, endLine: 3, note: 'First new lines', beat: 0 },
          { startLine: 15, endLine: 16, note: 'The end', beat: 1 },
        ],
      }),
    );
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('snippet');
    // Nothing is cut from the range, so every highlight stays on screen.
    expect(visual.type === 'code' && visual.ref).toMatchObject({ startLine: 1, endLine: 16 });
    expect(visual.type === 'code' && visual.focus).toHaveLength(2);
    expect(result.fixes.some((f) => f.includes('"diff" to "snippet"') && f.includes('30 rows'))).toBe(true);
    expect(codes(result.warnings)).toContain('diff-too-tall');
  });

  it('shortens the range around the highlights when that makes the diff view fit', async () => {
    const fx = swapFixture();
    const sb = swapStoryboard(
      fx,
      code({ focus: [{ startLine: 1, endLine: 3, note: 'The start', beat: 0 }] }),
    );
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('diff');
    if (visual.type !== 'code') return;
    expect(visual.ref.startLine).toBe(1);
    expect(visual.ref.endLine).toBeLessThan(16);
    expect(visual.focus).toEqual([{ startLine: 1, endLine: 3, note: 'The start', beat: 0 }]);
    expect(result.fixes.some((f) => f.includes('shortened the range from 1-16'))).toBe(true);
    expect(codes(result.warnings)).toContain('diff-too-tall');
  });

  it('counts the added lines when the range is at the old side', async () => {
    const fx = swapFixture();
    const sb = swapStoryboard(
      fx,
      code({
        ref: { path: 'src/a.ts', side: 'base', startLine: 1, endLine: 16 },
        focus: [{ startLine: 2, endLine: 3, note: 'Old lines', beat: 0 }],
      }),
    );
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('diff');
    expect(visual.type === 'code' && visual.ref.side).toBe('base');
    expect(visual.type === 'code' && visual.ref.endLine).toBeLessThan(16);
    expect(visual.type === 'code' && visual.focus).toHaveLength(1);
  });

  it('keeps the first changed line in view when there is no highlight', async () => {
    const fx = swapFixture();
    const result = await run(swapStoryboard(fx, code({})), fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('diff');
    expect(visual.type === 'code' && visual.ref.startLine).toBe(1);
    expect(visual.type === 'code' && visual.ref.endLine).toBeLessThan(16);
  });

  it('leaves a diff view alone when its rows fit', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual = {
      type: 'code',
      ref: { path: 'src/http/client.ts', side: 'head', startLine: 11, endLine: 14 },
      mode: 'diff',
      focus: [{ startLine: 11, endLine: 12, note: 'The new call', beat: 0 }],
      caption: null,
    };
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.mode).toBe('diff');
    expect(visual.type === 'code' && visual.ref).toMatchObject({ startLine: 11, endLine: 14 });
    expect(codes(result.warnings)).not.toContain('diff-too-tall');
  });

  it('never leaves a highlight off screen: every focus range lies inside the rows that are shown', async () => {
    const fx = swapFixture();
    for (const focus of [
      [{ startLine: 1, endLine: 1 }],
      [{ startLine: 2, endLine: 5 }],
      [{ startLine: 14, endLine: 16 }],
      [
        { startLine: 3, endLine: 4 },
        { startLine: 9, endLine: 9 },
      ],
      [],
    ]) {
      const sb = swapStoryboard(
        fx,
        code({ focus: focus.map((range) => ({ ...range, note: null, beat: 0 })) }),
      );
      const visual = (await run(sb, fx)).storyboard!.scenes[1]!.visual;
      if (visual.type !== 'code') throw new Error('expected a code visual');
      for (const range of visual.focus) {
        expect(range.startLine).toBeGreaterThanOrEqual(visual.ref.startLine);
        expect(range.endLine).toBeLessThanOrEqual(visual.ref.endLine);
      }
      if (visual.mode === 'diff') {
        const file = fx.changeSet.files[0]!;
        expect(
          diffViewSpan(file, visual.ref.side, visual.ref.startLine, visual.ref.endLine)?.length,
        ).toBeLessThanOrEqual(18);
      }
    }
  });
});

describe('beats', () => {
  it('clamps beat indexes to the narration length', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.focus[0].beat = 9;
    scene(sb, 1).visual.focus[1].beat = -3;
    scene(sb, 2).visual.points[1].beat = 5;
    const result = await run(sb, fx);
    const code = result.storyboard!.scenes[1]!.visual;
    expect(code.type === 'code' && code.focus.map((f) => f.beat)).toEqual([1, 0]);
    const summary = result.storyboard!.scenes[2]!.visual;
    expect(summary.type === 'summary' && summary.points[1]!.beat).toBe(1);
    expect(result.fixes.filter((f) => f.includes('beat index'))).toHaveLength(2);
  });
});

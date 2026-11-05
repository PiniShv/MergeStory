import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { retryFixture } from '../testing/storyboard-fixtures.ts';
import { baseStoryboard, codes, type Json, run, scene } from '../testing/validate.ts';
import { EXAMPLE_STORYBOARD } from './authoring.ts';
import { heuristicStoryboard } from './heuristic.ts';
import { validateStoryboard } from './validate.ts';

describe('names that are not in the change', () => {
  it('removes a narration sentence that names a function nobody can find', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).narration[1].text =
      'It stops after the attempt limit. It then calls retryWithJitter for the delay.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[1]!.narration[1]!.text).toBe('It stops after the attempt limit.');
    expect(result.warnings.find((w) => w.code === 'unknown-identifier')!.message).toContain(
      'retryWithJitter',
    );
  });

  it('accepts names from the diff, the symbols, the PR text and the code on screen', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).narration[1].text =
      'It reads MAX_RETRIES and calls delayFor, then sleeps. The file src/http/retry.ts holds it. The client calls ApiClient.get() with the helper.';
    const result = await run(sb, fx);
    expect(result.warnings).toEqual([]);
    expect(result.storyboard!.scenes[1]!.narration[1]!.text).toContain('MAX_RETRIES');
  });

  it('removes a sentence that names a path that does not exist', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).narration[1].text = 'It stops after the attempt limit. See src/http/backoff.ts for more.';
    const result = await run(sb, fx);
    expect(result.storyboard!.scenes[1]!.narration[1]!.text).toBe('It stops after the attempt limit.');
  });

  it('removes on-screen text that names something the change does not contain, and says so', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual.points[0].text = 'Calls retryWithJitter.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'summary' && visual.points.map((p) => p.text)).toEqual([
      'The API client now calls the retry helper.',
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'unknown-identifier', path: 'scenes[2].visual.points[0].text' }),
    );
    expect(result.fixes.some((f) => f.includes('retryWithJitter') && f.includes('removed'))).toBe(true);
  });

  it('removes an invented name from chips, notes, captions, labels and the summary', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    Object.assign(scene(sb, 0).visual, { chips: ['retryForever', 'http'], kicker: 'Uses RetryScheduler' });
    scene(sb, 1).visual.focus[0].note = 'Guarded by retryBudgetGuard()';
    scene(sb, 1).visual.caption = 'The retry_budget setting';
    scene(sb, 2).visual.points[1].text = 'Uses the new RetryScheduler class.';
    sb.summary = 'The client retries failed requests. It also adds withRetryForever.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const board = result.storyboard!;
    expect(board.scenes[0]!.visual).toMatchObject({ chips: ['http'], kicker: null });
    const code = board.scenes[1]!.visual;
    expect(code.type === 'code' && code.focus[0]).toMatchObject({ startLine: 23, note: null });
    expect(code.type === 'code' && code.caption).toBeNull();
    const summary = board.scenes[2]!.visual;
    expect(summary.type === 'summary' && summary.points).toHaveLength(1);
    expect(board.summary).toBe('The client retries failed requests.');
    expect(JSON.stringify(board)).not.toMatch(/retryForever|RetryScheduler|retryBudgetGuard|retry_budget/);
  });

  it('drops the node and the edges of an architecture label that names something invented', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual = {
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
          evidence: [fx.id.component('http')],
        },
        {
          id: 'b',
          label: 'RetryScheduler',
          detail: null,
          kind: 'module',
          status: 'added',
          beat: 1,
          evidence: [fx.id.component('tests')],
        },
      ],
      edges: [{ from: 'b', to: 'a', label: 'feeds', status: 'unchanged', beat: 1 }],
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'architecture' && visual.nodes.map((n) => n.label)).toEqual(['http']);
    expect(visual.type === 'architecture' && visual.edges).toEqual([]);
  });

  it('fails when a required heading or scene title is only an invented name, so a repair round can fix it', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).visual.heading = 'withRetryForever keeps forecasts safe';
    scene(sb, 1).title = 'Why retryForever matters';
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'scenes[0].visual.heading', code: 'unknown-identifier' }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'scenes[1].title', code: 'unknown-identifier' }),
    );
    const message = result.errors.find((e) => e.path === 'scenes[0].visual.heading')!.message;
    expect(message).toContain('withRetryForever');
    expect(message).toContain('names from the change');
  });

  it('does not fail for a visual description, which is not shown', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).visualDescription = 'A card for retryForever.';
    scene(sb, 1).visualDescription = 'All tests pass.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[0]!.visualDescription).toBe('');
  });

  describe('names that only people wrote about the change', () => {
    const sources: [string, Parameters<typeof retryFixture>[0], string][] = [
      [
        'a commit message',
        {
          commits: [
            { subject: 'Add retry helper', body: 'Next: add purgeLegacyCache() to drop old entries.' },
          ],
        },
        'CM1',
      ],
      [
        'the PR description',
        { pr: { body: 'Later we will add purgeLegacyCache() to drop old entries.' } },
        'PR',
      ],
      ['the task', { inputs: { task: 'Add purgeLegacyCache() to drop old entries.' } }, 'TASK'],
      ['the notes', { inputs: { task: 'x', notes: 'purgeLegacyCache() is planned.' } }, 'NOTES'],
      ['the README', { readme: 'Planned: purgeLegacyCache() drops old entries.' }, 'REPO'],
      [
        'a linked issue',
        { linkedIssues: [{ title: 'Add purgeLegacyCache', body: 'It should drop old entries.' }] },
        'IS1',
      ],
    ];

    it.each(sources)(
      'are removed from a line that cites only code, when %s holds the name',
      async (_name, overrides, id) => {
        const fx = retryFixture(overrides);
        const hunk = fx.id.hunk('src/http/retry.ts');
        const sb = baseStoryboard(fx);
        scene(sb, 1).narration[1] = {
          text: 'It then calls purgeLegacyCache to drop old entries.',
          evidence: [hunk],
        };
        const result = await run(sb, fx);
        expect(result.errors).toEqual([]);
        expect(result.storyboard!.scenes[1]!.narration).toHaveLength(1);
        const warning = result.warnings.find((w) => w.code === 'unknown-identifier')!;
        expect(warning.message).toContain('purgeLegacyCache');
        expect(warning.message).toContain(id);
        // The same line stays, as the words of that text, when it cites it.
        const cited = baseStoryboard(fx);
        scene(cited, 1).narration[1] = {
          text: 'It then calls purgeLegacyCache to drop old entries.',
          evidence: [hunk, id],
        };
        const again = await run(cited, fx);
        expect(again.warnings).toEqual([]);
        expect(again.storyboard!.scenes[1]!.narration).toHaveLength(2);
      },
    );

    it('count as on-screen names only when the narration of the scene cites that text', async () => {
      const fx = retryFixture({
        commits: [{ subject: 'Add retry helper', body: 'Next: add purgeLegacyCache() to drop old entries.' }],
      });
      const plain = baseStoryboard(fx);
      Object.assign(scene(plain, 0).visual, { chips: ['purgeLegacyCache', 'http'] });
      const dropped = await run(plain, fx);
      expect(dropped.storyboard!.scenes[0]!.visual).toMatchObject({ chips: ['http'] });
      const cited = baseStoryboard(fx);
      Object.assign(scene(cited, 0).visual, { chips: ['purgeLegacyCache', 'http'] });
      scene(cited, 0).narration[0].evidence = ['PR', 'CM1'];
      const kept = await run(cited, fx);
      expect(kept.storyboard!.scenes[0]!.visual).toMatchObject({ chips: ['purgeLegacyCache', 'http'] });
    });

    it('still count everywhere when the code holds them too', async () => {
      const fx = retryFixture({
        commits: [{ subject: 'Add retry helper', body: 'Rename delayFor later; fetchWithBackoff stays.' }],
      });
      const sb = baseStoryboard(fx);
      scene(sb, 1).narration[1].text = 'It calls delayFor between tries.';
      const result = await run(sb, fx);
      expect(result.warnings).toEqual([]);
    });
  });

  it('ignores ordinary words, brand names and acronyms', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).narration[0].text = 'This TypeScript change uses GitHub APIs and JSON over HTTP.';
    const result = await run(sb, fx);
    expect(result.warnings).toEqual([]);
  });
});

describe('secrets and personal data', () => {
  it('masks a secret in a caption and says so', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).visual.caption = 'Uses password = "correcthorsebattery" for the test';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.caption).not.toContain('correcthorsebattery');
    expect(visual.type === 'code' && visual.caption).toContain('••••');
    expect(result.fixes.some((f) => f.includes('masked secret-like text in 1 text field'))).toBe(true);
    expect(codes(result.warnings)).toContain('secret-masked');
  });

  it('masks a key in narration and in the summary', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    scene(sb, 2).narration[1].text = `The settings hold ${key} for now.`;
    sb.summary = `Uses key ${key}.`;
    const result = await run(sb, fx);
    const text = JSON.stringify(result.storyboard);
    expect(text).not.toContain(key);
    expect(result.fixes.some((f) => f.includes('2 text fields'))).toBe(true);
  });

  it('masks e-mail addresses by default, and leaves them when the setting is off', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.summary = 'Ask jane.doe@example.com about the retry limits.';
    const masked = await run(sb, fx);
    expect(masked.storyboard!.summary).not.toContain('jane.doe');
    expect(masked.storyboard!.summary).toContain('@example.com');
    expect(masked.fixes.some((f) => f.includes('masked e-mail addresses'))).toBe(true);

    const open = retryFixture({ config: { privacy: { maskEmails: false } } });
    const kept = await run(sb, open);
    expect(kept.storyboard!.summary).toContain('jane.doe@example.com');
  });

  it('does not touch ids, enum values or paths', async () => {
    const fx = retryFixture();
    const result = await run(baseStoryboard(fx), fx);
    const visual = result.storyboard!.scenes[1]!.visual;
    expect(visual.type === 'code' && visual.ref.path).toBe('src/http/retry.ts');
    expect(result.storyboard!.scenes[1]!.id).toBe('s2');
  });
});

describe('web addresses and hidden characters', () => {
  it('removes a sentence that contains a web address', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration[0].text =
      'The retry code is small. Read more at https://phish.attacker.dev/fix before merging.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The retry code is small.');
    expect(codes(result.warnings)).toContain('url-in-text');
  });

  it('removes a web address from on-screen text, even without a scheme', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual.points[0].text = 'Details at www.attacker.net/x.';
    scene(sb, 2).visual.points[1].text = 'The client calls the retry helper.';
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'summary' && visual.points.map((p) => p.text)).toEqual([
      'The client calls the retry helper.',
    ]);
  });

  it('allows addresses on this machine, on private networks and on example hosts', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'terminal',
      title: 'Example run',
      lines: [
        { kind: 'output', text: 'Listening on http://localhost:3000', beat: 0 },
        { kind: 'output', text: 'Proxy at http://10.0.0.5:8080/health', beat: 0 },
        { kind: 'output', text: 'Docs at https://docs.example.com/retry', beat: 1 },
      ],
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'terminal' && visual.lines).toHaveLength(3);
    expect(codes(result.warnings)).not.toContain('url-in-text');
  });

  it('strips zero-width and direction-override characters and says so', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration[0].text = 'Server\u200B errors\u202E are retried\u0000 with a growing delay.';
    sb.summary = 'The client\uFEFF retries failed requests.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe(
      'Server errors are retried with a growing delay.',
    );
    expect(result.storyboard!.summary).toBe('The client retries failed requests.');
    expect(result.fixes.some((f) => f.includes('removed hidden control characters from 2 text fields'))).toBe(
      true,
    );
  });

  it('keeps line breaks and tabs', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.summary = 'The client retries failed requests.\nIt waits between tries.';
    const result = await run(sb, fx);
    expect(result.storyboard!.summary).toContain('\n');
    expect(result.fixes).toEqual([]);
  });
});

describe('empty text', () => {
  it('rejects empty text that would show as a blank title or heading', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).visual.heading = '';
    scene(sb, 1).title = '  ';
    sb.summary = '';
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    const empty = result.errors.filter((e) => e.code === 'empty-text').map((e) => e.path);
    expect(empty).toEqual(expect.arrayContaining(['scenes[0].visual.heading', 'scenes[1].title', 'summary']));
  });

  it('accepts an empty visual description, which is not shown', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).visualDescription = '';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
  });
});

describe('language', () => {
  it('sets the language to the configured one and warns', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.language = 'fr';
    const result = await run(sb, fx);
    expect(result.storyboard!.language).toBe('en');
    expect(codes(result.warnings)).toContain('language-mismatch');
    expect(result.fixes).toContain('language: set from "fr" to "en"');
  });

  it('follows a configured language', async () => {
    const fx = retryFixture({ config: { language: 'de' } });
    const sb = baseStoryboard(fx);
    const result = await run(sb, fx);
    expect(result.storyboard!.language).toBe('de');
  });

  it('warns that claims are checked in English text only, and says nothing for English', async () => {
    const german = retryFixture({ config: { language: 'de' } });
    const warned = await run(baseStoryboard(german), german);
    expect(codes(warned.warnings)).toContain('claims-english-only');
    // The offline storyboard is English and was checked, so the warning would be wrong for it.
    const offline = await validateStoryboard(baseStoryboard(german), { ...german.deps, offline: true });
    expect(codes(offline.warnings)).not.toContain('claims-english-only');
    for (const tag of ['en', 'en-GB']) {
      const fx = retryFixture({ config: { language: tag } });
      expect(codes((await run(baseStoryboard(fx), fx)).warnings)).not.toContain('claims-english-only');
    }
  });
});

describe('review checklist', () => {
  it('keeps at most five items', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.reviewChecklist = Array.from({ length: 7 }, (_, i) => ({
      title: `Check number ${i}`,
      detail: 'Look at the retry limits.',
      severity: 'low',
      ref: null,
      evidence: [fx.id.risk(1)],
    }));
    const result = await run(sb, fx);
    expect(result.storyboard!.reviewChecklist).toHaveLength(5);
  });

  it('rejects an item that points at a file outside the change', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.reviewChecklist[0].ref = { path: 'src/other.ts', side: 'head', startLine: 1, endLine: 2 };
    const result = await run(sb, fx);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'reviewChecklist[0].ref', code: 'code-ref-unknown-path' }),
    );
  });

  it('removes a web address, a claim and an invented name from the doubts, which the page shows', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.uncertainties = [
      'It is not shown how long the delays are in production.',
      'All tests pass and CI is green, see https://reports.bad-actor.dev/summary',
      'The change is production-ready. It is not shown whether the limit is read from a file.',
      'It is not shown how retryWithJitter behaves.',
    ];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.uncertainties).toEqual([
      'It is not shown how long the delays are in production.',
      'It is not shown whether the limit is read from a file.',
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: 'uncertainties[1]', code: 'url-in-text' }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: 'uncertainties[2]', code: 'unverified-claim' }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: 'uncertainties[3]', code: 'unknown-identifier' }),
    );
  });

  it('keeps the doubts a writer lists, even when they mention tests', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    sb.uncertainties = ['It is not shown whether all tests pass in CI.'];
    const result = await run(sb, fx);
    expect(result.storyboard!.uncertainties).toEqual(['It is not shown whether all tests pass in CI.']);
  });
});

describe('length', () => {
  it('leaves the length to the pipeline, which judges it from an estimate', async () => {
    const fx = retryFixture({ config: { maxDurationSec: 20 } });
    const sb = baseStoryboard(fx);
    const filler = Array.from({ length: 35 }, (_, i) => `step${i}`).join(' ');
    for (const s of sb.scenes)
      s.narration = [1, 2, 3].map(() => ({
        text: `${filler}.`,
        evidence: [fx.id.hunk('src/http/retry.ts')],
      }));
    sb.scenes[1].visual.focus = [];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).not.toContain('over-length');
  });
});

describe('robustness', () => {
  // A seeded generator, so a failure can be repeated.
  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  const POOL: unknown[] = [
    null,
    0,
    -1,
    1e9,
    3.5,
    '',
    ' ',
    'x',
    'All tests pass.',
    'Calls retryWithJitter now.',
    'See https://phish.attacker.dev/x',
    [],
    {},
    true,
    'src/http/retry.ts',
    '.env',
    'assets/logo.png',
    'F1',
    'F99',
    'T1',
    'S1',
    'R1',
    'a\u200Bb',
    'head',
    'base',
    'diff',
    'terminal',
    'browser',
    'architecture',
    'flow',
    'files',
    'checklist',
    'bullets',
    'summary',
    'screenshot',
    'before-after',
    'code',
    ['F1', 'nope'],
    [{ text: 'x', beat: 9 }],
    'password = "correcthorsebattery"',
  ];

  function allPaths(
    node: unknown,
    prefix: (string | number)[] = [],
    out: (string | number)[][] = [],
  ): (string | number)[][] {
    out.push(prefix);
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node))
        allPaths((node as Json)[key], [...prefix, Array.isArray(node) ? Number(key) : key], out);
    }
    return out;
  }

  function mutate(base: unknown, random: () => number): unknown {
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const copy = structuredClone(base) as Json;
    for (let i = 0, n = 1 + Math.floor(random() * 3); i < n; i++) {
      const path = pick(allPaths(copy).filter((p) => p.length > 0));
      let parent: Json = copy;
      for (const key of path.slice(0, -1)) parent = parent[key];
      const last = path[path.length - 1]!;
      const roll = random();
      if (roll < 0.15) {
        if (Array.isArray(parent)) parent.splice(Number(last), 1);
        else delete parent[last];
      } else if (roll < 0.25 && Array.isArray(parent)) parent.push(structuredClone(parent[0] ?? pick(POOL)));
      else parent[last] = pick(POOL);
    }
    return copy;
  }

  it.each([
    ['the guide example', () => ({ fx: retryFixture(), base: EXAMPLE_STORYBOARD as unknown })],
    [
      'the offline storyboard',
      () => {
        const fx = retryFixture();
        return {
          fx,
          base: heuristicStoryboard(fx.changeSet, fx.analysis, fx.inputs, fx.config, 150) as unknown,
        };
      },
    ],
  ])('never throws on a damaged copy of %s, and what it accepts is stable', async (_name, create) => {
    const { fx, base } = create();
    const random = generator(20261103);
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      const result = await validateStoryboard(mutate(base, random), fx.deps);
      if (result.storyboard) {
        accepted += 1;
        expect(result.errors).toEqual([]);
        // Validating the accepted storyboard again changes nothing and finds nothing.
        const again = await validateStoryboard(result.storyboard, fx.deps);
        expect(again.errors).toEqual([]);
        expect(again.fixes).toEqual([]);
        expect(again.storyboard).toEqual(result.storyboard);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.groundedClaims).toBe(0);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});

describe('result shape', () => {
  it('returns a Storyboard that matches the schema type', async () => {
    const fx = retryFixture();
    const result = await run(baseStoryboard(fx), fx);
    const storyboard: Storyboard | null = result.storyboard;
    expect(storyboard?.version).toBe(1);
  });
});

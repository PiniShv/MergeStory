/** Checking a storyboard for a change that was joined from two repositories. */
import { describe, expect, it } from 'vitest';
import { joinSources } from '../sources/join.ts';
import { testContext } from '../testing/context.ts';
import { JOINED_INPUTS, orders, store } from '../testing/joined.ts';
import { validateStoryboard } from './validate.ts';

async function deps() {
  const joined = joinSources([await orders(), await store()]);
  return { ...joined, inputs: JOINED_INPUTS, config: testContext().ctx.config, authored: true };
}

type Json = Record<string, unknown>;

/** A storyboard that cites both repositories, shows code of both, and draws components of both. */
function storyboard(): Json {
  const scene = (id: string, role: string, narration: Json[], visual: Json): Json => ({
    id,
    role,
    title: id,
    narration,
    visual,
    visualDescription: 'A scene.',
    transition: 'fade',
    targetSeconds: null,
  });
  const code = (path: string): Json => ({
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
        [{ text: 'The total is wrong unless both pull requests are merged.', evidence: ['A.PR', 'B.PR'] }],
        {
          type: 'title',
          kicker: 'orders-api #1 + storefront #7',
          heading: 'The total in cents',
          subheading: null,
          chips: [],
        },
      ),
      scene(
        's2',
        'under-the-hood',
        [{ text: 'The service now returns cents.', evidence: ['A.S1', 'A.F1.H1'] }],
        code('orders-api/src/total.js'),
      ),
      scene(
        's3',
        'under-the-hood',
        [{ text: 'The page divides the cents by one hundred.', evidence: ['B.S1', 'B.F1.H1'] }],
        code('storefront/src/total.js'),
      ),
      scene('s4', 'conclusion', [{ text: 'Both changes are needed together.', evidence: ['A.F1', 'B.F1'] }], {
        type: 'architecture',
        direction: 'LR',
        nodes: [
          {
            id: 'api',
            label: 'orders-api',
            detail: 'service',
            kind: 'service',
            status: 'modified',
            beat: 0,
            evidence: ['A.M1'],
          },
          {
            id: 'web',
            label: 'storefront',
            detail: 'page',
            kind: 'ui',
            status: 'modified',
            beat: 0,
            evidence: ['B.M1'],
          },
        ],
        edges: [{ from: 'web', to: 'api', label: 'asks for the total', status: 'unchanged', beat: 0 }],
      }),
    ],
    reviewChecklist: [],
    uncertainties: [],
  };
}

describe('a storyboard for two sources', () => {
  it('passes with ids and paths of both, and changes nothing', async () => {
    const result = await validateStoryboard(storyboard(), await deps());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.storyboard?.scenes[1]?.visual).toMatchObject({ ref: { path: 'orders-api/src/total.js' } });
    expect(result.storyboard?.scenes[2]?.visual).toMatchObject({ ref: { path: 'storefront/src/total.js' } });
  });

  it('knows the names that only one source has', async () => {
    const sb = storyboard();
    // "page" is a name of the second source only; "cents" is in the first.
    (sb.scenes as Json[])[2] = {
      ...(sb.scenes as Json[])[2],
      narration: [{ text: 'The function page shows the total with cents.', evidence: ['B.F1.H1', 'B.F2'] }],
    };
    const result = await validateStoryboard(sb, await deps());
    expect(result.warnings.filter((w) => w.code === 'unknown-identifier')).toEqual([]);
    expect(result.fixes).toEqual([]);
  });

  it('knows the text of the pull request of the second source only where it is cited', async () => {
    const sb = storyboard();
    const lines = (cited: string[]) => [
      { text: 'The request calls the bug wrongTotalXyz.', evidence: cited },
    ];
    const d = await deps();
    d.changeSet.parts![1]!.pr!.title = 'Fix wrongTotalXyz';
    const scenes = sb.scenes as Json[];
    scenes[0] = { ...scenes[0], narration: lines(['B.PR']) };
    const cited = await validateStoryboard(sb, d);
    expect(cited.fixes).toEqual([]);
    scenes[0] = { ...scenes[0], narration: lines(['A.PR']) };
    const other = await validateStoryboard(sb, d);
    expect(other.warnings.some((w) => w.code === 'unknown-identifier')).toBe(true);
  });

  it('says which forms with a letter exist when an id has none', async () => {
    const sb = storyboard();
    const scenes = sb.scenes as Json[];
    scenes[1] = {
      ...scenes[1],
      narration: [{ text: 'The service now returns cents.', evidence: ['F1.H1', 'A.F1.H1', 'PR'] }],
    };
    const result = await validateStoryboard(sb, await deps());
    const fix = result.fixes.find((f) => f.includes('"F1.H1"'));
    expect(fix).toContain('did you mean A.F1.H1 or B.F1.H1?');
    expect(result.fixes.find((f) => f.includes('"PR"'))).toContain('did you mean A.PR or B.PR?');
    // An id that exists with no letter at all gets no hint.
    scenes[1] = {
      ...scenes[1],
      narration: [{ text: 'The service now returns cents.', evidence: ['Z9', 'A.F1.H1'] }],
    };
    const none = await validateStoryboard(sb, await deps());
    expect(none.fixes.join('\n')).not.toContain('did you mean');
  });

  it('says which forms with a folder exist when a path has none', async () => {
    const sb = storyboard();
    const scenes = sb.scenes as Json[];
    scenes[1] = {
      ...scenes[1],
      visual: {
        ...(scenes[1]?.visual as Json),
        ref: { path: 'src/total.js', side: 'head', startLine: 1, endLine: 3 },
      },
    };
    const result = await validateStoryboard(sb, await deps());
    const error = result.errors.find((e) => e.code === 'code-ref-unknown-path');
    expect(error?.message).toContain('did you mean orders-api/src/total.js or storefront/src/total.js?');
    // A path that exists in one repository only is named once.
    scenes[1] = {
      ...scenes[1],
      visual: {
        ...(scenes[1]?.visual as Json),
        ref: { path: 'src/page.ts', side: 'head', startLine: 1, endLine: 1 },
      },
    };
    const one = await validateStoryboard(sb, await deps());
    expect(one.errors.find((e) => e.code === 'code-ref-unknown-path')?.message).toContain(
      'did you mean storefront/src/page.ts?',
    );
  });

  describe('the title card', () => {
    const withKicker = (kicker: string | null, heading = 'The total in cents'): Json => {
      const sb = storyboard();
      const scenes = sb.scenes as Json[];
      scenes[0] = { ...scenes[0], visual: { ...(scenes[0]?.visual as Json), kicker, heading } };
      return sb;
    };

    it('must name every pull request: a warning, and the kicker is set to the change label', async () => {
      const result = await validateStoryboard(withKicker('Two repositories'), await deps());
      expect(result.errors).toEqual([]);
      const warning = result.warnings.filter((w) => w.code === 'title-missing-source');
      expect(warning).toHaveLength(1);
      expect(warning[0]?.path).toBe('scenes[0].visual');
      expect(warning[0]?.message).toContain('orders-api #1, storefront #7');
      expect(result.fixes).toEqual([
        'scenes[0].visual.kicker: set to "orders-api #1 + storefront #7" so that the title names every pull request',
      ]);
      expect(result.storyboard?.scenes[0]?.visual).toMatchObject({ kicker: 'orders-api #1 + storefront #7' });
    });

    it('is stable: the repaired storyboard checks clean and stays as it is', async () => {
      const first = await validateStoryboard(withKicker(null), await deps());
      const second = await validateStoryboard(first.storyboard, await deps());
      expect(second.warnings).toEqual([]);
      expect(second.fixes).toEqual([]);
      expect(second.storyboard).toEqual(first.storyboard);
    });

    it('accepts names and numbers anywhere in the texts of the card, and a number only counts whole', async () => {
      const heading = 'orders-api #1 and storefront #7 together';
      const named = await validateStoryboard(withKicker(null, heading), await deps());
      expect(named.warnings).toEqual([]);
      const d = await deps();
      d.changeSet.parts![0]!.pr!.number = 12;
      const part = await validateStoryboard(withKicker(null, 'orders-api #123 and storefront #7'), d);
      expect(part.warnings.map((w) => w.code)).toEqual(['title-missing-source']);
    });

    it('only warns when the change label is too long for the kicker', async () => {
      const d = await deps();
      d.changeSet.parts![0]!.repo.name = 'a-repository-with-a-very-long-name-indeed';
      d.changeSet.parts![1]!.repo.name = 'another-repository-with-a-long-name-too';
      const result = await validateStoryboard(withKicker('Two repositories'), d);
      expect(result.warnings.map((w) => w.code)).toEqual(['title-missing-source']);
      expect(result.fixes).toEqual([]);
    });

    it('names a local change by its branch, and the repaired title is still stable', async () => {
      const joined = joinSources([await orders({ prNumber: null }), await store()]);
      const local = { ...joined, inputs: JOINED_INPUTS, config: testContext().ctx.config, authored: true };
      const first = await validateStoryboard(withKicker(null), local);
      expect(first.storyboard?.scenes[0]?.visual).toMatchObject({
        kicker: `orders-api ${joined.changeSet.parts?.[0]?.head.ref} + storefront #7`,
      });
      const second = await validateStoryboard(first.storyboard, local);
      expect(second.fixes).toEqual([]);
      expect(second.storyboard).toEqual(first.storyboard);
    });

    it('is not asked of a change in one repository', async () => {
      const result = await validateStoryboard(withKicker('Two repositories'), {
        ...(await orders()),
        inputs: JOINED_INPUTS,
        config: testContext().ctx.config,
        authored: true,
      });
      expect(result.warnings.map((w) => w.code)).not.toContain('title-missing-source');
    });
  });

  it('does not show a file that a source refuses', async () => {
    const sb = storyboard();
    const scenes = sb.scenes as Json[];
    scenes[1] = {
      ...scenes[1],
      visual: {
        ...(scenes[1]?.visual as Json),
        ref: { path: 'orders-api/.env', side: 'head', startLine: 1, endLine: 1 },
      },
    };
    const result = await validateStoryboard(sb, await deps());
    expect(result.errors.map((e) => e.code)).toContain('code-ref-sensitive');
  });
});

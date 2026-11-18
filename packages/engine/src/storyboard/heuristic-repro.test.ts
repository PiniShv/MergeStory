import { describe, expect, it } from 'vitest';
import type { ContextInputs, ReproInput } from '../core/types.ts';
import { byRole, lines, make } from '../testing/heuristic.ts';
import { retryFixture } from '../testing/storyboard-fixtures.ts';
import { validateStoryboard } from './validate.ts';

const step = (text: string, result: ReproInput['steps'][number]['result'] = null) => ({
  text,
  screenshotId: null,
  recordingId: null,
  result,
});
const repro = (...steps: ReproInput['steps']): ReproInput => ({
  title: 'Basket count',
  environment: null,
  steps,
});
const withRepro = (value: ReproInput | null, extra: Partial<ContextInputs> = {}) =>
  retryFixture({ inputs: { repro: value, ...extra } });
const roles = (fx: ReturnType<typeof withRepro>) => make(fx).scenes.map((s) => s.role);

describe('the offline storyboard without a reproduction', () => {
  it('has no reproduction or proof scene', () => {
    expect(roles(withRepro(null))).not.toContain('reproduction');
    expect(roles(withRepro(null))).not.toContain('proof');
    // A reproduction that is not shown does not change the other scenes either.
    const plain = make(withRepro(null));
    const shown = make(withRepro(repro(step('Open it'))));
    expect(shown.scenes.filter((s) => s.role !== 'reproduction').map((s) => s.narration)).toEqual(
      plain.scenes.map((s) => s.narration),
    );
  });
});

describe('the offline storyboard with a reproduction', () => {
  const steps = [
    step('Open the basket page'),
    step('Type 2 for trail mix and 3 for oat bars'),
    step('The page says 23 items', 'bug'),
  ];

  it('puts the reproduction scene right after the mission, with one line for each step that cites it', () => {
    const storyboard = make(withRepro(repro(...steps)));
    expect(storyboard.scenes[0]?.role).toBe('mission');
    const scene = storyboard.scenes[1]!;
    expect(scene.role).toBe('reproduction');
    expect(scene.visual).toEqual({
      type: 'repro',
      steps: [
        { step: 1, beat: 0 },
        { step: 2, beat: 1 },
        { step: 3, beat: 2 },
      ],
    });
    expect(scene.narration.map((line) => line.evidence)).toEqual([['REPRO.1'], ['REPRO.2'], ['REPRO.3']]);
    expect(lines(scene)).toEqual([
      'The reproduction shows step 1: Open the basket page.',
      'The reproduction shows step 2: Type 2 for trail mix and 3 for oat bars.',
      'The reproduction shows step 3, marked as the bug: The page says 23 items.',
    ]);
    expect(byRole(storyboard, 'proof')).toEqual([]);
  });

  it('shows the first 6 steps that are not marked as fixed', () => {
    const many = Array.from({ length: 8 }, (_, i) => step(`Press button ${i + 1}`, i === 3 ? 'fixed' : null));
    const scene = byRole(make(withRepro(repro(...many))), 'reproduction')[0]!;
    expect(scene.visual).toMatchObject({ type: 'repro' });
    const shown = scene.visual.type === 'repro' ? scene.visual.steps.map((s) => s.step) : [];
    expect(shown).toEqual([1, 2, 3, 5, 6, 7]);
    expect(scene.narration).toHaveLength(6);
  });

  it('leaves out a step whose text cannot be spoken, and keeps the beats of the others in line', () => {
    const storyboard = make(
      withRepro(repro(step('Open the page'), step('Now all tests pass'), step('Click save'))),
    );
    const scene = byRole(storyboard, 'reproduction')[0]!;
    expect(scene.visual).toEqual({
      type: 'repro',
      steps: [
        { step: 1, beat: 0 },
        { step: 3, beat: 1 },
      ],
    });
    expect(lines(scene)).toEqual([
      'The reproduction shows step 1: Open the page.',
      'The reproduction shows step 3: Click save.',
    ]);
  });

  it('has no reproduction scene when every step is marked as fixed, or none can be spoken', () => {
    expect(roles(withRepro(repro(step('Open it', 'fixed'))))).not.toContain('reproduction');
    expect(roles(withRepro(repro(step('Everything is verified and bug-free'))))).not.toContain(
      'reproduction',
    );
  });

  it('cuts a long step so the line stays short enough for a caption', () => {
    const long = `Open the page and ${'then wait a little while longer '.repeat(6)}until it loads`;
    const scene = byRole(make(withRepro(repro(step(long)))), 'reproduction')[0]!;
    expect(lines(scene)[0]!.split(/\s+/).length).toBeLessThanOrEqual(40);
    expect(lines(scene)[0]).toContain('…');
  });

  it('is accepted by the checks as it is, so its lines are never fixed or dropped', async () => {
    const fx = withRepro(repro(...steps, step('Reload the page', 'fixed')), {
      tests: [{ id: 'T1', command: 'npm test', passed: true, summary: 'ok', source: 'ci', log: null }],
    });
    const result = await validateStoryboard(make(fx), { ...fx.deps, offline: true });
    expect(result.errors).toEqual([]);
    expect(result.fixes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('the proof scene of the offline storyboard', () => {
  const fixed = repro(
    step('Open the basket page'),
    step('Type 2 for trail mix and 3 for oat bars', null),
    step('The page says 23 items', 'bug'),
    step('The page says 5 items', 'fixed'),
  );

  it('comes before the review scene and shows only the steps marked as fixed', () => {
    const storyboard = make(withRepro(fixed));
    const order = storyboard.scenes.map((s) => s.role);
    expect(order.indexOf('proof')).toBe(order.indexOf('review') - 1);
    const proof = byRole(storyboard, 'proof')[0]!;
    expect(proof.visual).toEqual({ type: 'repro', steps: [{ step: 4, beat: 0 }] });
    expect(lines(proof)).toEqual(['The reproduction shows step 4, marked as fixed: The page says 5 items.']);
    expect(proof.narration[0]?.evidence).toEqual(['REPRO.4']);
    // The steps that are not marked as fixed stay in the reproduction scene.
    const reproduction = byRole(storyboard, 'reproduction')[0]!;
    expect(reproduction.visual).toMatchObject({
      type: 'repro',
      steps: [{ step: 1 }, { step: 2 }, { step: 3 }],
    });
  });

  it('ends with the test results that were reported, citing their ids', () => {
    const fx = withRepro(fixed, {
      tests: [
        { id: 'T1', command: 'npm test', passed: true, summary: '12 ok', source: 'ci', log: null },
        { id: 'T2', command: 'npm run lint', passed: true, summary: 'clean', source: 'agent', log: null },
      ],
    });
    const proof = byRole(make(fx), 'proof')[0]!;
    expect(proof.narration).toHaveLength(2);
    const last = proof.narration[1]!;
    expect(last.evidence).toEqual(['T1', 'T2']);
    expect(last.text).toContain('reported 2 runs');
    expect(proof.visual).toEqual({ type: 'repro', steps: [{ step: 4, beat: 0 }] });
  });

  it('says the reported test line once: the conclusion does not repeat it', () => {
    const fx = withRepro(fixed, {
      tests: [{ id: 'T1', command: 'npm test', passed: true, summary: 'ok', source: 'ci', log: null }],
    });
    const all = make(fx, 150).scenes.flatMap((s) => lines(s));
    expect(all.filter((text) => text.includes('reported that npm test passed'))).toHaveLength(1);
  });

  it('has no proof scene when no step is marked as fixed, even with test results', () => {
    const fx = withRepro(repro(step('Open it'), step('Look', 'bug')), {
      tests: [{ id: 'T1', command: 'npm test', passed: true, summary: 'ok', source: 'ci', log: null }],
    });
    expect(roles(fx)).not.toContain('proof');
  });
});

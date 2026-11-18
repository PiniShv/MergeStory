/**
 * The reproduction and proof scenes of the offline storyboard. The steps are the caller's words, so
 * every line says what the reproduction shows and cites the step: it is never worded as a fact that
 * the code proves.
 */
import { STORYBOARD_LIMITS as LIMITS, type Scene } from '../core/storyboard-schema.ts';
import { countWords } from '../core/text.ts';
import type { ReproStep } from '../core/types.ts';
import { type Line, safeText } from './heuristic-context.ts';
import { reportedRuns } from './heuristic-facts.ts';
import { type Build, scene } from './heuristic-shared.ts';
import { truncateText } from './text.ts';

/** How a line introduces a step, by the result the caller marked on it. */
const RESULT_WORDS: Record<NonNullable<ReproStep['result']>, string> = {
  expected: ', the expected result',
  actual: ', the actual result',
  bug: ', marked as the bug',
  fixed: ', marked as fixed',
};

interface Shown {
  line: Line;
  number: number;
}

/** The line for one step, or null when its text cannot be spoken (a claim, a web address, a hidden file name). */
function stepLine(b: Build, step: ReproStep, number: number): Shown | null {
  const { ctx } = b;
  const id = `REPRO.${number}`;
  const text = safeText(ctx, step.text);
  if (!text || !ctx.evidence.has(id)) return null;
  const lead = `The reproduction shows step ${number}${step.result ? RESULT_WORDS[step.result] : ''}: `;
  // A long step is cut so the line stays within the limit for a caption.
  const room = Math.max(1, LIMITS.maxWordsPerNarrationLine - countWords(lead));
  const spoken = countWords(text) <= room ? text : truncateText(text, 120);
  return { line: { text: `${lead}${spoken.replace(/[.!?]+$/, '')}.`, evidence: [id] }, number };
}

function reproScene(
  b: Build,
  role: 'reproduction' | 'proof',
  steps: { step: ReproStep; number: number }[],
  title: string,
  description: string,
  closing: Line | null,
): Scene | null {
  const shown = steps
    .slice(0, LIMITS.maxReproSteps)
    .map(({ step, number }) => stepLine(b, step, number))
    .filter((entry): entry is Shown => entry !== null);
  if (shown.length === 0) return null;
  const lines = [...shown.map((entry) => entry.line), ...(closing ? [closing] : [])];
  return scene(
    role,
    title,
    lines,
    { type: 'repro', steps: shown.map((entry, beat) => ({ step: entry.number, beat })) },
    description,
    'slide',
  );
}

/**
 * The reproduction scene (the steps that are not marked as fixed) and the proof scene (the steps marked
 * as fixed, then the test results that were reported). Each is null when there is nothing to show.
 */
export function reproScenes(b: Build): { reproduction: Scene | null; proof: Scene | null } {
  const { repro } = b.ctx.inputs;
  if (!repro) return { reproduction: null, proof: null };
  const numbered = repro.steps.map((step, index) => ({ step, number: index + 1 }));
  const fixed = numbered.filter(({ step }) => step.result === 'fixed');
  return {
    reproduction: reproScene(
      b,
      'reproduction',
      numbered.filter(({ step }) => step.result !== 'fixed'),
      'The reproduction',
      'The steps of the reproduction, one by one.',
      null,
    ),
    proof:
      fixed.length === 0
        ? null
        : reproScene(
            b,
            'proof',
            fixed,
            'After the fix',
            'The steps that the author marked as fixed, and the reported test results.',
            reportedRuns(b.ctx)?.line ?? null,
          ),
  };
}

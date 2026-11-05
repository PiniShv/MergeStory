/**
 * Storyboards and checks shared by the validator tests: a grounded storyboard over the retry fixture,
 * and a short way to validate one. Not part of the public API.
 */
import { validateStoryboard } from '../storyboard/validate.ts';
import type { Fixture } from './storyboard-fixtures.ts';

// Tests edit storyboards as loose JSON, so `any` is the practical type here.
// biome-ignore lint/suspicious/noExplicitAny: loose JSON in tests
export type Json = Record<string, any>;

/** A storyboard that is grounded in the retry fixture and needs no fixes. */
export function baseStoryboard(fx: Fixture): Json {
  const retry = fx.id.file('src/http/retry.ts');
  const hunk = fx.id.hunk('src/http/retry.ts');
  return {
    version: 1,
    title: 'Retry with backoff for the HTTP client',
    summary: 'The HTTP client now retries failed requests with a growing delay.',
    style: 'technical',
    language: 'en',
    scenes: [
      {
        id: 's1',
        role: 'mission',
        title: 'What changed',
        narration: [
          { text: 'This pull request adds retries to the HTTP client.', evidence: ['PR'] },
          {
            text: 'It adds a new retry module and uses it in the API client.',
            evidence: [retry, fx.id.file('src/http/client.ts')],
          },
        ],
        visual: {
          type: 'title',
          kicker: 'Pull request 42',
          heading: 'Add retry with backoff to the HTTP client',
          subheading: null,
          chips: ['http'],
        },
        visualDescription: 'A title card with the pull request name.',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's2',
        role: 'under-the-hood',
        title: 'The retry helper',
        narration: [
          {
            text: 'The function fetchWithBackoff is new.',
            evidence: [fx.id.symbol('fetchWithBackoff'), hunk],
          },
          { text: 'It stops after the attempt limit or on a response below 500.', evidence: [hunk] },
        ],
        visual: {
          type: 'code',
          ref: { path: 'src/http/retry.ts', side: 'head', startLine: 18, endLine: 29 },
          mode: 'diff',
          focus: [
            { startLine: 23, endLine: 23, note: 'Reads the attempt limit', beat: 0 },
            { startLine: 26, endLine: 27, note: 'Waits before the next try', beat: 1 },
          ],
          caption: null,
        },
        visualDescription: 'The new function with its attempt loop highlighted.',
        transition: 'slide',
        targetSeconds: null,
      },
      {
        id: 's3',
        role: 'conclusion',
        title: 'Wrap up',
        narration: [
          { text: 'Server errors are now retried with a growing delay.', evidence: [hunk] },
          { text: 'Review the retry limits first.', evidence: [fx.id.risk(1)] },
        ],
        visual: {
          type: 'summary',
          points: [
            { text: 'Server errors are retried with a growing delay.', beat: 0 },
            { text: 'The API client now calls the retry helper.', beat: 1 },
          ],
          closing: null,
        },
        visualDescription: 'A short list of what changed.',
        transition: 'fade',
        targetSeconds: null,
      },
    ],
    reviewChecklist: [
      {
        title: 'Retries on every server error',
        detail: 'fetchWithBackoff retries any response with a status of 500 or above.',
        severity: 'medium',
        ref: { path: 'src/http/retry.ts', side: 'head', startLine: 18, endLine: 29 },
        evidence: [fx.id.risk(1)],
      },
    ],
    uncertainties: [],
  };
}

/** A two-scene storyboard on the inventory fixture, with the given visual in the second scene. */
export function inventoryStoryboard(
  fx: Fixture,
  visual: Json,
  evidence: string[],
  text = 'Here is the code.',
): Json {
  return {
    version: 1,
    title: 'Report changes',
    summary: 'The report code changed.',
    style: 'technical',
    language: 'en',
    scenes: [
      {
        id: 's1',
        role: 'mission',
        title: 'What changed',
        narration: [
          { text: 'The report code was updated.', evidence: [fx.id.file('app/reports/report.py')] },
        ],
        visual: { type: 'title', kicker: null, heading: 'Report changes', subheading: null, chips: [] },
        visualDescription: 'A title card.',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's2',
        role: 'under-the-hood',
        title: 'The change',
        narration: [{ text, evidence }],
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

export function scene(sb: Json, index: number): Json {
  return sb.scenes[index];
}

export async function run(sb: unknown, fx: Fixture) {
  return validateStoryboard(sb, fx.deps);
}

export const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

/**
 * Hints about the quality of a written storyboard. They only warn: they never repair or remove
 * anything, so they live apart from the validator's repair steps.
 */
import { narrationWords, showsCode, wordBudget } from '../core/storyboard-facts.ts';
import { STORYBOARD_LIMITS as LIMITS, type Scene, type Storyboard } from '../core/storyboard-schema.ts';
import type { Run } from './run.ts';
import { splitSentences } from './text.ts';

/** The words of a narration line, for comparing lines: lower case, without punctuation. */
function lineWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

/** The names in a line: words with a digit, an underscore, a dot or a capital after the first letter. */
function lineNames(text: string): string {
  return [...new Set(text.match(/[\w.]*(?:\d|_|\w\.\w|[a-z][A-Z])[\w.]*/g) ?? [])].sort().join(' ');
}

/** Lines with fewer words than this are not compared: short lines share words by chance. */
const MIN_REPEAT_WORDS = 5;
/** Two lines that name the same things and share more than this part of their words say it twice. */
const REPEAT_OVERLAP = 0.9;

/** Warns about a narration line that says again what an earlier line said, such as a recap at the end. */
function checkRepeatedLines(storyboard: Storyboard, run: Run): void {
  const seen: { words: Set<string>; names: string; path: string }[] = [];
  for (const [si, scene] of storyboard.scenes.entries()) {
    for (const [li, line] of scene.narration.entries()) {
      const words = lineWords(line.text);
      const names = lineNames(line.text);
      const path = `scenes[${si}].narration[${li}]`;
      if (words.size < MIN_REPEAT_WORDS) continue;
      const earlier = seen.find((other) => {
        if (other.names !== names) return false;
        let shared = 0;
        for (const word of words) if (other.words.has(word)) shared += 1;
        return shared / Math.max(words.size, other.words.size) > REPEAT_OVERLAP;
      });
      if (earlier)
        run.warn(
          path,
          'repeated-line',
          `this line repeats ${earlier.path}: every line should add a new fact`,
        );
      seen.push({ words, names, path });
    }
  }
}

function checkWordBudget(storyboard: Storyboard, run: Run): void {
  const budget = wordBudget(run.targetSec);
  const words = narrationWords(storyboard);
  // Narration well over the budget makes a video that runs well past its target length.
  if (words * 100 <= budget * (100 + LIMITS.overBudgetPercent)) return;
  run.warn(
    'scenes',
    'narration-over-budget',
    `the narration has ${words} words, but the budget for a ${run.targetSec}-second video is ${budget}; cut lines or scenes until it fits`,
  );
}

/** A text made only of questions, such as "Is this safe?", tells the reviewer nothing they can check. */
function onlyQuestions(text: string): boolean {
  const sentences = splitSentences(text);
  return sentences.length > 0 && sentences.every((sentence) => sentence.endsWith('?'));
}

/** A review item needs a place to read and a fact to check there. */
function checkReviewItems(scene: Scene, p: string, run: Run): void {
  if (scene.role !== 'review' || scene.visual.type !== 'checklist') return;
  for (const [index, item] of scene.visual.items.entries()) {
    const path = `${p}.visual.items[${index}]`;
    if (!item.ref)
      run.warn(
        path,
        'review-item-no-ref',
        `item "${item.title}" has no usable ref; point it at the file and lines to read`,
      );
    if (onlyQuestions(item.detail))
      run.warn(
        `${path}.detail`,
        'review-item-question',
        'the detail is only a question; state the fact first, then what to check',
      );
  }
}

/**
 * The code view lights one focus range at a time, in beat order. Two ranges on one beat leave the
 * voice describing lines that are not lit.
 */
function checkFocusBeats(scene: Scene, p: string, run: Run): void {
  if (scene.visual.type !== 'code') return;
  const seen = new Set<number>();
  for (const [index, focus] of scene.visual.focus.entries()) {
    if (seen.has(focus.beat))
      run.warn(
        `${p}.visual.focus[${index}]`,
        'focus-same-beat',
        `another focus range is on beat ${focus.beat}, and only one range is lit at a time; give each range its own narration line`,
      );
    seen.add(focus.beat);
  }
}

/** The first under-the-hood scene carries the key change, so it shows the real code. */
function checkKeyChangeIsCode(storyboard: Storyboard, run: Run): void {
  const index = storyboard.scenes.findIndex((scene) => scene.role === 'under-the-hood');
  const visual = storyboard.scenes[index]?.visual;
  if (!visual || showsCode(visual)) return;
  run.warn(
    `scenes[${index}].visual`,
    'key-change-not-code',
    `the first under-the-hood scene shows a ${visual.type} visual; show the key change as code or as a before-after with a code panel`,
  );
}

export function checkWrittenQuality(storyboard: Storyboard, run: Run): void {
  checkKeyChangeIsCode(storyboard, run);
  // The offline storyboard is built from fixed sentences: it fits the budget as far as they allow,
  // some review signals (a lockfile, an environment file) have no lines to point at, and its code
  // scenes can light two ranges on one line.
  if (run.offline) return;
  checkRepeatedLines(storyboard, run);
  checkWordBudget(storyboard, run);
  for (const [index, scene] of storyboard.scenes.entries()) {
    checkReviewItems(scene, `scenes[${index}]`, run);
    checkFocusBeats(scene, `scenes[${index}]`, run);
  }
}

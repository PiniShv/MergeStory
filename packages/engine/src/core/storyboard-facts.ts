/**
 * Facts about a storyboard that more than one stage depends on: which visuals are simulated,
 * which elements sit on a narration beat, which evidence backs a claim, and how long speech takes.
 * They live here so the stages that validate, trim, plan and estimate agree.
 */
import { SIMULATED_VISUALS, STORYBOARD_LIMITS, type Storyboard, type Visual } from './storyboard-schema.ts';
import { countWords } from './text.ts';

/** Evidence kinds that show a change exists: a changed file, hunk or symbol. */
export const BACKING_EVIDENCE_KINDS: readonly string[] = ['file', 'hunk', 'symbol'];

/** Silence added to every estimated line, as the breath between two lines. */
const LINE_PAUSE_SEC = 0.25;

/** Visuals that show invented behaviour (labelled "simulated" in the video). */
export function isSimulated(visual: Visual): boolean {
  return (
    SIMULATED_VISUALS.includes(visual.type) ||
    (visual.type === 'before-after' &&
      (visual.before.kind === 'terminal' || visual.after.kind === 'terminal'))
  );
}

/** Elements that appear on a narration beat. Used to keep beat indexes in range. */
export function beatHolders(visual: Visual): { beat: number }[] {
  switch (visual.type) {
    case 'mission':
    case 'summary':
      return visual.points;
    case 'architecture':
      return [...visual.nodes, ...visual.edges];
    case 'flow':
      return visual.steps;
    case 'code':
      return visual.focus;
    case 'before-after':
      return [...visual.before.terminal, ...visual.after.terminal];
    case 'terminal':
      return visual.lines;
    case 'browser':
      return visual.blocks;
    case 'checklist':
    case 'bullets':
      return visual.items;
    case 'title':
    case 'files':
    case 'screenshot':
      return [];
  }
}

/** Narration lines that cite at least one evidence id. */
export function groundedLines(storyboard: Storyboard): number {
  return storyboard.scenes.reduce(
    (sum, scene) => sum + scene.narration.filter((line) => line.evidence.length > 0).length,
    0,
  );
}

/** Words in all the narration of a storyboard. */
export function narrationWords(storyboard: Storyboard): number {
  return storyboard.scenes.reduce(
    (sum, scene) => sum + scene.narration.reduce((n, line) => n + countWords(line.text), 0),
    0,
  );
}

/** Words of narration that fit a target length, at the engine's speaking rate. */
export function wordBudget(targetSec: number): number {
  return Math.round(targetSec * STORYBOARD_LIMITS.wordsPerSecond);
}

/** Estimated speaking time of a line: words at the speaking rate plus a quarter of a second. */
export function speechSeconds(text: string): number {
  return countWords(text) / STORYBOARD_LIMITS.wordsPerSecond + LINE_PAUSE_SEC;
}

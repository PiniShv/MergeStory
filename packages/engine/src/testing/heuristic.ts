/**
 * Shortcuts for the tests of the offline storyboard: building one from a fixture and reading its text.
 * Not part of the public API.
 */
import type { Scene, Storyboard } from '../core/storyboard-schema.ts';
import { countWords } from '../core/text.ts';
import { heuristicStoryboard } from '../storyboard/heuristic.ts';
import type { Fixture } from './storyboard-fixtures.ts';

export function make(fx: Fixture, targetSec = 60): Storyboard {
  return heuristicStoryboard(fx.changeSet, fx.analysis, fx.inputs, fx.config, targetSec);
}

export function words(storyboard: Storyboard): number {
  return storyboard.scenes.reduce(
    (sum, s) => sum + s.narration.reduce((n, line) => n + countWords(line.text), 0),
    0,
  );
}

export const narration = (storyboard: Storyboard): string =>
  storyboard.scenes.flatMap((s) => s.narration.map((l) => l.text)).join('\n');

export const lines = (scene: Scene): string[] => scene.narration.map((line) => line.text);

export const byRole = (storyboard: Storyboard, role: Scene['role']): Scene[] =>
  storyboard.scenes.filter((s) => s.role === role);

/** The code scenes of a storyboard, narrowed to their visual. */
export function codeScenes(storyboard: Storyboard) {
  return storyboard.scenes.flatMap((scene) =>
    scene.visual.type === 'code' ? [{ scene, visual: scene.visual }] : [],
  );
}

export const APP = [{ key: 'app', name: 'app', path: 'src', kind: 'module' as const }];

/** Plain statements, so that a stretch of lines holds no symbol and no comment. */
export const filler = (count: number, tag: string): string[] =>
  Array.from({ length: count }, (_, i) => `const ${tag}${i} = ${i};`);

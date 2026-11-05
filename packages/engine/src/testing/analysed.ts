/**
 * Helpers for the offline storyboard tests: changes that the real analyzer has read, and checks that
 * every code scene talks only about code on screen. Not part of the public API.
 */
import { analyze } from '../analyzer/index.ts';
import type { ConfigInput } from '../core/config.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { Analysis, ContextInputs, TestEvidence } from '../core/types.ts';
import { heuristicStoryboard } from '../storyboard/heuristic.ts';
import { escapeRegExp } from '../storyboard/text.ts';
import type { ValidationDeps } from '../storyboard/types.ts';
import { validateStoryboard } from '../storyboard/validate.ts';
import { buildChange, type ChangeOptions, emptyInputs, type FixtureFile } from './change.ts';
import { testContext } from './context.ts';

export interface AnalysedChange extends ValidationDeps {
  /** The offline storyboard for this change at a target length. */
  storyboard(targetSec?: number): Storyboard;
}

export interface AnalysedOptions extends ChangeOptions {
  task?: string | null;
  notes?: string | null;
  tests?: Omit<TestEvidence, 'id'>[];
  config?: ConfigInput;
}

/** Build a change from file texts, run the real analyzer on it, and return everything the validator needs. */
export async function analysedChange(
  files: FixtureFile[],
  options: AnalysedOptions = {},
): Promise<AnalysedChange> {
  const { task, notes, tests, config, ...change } = options;
  const { ctx } = testContext({ config });
  const { changeSet, reader } = buildChange(files, {
    excludePaths: ctx.config.privacy.excludePaths,
    ...change,
  });
  const inputs: ContextInputs = emptyInputs({
    task: task ?? null,
    notes: notes ?? null,
    tests: (tests ?? []).map((test, index) => ({ ...test, id: `T${index + 1}` })),
  });
  const analysis = await analyze(changeSet, reader, inputs, ctx);
  const deps: ValidationDeps = { changeSet, analysis, inputs, reader, config: ctx.config };
  return {
    ...deps,
    storyboard: (targetSec = 150) => heuristicStoryboard(changeSet, analysis, inputs, ctx.config, targetSec),
  };
}

/** The offline storyboard, run through the validator: nothing may be reported, repaired or removed. */
export async function expectCleanStoryboard(deps: ValidationDeps, storyboard: Storyboard): Promise<string[]> {
  const result = await validateStoryboard(storyboard, deps);
  return [
    ...result.errors.map((issue) => `error ${issue.path}: ${issue.message}`),
    ...result.warnings.map((issue) => `warning ${issue.path}: ${issue.message}`),
    ...result.fixes.map((fix) => `fix ${fix}`),
  ];
}

const KIND_WORDS = 'function|method|class|interface|type|constant|component|route';

/**
 * Symbols that a code scene describes ("the function withRetry", "New function withRetry") although
 * their lines are not in the range it shows. Names that only appear in code on screen do not count.
 */
export function symbolsOffScreen(storyboard: Storyboard, analysis: Analysis): string[] {
  const off: string[] = [];
  for (const scene of storyboard.scenes) {
    const visual = scene.visual;
    if (visual.type !== 'code') continue;
    const text = [...scene.narration.map((line) => line.text), ...visual.focus.map((f) => f.note ?? '')].join(
      '\n',
    );
    // Overloads share a name: the name is on screen when any symbol of that name is.
    const names = new Set(analysis.symbols.filter((s) => s.side === visual.ref.side).map((s) => s.name));
    for (const name of names) {
      const described = new RegExp(`\\b(?:${KIND_WORDS}) ${escapeRegExp(name)}(?![\\w.])`, 'i');
      if (!described.test(text)) continue;
      const onScreen = analysis.symbols.some(
        (s) =>
          s.name === name &&
          s.side === visual.ref.side &&
          s.startLine <= visual.ref.endLine &&
          s.endLine >= visual.ref.startLine,
      );
      if (!onScreen) off.push(`${scene.id}: ${name}`);
    }
  }
  return off;
}

/** Focus ranges that lie outside the code shown, or beats that point past the narration. */
export function focusProblems(storyboard: Storyboard): string[] {
  const problems: string[] = [];
  for (const scene of storyboard.scenes) {
    const visual = scene.visual;
    if (visual.type !== 'code') continue;
    for (const focus of visual.focus) {
      if (focus.startLine < visual.ref.startLine || focus.endLine > visual.ref.endLine) {
        problems.push(
          `${scene.id}: focus ${focus.startLine}-${focus.endLine} is outside ${visual.ref.startLine}-${visual.ref.endLine}`,
        );
      }
      if (focus.beat >= scene.narration.length)
        problems.push(`${scene.id}: beat ${focus.beat} is past the narration`);
    }
  }
  return problems;
}

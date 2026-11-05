/**
 * What the scene builders of the offline storyboard share: the settings of a level, the state of one
 * attempt, and the wording for files and components.
 */

import { isShowable } from '../core/path-policy.ts';
import { basename } from '../core/posix.ts';
import type { NodeKind, Scene } from '../core/storyboard-schema.ts';
import { countWords, plural } from '../core/text.ts';
import type { ChangedFile, Component, ComponentKind } from '../core/types.ts';
import { type Ctx, isTrivial, type Line, safeText } from './heuristic-context.ts';
import type { Statement } from './heuristic-facts.ts';

export interface Level {
  codeScenes: number;
  /** The most narration lines one code scene may have. */
  codeLines: number;
  reviewItems: number;
  missionLines: number;
  bigPictureLines: number;
  conclusionLines: number;
  /** Quote the notes and the description next to the code they mention. */
  quotes: boolean;
}

/** State for one attempt at one level. */
export interface Build {
  ctx: Ctx;
  level: Level;
  statements: Statement[];
  /** Statements that are already quoted somewhere, by their text. */
  used: Set<string>;
  quoted: boolean;
}

// ---------------------------------------------------------------------------
// What the change contains
// ---------------------------------------------------------------------------

function fileWeight(file: ChangedFile): number {
  return file.additions + file.deletions;
}

/** Files worth talking about, biggest change first. */
export function topFiles(ctx: Ctx, count: number): ChangedFile[] {
  const meaningful = ctx.changeSet.files.filter((file) => isShowable(file) && !isTrivial(ctx, file));
  const pool = meaningful.length > 0 ? meaningful : ctx.changeSet.files.filter((file) => isShowable(file));
  return [...pool]
    .sort((a, b) => fileWeight(b) - fileWeight(a) || a.path.localeCompare(b.path))
    .slice(0, count);
}

export function meaningfulComponents(ctx: Ctx): Component[] {
  return ctx.analysis.components
    .filter((component) =>
      component.fileIds.some((id) => {
        const file = ctx.fileById.get(id);
        return file !== undefined && isShowable(file) && !isTrivial(ctx, file);
      }),
    )
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.name.localeCompare(b.name));
}

const KIND_NOUN: Record<ComponentKind, string> = {
  module: 'module',
  package: 'package',
  service: 'service',
  ui: 'UI code',
  api: 'API code',
  cli: 'command line code',
  data: 'data code',
  tests: 'tests',
  docs: 'docs',
  config: 'configuration',
  infra: 'infrastructure code',
};

export const NODE_KIND: Record<ComponentKind, NodeKind> = {
  module: 'module',
  package: 'module',
  service: 'service',
  ui: 'ui',
  api: 'api',
  cli: 'cli',
  data: 'database',
  tests: 'test',
  docs: 'file',
  config: 'config',
  infra: 'config',
};

export function componentName(ctx: Ctx, component: Component): string {
  return safeText(ctx, component.name) ?? 'this part';
}

/** "the http module", "the docs", "the project files". */
export function componentPhrase(ctx: Ctx, component: Component): string {
  const name = componentName(ctx, component);
  const lower = name.toLowerCase();
  // A component named after its own kind ("api" of kind api) is "the api code", not "the api API code".
  const noun = KIND_NOUN[component.kind];
  if (noun.endsWith('code') && (lower === component.kind || lower === noun.toLowerCase())) {
    return `the ${name} code`;
  }
  if (
    /\b(files?|code|config|configuration|docs?|tests?)\b/.test(lower) ||
    lower.includes(KIND_NOUN[component.kind].toLowerCase())
  ) {
    return `the ${name}`;
  }
  return `the ${name} ${KIND_NOUN[component.kind]}`;
}

export function sizeText(additions: number, deletions: number): string {
  if (additions > 0 && deletions > 0) return `${plural(additions, 'line')} added and ${deletions} removed`;
  if (additions > 0) return `${plural(additions, 'line')} added`;
  if (deletions > 0) return `${plural(deletions, 'line')} removed`;
  return 'no changed lines';
}

/** "retry.ts, which is new, with 36 lines added". */
export function fileClause(file: ChangedFile): string {
  const name = basename(file.path);
  const status: Partial<Record<ChangedFile['status'], string>> = {
    added: ', which is new',
    deleted: ', which is deleted',
    renamed: ', which is renamed',
    copied: ', which is copied',
  };
  const size = sizeText(file.additions, file.deletions);
  return `${name}${status[file.status] ?? ''}${size === 'no changed lines' ? '' : `, with ${size}`}`;
}

/** "retry.ts (new, 36 lines added)": a short mention in a list. */
export function fileBrief(file: ChangedFile): string {
  const status: Partial<Record<ChangedFile['status'], string>> = {
    added: 'new',
    deleted: 'deleted',
    renamed: 'renamed',
    copied: 'copied',
  };
  const size = sizeText(file.additions, file.deletions);
  const parts = [status[file.status], size === 'no changed lines' ? undefined : size].filter(
    (part): part is string => part !== undefined,
  );
  return `${basename(file.path)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

export function scene(
  role: Scene['role'],
  title: string,
  lines: Line[],
  visual: Scene['visual'],
  description: string,
  transition: Scene['transition'],
): Scene {
  return {
    id: '',
    role,
    title,
    narration: lines.map((line) => ({ text: line.text, evidence: line.evidence })),
    visual,
    visualDescription: description,
    transition,
    targetSeconds: null,
  };
}

/** The sentences joined, as many as fit in `max` words. The first one always stays. */
export function fitWords(sentences: readonly string[], max: number): string {
  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = countWords(sentence);
    if (kept.length > 0 && words + count > max) break;
    kept.push(sentence);
    words += count;
  }
  return kept.join(' ');
}

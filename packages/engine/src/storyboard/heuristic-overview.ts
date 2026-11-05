/** The big picture scene: a diagram when components are connected, the list of files when they are not. */
import { STORYBOARD_LIMITS as LIMITS, type Scene } from '../core/storyboard-schema.ts';
import { countWords, naturalList, plural } from '../core/text.ts';
import type { Component } from '../core/types.ts';
import { type Ctx, cite, type Line } from './heuristic-context.ts';
import { dependencyLine, testsLine } from './heuristic-facts.ts';
import {
  type Build,
  componentName,
  componentPhrase,
  fileBrief,
  fileClause,
  meaningfulComponents,
  NODE_KIND,
  scene,
  sizeText,
  topFiles,
} from './heuristic-shared.ts';
import { capitalise } from './text.ts';

/** What a relationship says, for a subject in the singular and in the plural. */
const VERB: Record<string, [string, string]> = {
  imports: ['imports from', 'import from'],
  tests: ['imports from', 'import from'],
  configures: ['configures', 'configure'],
};

/** "the http tests", "the docs" and "the project files" are plural; "the http module" is not. */
const isPlural = (phrase: string): boolean => /\b(?:tests|docs|files)$/.test(phrase);

function architectureScene(b: Build, components: Component[]): Scene | null {
  const { ctx, level } = b;
  const { files: fileCount } = ctx.changeSet.stats;
  const nodesFor = components.slice(0, LIMITS.maxArchitectureNodes);
  const present = new Set(nodesFor.map((component) => component.id));
  const seen = new Set<string>();
  const relationships = ctx.analysis.relationships
    .filter((rel) => present.has(rel.from) && present.has(rel.to) && rel.from !== rel.to)
    .filter((rel) => {
      const key = `${rel.from}>${rel.to}:${rel.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
  // Boxes with nothing between them say less than the list of files does.
  if (nodesFor.length < 2 || relationships.length === 0) return null;

  const top = components[0]!;
  const byId = new Map(nodesFor.map((component) => [component.id, component]));
  const lines: Line[] = [
    {
      text: `The change touches ${plural(fileCount, 'file')} in ${plural(components.length, 'component')}.`,
      evidence: cite(ctx, ...components.slice(0, 3).map((c) => c.id)),
    },
  ];
  if (level.bigPictureLines >= 2) {
    lines.push({
      text: `The biggest part is ${componentPhrase(ctx, top)}, with ${sizeText(top.additions, top.deletions)}.`,
      evidence: cite(ctx, top.id),
    });
  }
  if (level.bigPictureLines >= 3) {
    const sentences = relationships.slice(0, 2).flatMap((rel) => {
      const from = byId.get(rel.from);
      const to = byId.get(rel.to);
      if (!from || !to) return [];
      const subject = componentPhrase(ctx, from);
      const verb = VERB[rel.kind]?.[isPlural(subject) ? 1 : 0] ?? (isPlural(subject) ? 'use' : 'uses');
      return [`${capitalise(subject)} ${verb} ${componentPhrase(ctx, to)}.`];
    });
    lines.push({
      text: sentences.join(' '),
      evidence: cite(ctx, ...relationships.slice(0, 2).flatMap((rel) => [rel.evidence, rel.from, rel.to])),
    });
  }
  if (level.bigPictureLines >= 4) {
    const extra = testsAndDependencies(ctx);
    if (extra) lines.push(extra);
  }
  const topBeat = lines.length > 1 ? 1 : 0;
  const otherBeat = lines.length > 2 ? 2 : lines.length - 1;
  const beatOf = new Map(
    nodesFor.map((component) => [component.id, component.id === top.id ? topBeat : otherBeat]),
  );
  const nodes = nodesFor.map((component) => {
    const fileIds = component.fileIds.filter((id) => ctx.fileById.has(id));
    return {
      id: component.id,
      label: componentName(ctx, component),
      detail: `${plural(fileIds.length, 'file')} · +${component.additions} −${component.deletions}`,
      kind: NODE_KIND[component.kind],
      status: component.status,
      beat: beatOf.get(component.id) ?? 0,
      evidence: cite(ctx, component.id, ...fileIds.slice(0, 2)),
    };
  });
  const edges = relationships.map((rel) => ({
    from: rel.from,
    to: rel.to,
    label: rel.kind,
    status: 'unchanged' as const,
    beat: Math.max(beatOf.get(rel.from) ?? 0, beatOf.get(rel.to) ?? 0),
  }));
  return scene(
    'big-picture',
    'The big picture',
    lines.slice(0, level.bigPictureLines),
    { type: 'architecture', direction: 'LR', nodes, edges },
    'A diagram of the components that changed and how they relate.',
    'slide',
  );
}

/** The test files and the dependencies of the change, in one line when both fit, or null. */
function testsAndDependencies(ctx: Ctx): Line | null {
  const tests = testsLine(ctx);
  const dependencies = dependencyLine(ctx);
  if (tests && dependencies) {
    const text = `${tests.text} ${dependencies.text}`;
    if (countWords(text) <= LIMITS.maxWordsPerNarrationLine) {
      return { text, evidence: [...new Set([...tests.evidence, ...dependencies.evidence])] };
    }
  }
  return tests ?? dependencies;
}

function filesScene(b: Build, components: Component[]): Scene {
  const { ctx, level } = b;
  const { files: fileCount, additions, deletions } = ctx.changeSet.stats;
  const shown = topFiles(ctx, 8);
  const narrated = shown.slice(0, 3);
  const lines: Line[] = [];

  if (narrated.length === 0) {
    lines.push({
      text: `The change touches ${plural(fileCount, 'file')}, with ${sizeText(additions, deletions)}.`,
      evidence: cite(ctx),
    });
  } else {
    const [first, ...next] = narrated;
    const total = shown.length;
    lines.push({
      text:
        total === 1
          ? `The only changed file is ${fileClause(first!)}.`
          : `The largest change is in ${fileClause(first!)}.`,
      evidence: cite(ctx, first!.id),
    });
    if (next.length > 0 && level.bigPictureLines >= 2) {
      lines.push({
        text: `Next come ${naturalList(next.map(fileBrief))}.`,
        evidence: cite(ctx, ...next.map((file) => file.id)),
      });
    }
    if (level.bigPictureLines >= 3) {
      const extra = testsAndDependencies(ctx);
      const main = components[0];
      if (extra) lines.push(extra);
      else if (main && total > 1) {
        lines.push({
          text: `Most of it is in ${componentPhrase(ctx, main)}.`,
          evidence: cite(ctx, main.id),
        });
      }
    }
  }
  return scene(
    'big-picture',
    'The big picture',
    lines.slice(0, level.bigPictureLines),
    { type: 'files', highlightPaths: narrated.map((file) => file.path), caption: null },
    'The list of changed files, grouped by component, with the largest changes highlighted.',
    'slide',
  );
}

export function bigPictureScene(b: Build): Scene {
  const components = meaningfulComponents(b.ctx);
  return architectureScene(b, components) ?? filesScene(b, components);
}

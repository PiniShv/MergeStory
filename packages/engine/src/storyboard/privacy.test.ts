/**
 * One privacy verdict for every stage. The source marks a changed file sensitive when its path or its
 * previous path is a built-in sensitive path or matches `privacy.excludePaths`, and every later stage
 * reads that mark. This change holds a file at an excluded path, a file at a built-in sensitive path
 * and a file renamed away from an excluded path, next to a file that may be shown. Nothing of the
 * first three may reach the evidence pack, the validator, the offline storyboard or the code view.
 */
import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../analyzer/index.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { RepoReader, Side } from '../core/types.ts';
import { type AnalysedChange, analysedChange, expectCleanStoryboard } from '../testing/analysed.ts';
import type { FixtureFile } from '../testing/change.ts';
import { CodeResolver } from '../visuals/code.ts';
import { validateStoryboard } from './validate.ts';

const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

const FILES: FixtureFile[] = [
  {
    path: 'secrets/plan.ts',
    language: 'typescript',
    head: text('export function launchPlan(): string {', "  return 'excluded-marker-111';", '}'),
  },
  { path: 'deploy/id_rsa', language: null, head: text('built-in-marker-222') },
  {
    path: 'src/vault.ts',
    oldPath: 'secrets/old-vault.ts',
    status: 'renamed',
    language: 'typescript',
    base: text('export function openVault(): string {', "  return 'renamed-marker-333';", '}'),
    head: text('export function openVault(): string {', "  return 'renamed-marker-444';", '}'),
  },
  {
    path: 'src/open.ts',
    language: 'typescript',
    head: text('export function openDoor(): void {', '  go();', '}'),
  },
];

/** The paths the change holds that must stay hidden, each with the side that a reference to it would use. */
const HIDDEN: { path: string; side: Side }[] = [
  { path: 'secrets/plan.ts', side: 'head' },
  { path: 'deploy/id_rsa', side: 'head' },
  { path: 'src/vault.ts', side: 'head' },
  { path: 'secrets/old-vault.ts', side: 'base' },
];

const LEAKS = /excluded-marker|built-in-marker|renamed-marker|launchPlan|openVault|plan\.ts|id_rsa|vault/;

async function change(): Promise<AnalysedChange> {
  return analysedChange(FILES, { config: { privacy: { excludePaths: ['secrets/'] } } });
}

describe('one privacy verdict for every stage', () => {
  it('is set on the files of the change by the path policy, for the path and the previous path', async () => {
    const { changeSet } = await change();
    expect(changeSet.files.map((file) => [file.path, file.sensitive])).toEqual([
      ['secrets/plan.ts', true],
      ['deploy/id_rsa', true],
      ['src/vault.ts', true],
      ['src/open.ts', false],
    ]);
  });

  it('keeps the evidence pack to the paths and counts of the hidden files', async () => {
    const { changeSet, analysis, inputs } = await change();
    const { markdown } = buildEvidencePack(changeSet, analysis, inputs, {
      maxTokens: 24_000,
      llmContext: 'full',
      targetDurationSec: 60,
      style: 'hybrid',
      language: 'en',
    });
    expect(markdown).not.toMatch(/excluded-marker|built-in-marker|renamed-marker|launchPlan|openVault/);
    for (const name of ['secrets/plan.ts', 'deploy/id_rsa', 'src/vault.ts']) {
      const row = markdown.split('\n').find((line) => line.startsWith('| F') && line.includes(` ${name} `));
      expect(row, name).toContain('sensitive: content hidden');
    }
    expect(markdown).toContain('- Hunks: F4.H1\n');
    expect(markdown).toContain('openDoor');
  });

  it('makes the validator refuse a code reference to any of the paths', async () => {
    const fx = await change();
    const base = fx.storyboard(150);
    const index = base.scenes.findIndex((scene) => scene.visual.type === 'code');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(await expectCleanStoryboard(fx, base)).toEqual([]);

    for (const { path, side } of HIDDEN) {
      const storyboard = structuredClone(base);
      const visual = storyboard.scenes[index]!.visual;
      if (visual.type !== 'code') throw new Error('unexpected visual');
      visual.ref = { path, side, startLine: 1, endLine: 2 };
      const result = await validateStoryboard(storyboard, fx);
      expect(result.storyboard, path).toBeNull();
      expect(
        result.errors.map((error) => error.code),
        path,
      ).toContain('code-ref-sensitive');
    }
  });

  it('gives an offline storyboard that names and cites none of them, whatever the length', async () => {
    const fx = await change();
    for (const targetSec of [20, 60, 150, 300]) {
      const storyboard = fx.storyboard(targetSec);
      expect(JSON.stringify(storyboard), `${targetSec} s`).not.toMatch(LEAKS);
      expect(await expectCleanStoryboard(fx, storyboard)).toEqual([]);
      expect(codeRefs(storyboard).length).toBeGreaterThan(0);
      for (const ref of codeRefs(storyboard)) expect(ref).toBe('src/open.ts');
    }
  });

  it('shows the protected panel for any of them in the code view, and reads none of them', async () => {
    const { changeSet, reader } = await change();
    const reads: string[] = [];
    const recording: RepoReader = {
      readFile(path, side) {
        reads.push(`${side}:${path}`);
        return reader.readFile(path, side);
      },
    };
    const resolver = new CodeResolver({ reader: recording, changeSet, shiki: 'github-dark-default' });
    for (const { path, side } of HIDDEN) {
      const code = await resolver.resolve({ path, side, startLine: 1, endLine: 2 }, 'snippet');
      expect(code.masked, path).toBe(true);
      expect(
        code.lines.map((line) => line.tokens.map((token) => token.t).join('')),
        path,
      ).toEqual(['Protected file: its contents are never shown.']);
    }
    expect(reads).toEqual([]);

    const open = await resolver.resolve(
      { path: 'src/open.ts', side: 'head', startLine: 1, endLine: 3 },
      'diff',
    );
    expect(open.lines.map((line) => line.tokens.map((token) => token.t).join('')).join('\n')).toContain(
      'export function openDoor',
    );
  });
});

/** The paths of the code that the scenes of a storyboard show. */
function codeRefs(storyboard: Storyboard): string[] {
  return storyboard.scenes.flatMap((scene) => {
    const visual = scene.visual;
    if (visual.type === 'code') return [visual.ref.path];
    if (visual.type === 'before-after') {
      return [visual.before, visual.after].flatMap((panel) => (panel.codeRef ? [panel.codeRef.path] : []));
    }
    return [];
  });
}

import { describe, expect, it } from 'vitest';
import { buildChange, emptyInputs, type FixtureFile } from '../testing/change.ts';
import { buildEvidenceIndex, type EvidenceSources } from './evidence.ts';

function sourcesFor(files: FixtureFile[]): EvidenceSources {
  const { changeSet } = buildChange(files);
  return {
    changeSet,
    inputs: emptyInputs(),
    hiddenFileIds: new Set(),
    components: [],
    symbols: [],
    risks: [],
    dependencies: [],
  };
}

const OLD_SOURCE = [
  'export function a(): number {',
  '  return 1;',
  '}',
  '',
  'export function b(): number {',
  '  return 2;',
  '}',
  '',
  'export function c(): number {',
  '  return 3;',
  '}',
  '',
  'export const LIMIT = 10;',
];
// The same file without the function c.
const NEW_SOURCE = [...OLD_SOURCE.slice(0, 8), ...OLD_SOURCE.slice(12)];

describe('hunk evidence', () => {
  it('names a renamed file by its old path when the hunk only deletes lines, because it is read at base', () => {
    const sources = sourcesFor([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'renamed',
        base: OLD_SOURCE.join('\n'),
        head: NEW_SOURCE.join('\n'),
      },
    ]);
    const item = buildEvidenceIndex(sources).find((e) => e.kind === 'hunk')!;
    expect(item.ref).toMatchObject({ path: 'src/old.ts', side: 'base' });
    expect(item.label).toBe(`src/old.ts:${item.ref!.startLine}-${item.ref!.endLine}`);
    expect(item.url).toContain('/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/src/old.ts#L');
    expect(item.url).not.toContain('new.ts');
  });

  it('keeps the new path for a hunk that adds lines, which is read at head', () => {
    const added = [...OLD_SOURCE, 'export const OTHER = 1;'];
    const sources = sourcesFor([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'renamed',
        base: OLD_SOURCE.join('\n'),
        head: added.join('\n'),
      },
    ]);
    const item = buildEvidenceIndex(sources).find((e) => e.kind === 'hunk')!;
    expect(item.ref).toMatchObject({ path: 'src/new.ts', side: 'head' });
    expect(item.label).toContain('src/new.ts:');
    expect(item.url).toContain('/blob/f6e5d4c3b2a1908172635445362718091a2b3c4d/src/new.ts#L');
  });

  it('keeps the path of a file that was not renamed', () => {
    const sources = sourcesFor([
      { path: 'src/a.ts', base: OLD_SOURCE.join('\n'), head: NEW_SOURCE.join('\n') },
    ]);
    const item = buildEvidenceIndex(sources).find((e) => e.kind === 'hunk')!;
    expect(item.ref).toMatchObject({ path: 'src/a.ts', side: 'base' });
    expect(item.label).toContain('src/a.ts:');
  });
});

describe('reproduction evidence', () => {
  const repro = {
    title: 'Basket count',
    environment: null,
    steps: [
      { text: 'Open the page', screenshotId: 'SS1', recordingId: null, result: 'bug' as const },
      { text: 'Mail jane.doe@example.com', screenshotId: null, recordingId: null, result: null },
    ],
  };

  it('gives the reproduction the id REPRO and each step REPRO.n, with the text as the label', () => {
    const sources = sourcesFor([]);
    sources.inputs = emptyInputs({ repro });
    const items = buildEvidenceIndex(sources).filter((e) => e.kind === 'repro');
    expect(items.map((e) => [e.id, e.label])).toEqual([
      ['REPRO', 'Basket count'],
      ['REPRO.1', 'Step 1: Open the page'],
      ['REPRO.2', 'Step 2: Mail j•••@example.com'],
    ]);
  });

  it('adds nothing without a reproduction', () => {
    expect(buildEvidenceIndex(sourcesFor([])).some((e) => e.kind === 'repro')).toBe(false);
  });
});

describe('capture labels', () => {
  it('masks an e-mail address in the label of a recording, whatever the privacy setting', () => {
    const sources = sourcesFor([]);
    sources.inputs = emptyInputs({
      recordings: [
        {
          id: 'RC1',
          path: '/x/a.mp4',
          caption: 'Sent by jane.doe@example.com',
          moment: 'before',
          durationSec: 3,
          width: 640,
          height: 480,
          codec: 'h264',
        },
      ],
    });
    const item = buildEvidenceIndex(sources).find((e) => e.id === 'RC1')!;
    expect(item.label).toBe('Sent by j•••@example.com');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../core/types.ts';
import { memoryReader, sampleChangeSet } from '../testing/sample-change.ts';
import { CodeResolver } from './code.ts';
import * as highlight from './highlight.ts';

vi.mock('./highlight.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./highlight.ts')>();
  return { ...original, highlightText: vi.fn(original.highlightText) };
});

const LINES = 20_000;

describe('code from a very long file', () => {
  it('highlights a window around the lines, so the work does not grow with the line number', async () => {
    const file: ChangedFile = {
      id: 'F9',
      path: 'big.js',
      oldPath: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      binary: false,
      language: 'javascript',
      hunks: [],
      patchTruncated: false,
      sensitive: false,
    };
    const changeSet = sampleChangeSet();
    changeSet.files = [file];
    const content = Array.from({ length: LINES }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    const resolver = new CodeResolver({
      reader: memoryReader({ 'head:big.js': content }),
      changeSet,
      shiki: 'github-dark-default',
    });
    const spy = vi.mocked(highlight.highlightText);
    const highlightedLines = async (line: number): Promise<number> => {
      spy.mockClear();
      const code = await resolver.resolve(
        { path: 'big.js', side: 'head', startLine: line, endLine: line + 2 },
        'snippet',
        [],
      );
      expect(code.lines.map((l) => l.tokens.map((t) => t.t).join(''))[0]).toBe(
        `const line${line} = ${line};`,
      );
      return spy.mock.calls.reduce((sum, [text]) => sum + text.split('\n').length, 0);
    };
    const early = await highlightedLines(100);
    const late = await highlightedLines(19_000);
    expect(late).toBeLessThanOrEqual(600);
    expect(late).toBeLessThanOrEqual(early + 400);
  });
});

import { describe, expect, it } from 'vitest';
import { createRefResolver } from '../storyboard/coderef.ts';
import { analysedChange, expectCleanStoryboard } from '../testing/analysed.ts';

const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('key hunks of a renamed file', () => {
  const pad = (n: number) => Array.from({ length: n }, (_, i) => `export const pad${i} = ${i};`);
  const change = () =>
    analysedChange([
      {
        path: 'src/helpers.ts',
        oldPath: 'src/util.ts',
        status: 'renamed',
        language: 'typescript',
        base: text(
          'export function legacySlug(text: string): string {',
          '  const lowered = text.toLowerCase();',
          '  const dashed = lowered.replace(/ /g, "-");',
          '  return dashed;',
          '}',
          '',
          ...pad(12),
          'export const LIMIT = 1;',
        ),
        head: text(...pad(12), 'export const LIMIT = 2;'),
      },
    ]);

  it('names the old path for a hunk that only removes lines', async () => {
    const { analysis } = await change();
    const removal = analysis.keyHunks.find((k) => k.side === 'base');
    expect(removal?.path).toBe('src/util.ts');
    const addition = analysis.keyHunks.find((k) => k.side === 'head');
    expect(addition?.path).toBe('src/helpers.ts');
  });

  it('is a reference that still resolves, and the offline storyboard stays clean', async () => {
    const built = await change();
    const resolver = createRefResolver(built.changeSet.files, built.reader);
    for (const key of built.analysis.keyHunks) {
      const result = await resolver.resolve({
        path: key.path,
        side: key.side,
        startLine: key.startLine,
        endLine: key.endLine,
      });
      expect(result.ok, `${key.id} at ${key.path}`).toBe(true);
    }
    expect(await expectCleanStoryboard(built, built.storyboard())).toEqual([]);
  });
});

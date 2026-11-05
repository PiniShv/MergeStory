import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs } from '../core/types.ts';
import { makePng } from '../testing/png.ts';
import { sampleStoryboard } from '../testing/sample-change.ts';
import { MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import { buildContextInputs, checkTestResults, unusedScreenshotWarning } from './inputs.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-pipeline-inputs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildContextInputs: screenshots', () => {
  const shot = (path: string) => ({ path, caption: 'Dashboard', moment: 'after' as const });

  it('accepts a PNG, gives it the id SS1 and an absolute path', async () => {
    await writeFile(join(dir, 'a.png'), makePng(4, 4));
    const inputs = await buildContextInputs({ screenshots: [shot('a.png')] }, dir);
    expect(inputs.screenshots).toEqual([
      { id: 'SS1', path: join(dir, 'a.png'), caption: 'Dashboard', moment: 'after' },
    ]);
  });

  it('refuses a file that is not a PNG or JPEG, before anything is analysed or narrated', async () => {
    for (const [name, bytes] of [
      ['text.png', Buffer.from('not an image')],
      ['page.webp', Buffer.from('RIFF....WEBPVP8 ')],
      ['moving.gif', Buffer.from('GIF89a......')],
      ['empty.png', Buffer.alloc(0)],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      await expect(buildContextInputs({ screenshots: [shot(name)] }, dir), name).rejects.toMatchObject({
        code: 'USAGE',
        message: `Screenshot: ${name} is not a PNG or JPEG image (up to 40 megapixels).`,
      });
    }
  });

  it('refuses a file over 4 MB, with the limit that the video has', async () => {
    const big = join(dir, 'big.png');
    await writeFile(big, makePng(4, 4));
    await truncate(big, MAX_SCREENSHOT_BYTES + 1);
    await expect(buildContextInputs({ screenshots: [shot('big.png')] }, dir)).rejects.toMatchObject({
      code: 'USAGE',
      message: 'Screenshot: big.png is 4.1 MB, the limit is 4 MB.',
    });
    await expect(buildContextInputs({ screenshots: [shot('missing.png')] }, dir)).rejects.toMatchObject({
      message: 'Screenshot: file not found: missing.png',
    });
  });
});

describe('checkTestResults', () => {
  it('fills in the source and keeps what was reported', () => {
    expect(checkTestResults([{ command: 'npm test', passed: false, summary: '3 failed' }])).toEqual([
      { command: 'npm test', passed: false, summary: '3 failed', source: 'agent' },
    ]);
    expect(checkTestResults([{ command: 'make', passed: true, summary: '', source: 'ci' }])[0]?.source).toBe(
      'ci',
    );
    expect(checkTestResults([])).toEqual([]);
  });

  it('never invents a result for a missing or mistyped field', () => {
    for (const entry of [
      { command: 'x', summary: '' },
      { command: 'x', passed: 1, summary: '' },
      { command: 'x', passed: 'false', summary: '' },
      { command: '  ', passed: true, summary: '' },
      { command: 'x', passed: true },
      { command: 'x', passed: true, summary: '', source: 'robot' },
      { command: 'x', pass: true, passed: true, summary: '' },
      { passed: true, summary: '' },
      'text',
      null,
      ['x'],
    ]) {
      expect(() => checkTestResults([entry])).toThrow(MergeStoryError);
    }
  });

  it('says what is wrong with an entry, and where', () => {
    const message = (value: unknown) => {
      try {
        checkTestResults(value, '--tests-file');
      } catch (err) {
        return (err as Error).message;
      }
      return null;
    };
    expect(message('nope')).toBe('--tests-file: expected a JSON array of test results.');
    expect(message([{ command: 'x', passed: true, summary: '' }, 3])).toBe(
      '--tests-file: entry 2 is not an object.',
    );
    expect(message([{ command: 'x', passed: 'false', summary: '' }])).toBe(
      '--tests-file: entry 1 needs "passed" set to true or false.',
    );
    expect(message([{ command: 'x', pass: true, summary: '' }])).toBe(
      '--tests-file: entry 1 has unknown field "pass". Allowed: command, passed, summary, source.',
    );
    expect(message([{ command: 'x', passed: true, summary: '', source: 'robot' }])).toBe(
      '--tests-file: entry 1 has source "robot". Use one of: agent, ci, user.',
    );
  });

  it('refuses too many entries', () => {
    const many = Array.from({ length: 201 }, () => ({ command: 'x', passed: true, summary: '' }));
    expect(() => checkTestResults(many)).toThrow(/too many/);
  });

  it('uses the given label in errors', () => {
    expect(() => checkTestResults('nope', '--tests-file')).toThrow(/^--tests-file: /);
  });
});

describe('buildContextInputs: test results', () => {
  const test = (n: number) => ({ command: `cmd ${n}`, passed: true, summary: 'ok', source: 'ci' as const });

  it('numbers the results and cuts long texts', async () => {
    const inputs = await buildContextInputs(
      { tests: [{ ...test(1), command: 'c'.repeat(400), summary: 's'.repeat(1500) }] },
      dir,
    );
    expect(inputs.tests).toEqual([
      { id: 'T1', command: 'c'.repeat(300), passed: true, summary: 's'.repeat(1000), source: 'ci' },
    ]);
  });

  it('uses the first 10 results and warns about the rest', async () => {
    const warnings: string[] = [];
    const inputs = await buildContextInputs(
      { tests: Array.from({ length: 12 }, (_, i) => test(i)) },
      dir,
      (m) => warnings.push(m),
    );
    expect(inputs.tests).toHaveLength(10);
    expect(warnings).toEqual(['Only the first 10 test results are used.']);
  });

  it('refuses a result that is not what the types promise, instead of making up a value', async () => {
    const bad = [{ command: 'npm test', passed: 'false', summary: '3 failed' }] as never;
    await expect(buildContextInputs({ tests: bad }, dir)).rejects.toMatchObject({
      code: 'USAGE',
      message: 'tests: entry 1 needs "passed" set to true or false.',
    });
  });
});

describe('unusedScreenshotWarning', () => {
  const inputs = (count: number): ContextInputs => ({
    task: null,
    notes: null,
    tests: [],
    screenshots: Array.from({ length: count }, (_, i) => ({
      id: `SS${i + 1}`,
      path: `/x/${i}.png`,
      caption: i === 0 ? 'Dashboard' : '',
      moment: 'other' as const,
    })),
  });

  function withScreenshot(id: string, panel = false): Storyboard {
    const storyboard = sampleStoryboard();
    const scene = storyboard.scenes[2];
    if (!scene) throw new Error('fixture changed');
    scene.visual = panel
      ? {
          type: 'before-after',
          before: {
            label: 'Before',
            kind: 'bullets',
            codeRef: null,
            bullets: ['a'],
            terminal: [],
            screenshotId: null,
          },
          after: {
            label: 'After',
            kind: 'screenshot',
            codeRef: null,
            bullets: [],
            terminal: [],
            screenshotId: id,
          },
          caption: null,
        }
      : { type: 'screenshot', screenshotId: id, caption: null };
    return storyboard;
  }

  it('says nothing when no screenshot was supplied, or all of them are shown', () => {
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(0), 'heuristic')).toBeNull();
    expect(unusedScreenshotWarning(withScreenshot('SS1'), inputs(1), 'llm')).toBeNull();
    expect(unusedScreenshotWarning(withScreenshot('SS1', true), inputs(1), 'agent')).toBeNull();
  });

  it('explains that the offline storyboard never shows screenshots', () => {
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(1), 'heuristic')).toBe(
      'The screenshot SS1 ("Dashboard") is not shown in the video. The offline storyboard never uses screenshots: write the storyboard yourself (--storyboard) or use --llm to show them.',
    );
  });

  it('names the screenshots that a written or model storyboard left out', () => {
    expect(unusedScreenshotWarning(withScreenshot('SS1'), inputs(3), 'agent')).toBe(
      'The screenshots SS2, SS3 are not shown in the video.',
    );
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(1), 'llm')).toBe(
      'The screenshot SS1 ("Dashboard") is not shown in the video.',
    );
  });
});

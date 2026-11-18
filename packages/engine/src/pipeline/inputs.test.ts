import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs } from '../core/types.ts';
import { testConfig } from '../testing/context.ts';
import { makeClip } from '../testing/media.ts';
import { makeJpeg, makePng } from '../testing/png.ts';
import { sampleStoryboard } from '../testing/sample-change.ts';
import { MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import {
  buildContextInputs,
  checkRedactions,
  checkRepro,
  checkTestResults,
  evidenceUsed,
  MAX_LOG_BYTES,
  unusedScreenshotWarning,
} from './inputs.ts';

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
    const inputs = await buildContextInputs({ screenshots: [shot('a.png')] }, dir, testConfig());
    expect(inputs.screenshots).toEqual([
      { id: 'SS1', path: join(dir, 'a.png'), caption: 'Dashboard', moment: 'after' },
    ]);
  });

  it('uses 6 screenshots by default and warns about the rest, with the real number', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `s${i}.png`);
    for (const name of names) await writeFile(join(dir, name), makePng(4, 4));
    const warnings: string[] = [];
    const inputs = await buildContextInputs({ screenshots: names.map(shot) }, dir, testConfig(), (m) =>
      warnings.push(m),
    );
    expect(inputs.screenshots.map((s) => s.id)).toEqual(['SS1', 'SS2', 'SS3', 'SS4', 'SS5', 'SS6']);
    expect(warnings).toEqual([
      'Only the first 6 screenshots are used. Raise inputs.maxScreenshots (at most 12) to use more.',
    ]);
  });

  it('takes the limit from the setting', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `s${i}.png`);
    for (const name of names) await writeFile(join(dir, name), makePng(4, 4));
    const warnings: string[] = [];
    const twelve = await buildContextInputs(
      { screenshots: names.map(shot) },
      dir,
      testConfig({ inputs: { maxScreenshots: 12 } }),
      (m) => warnings.push(m),
    );
    expect(twelve.screenshots).toHaveLength(12);
    expect(warnings).toEqual(['Only the first 12 screenshots are used.']);
    const none = await buildContextInputs(
      { screenshots: names.map(shot) },
      dir,
      testConfig({ inputs: { maxScreenshots: 0 } }),
    );
    expect(none.screenshots).toEqual([]);
  });

  it('refuses a file that is not a PNG or JPEG, before anything is analysed or narrated', async () => {
    for (const [name, bytes] of [
      ['text.png', Buffer.from('not an image')],
      ['page.webp', Buffer.from('RIFF....WEBPVP8 ')],
      ['moving.gif', Buffer.from('GIF89a......')],
      ['empty.png', Buffer.alloc(0)],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      await expect(
        buildContextInputs({ screenshots: [shot(name)] }, dir, testConfig()),
        name,
      ).rejects.toMatchObject({
        code: 'USAGE',
        message: `Screenshot: ${name} is not a PNG or JPEG image (up to 40 megapixels).`,
      });
    }
  });

  it('refuses a file over 4 MB, with the limit that the video has', async () => {
    const big = join(dir, 'big.png');
    await writeFile(big, makePng(4, 4));
    await truncate(big, MAX_SCREENSHOT_BYTES + 1);
    await expect(
      buildContextInputs({ screenshots: [shot('big.png')] }, dir, testConfig()),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: 'Screenshot: big.png is 4.1 MB, the limit is 4 MB.',
    });
    await expect(
      buildContextInputs({ screenshots: [shot('missing.png')] }, dir, testConfig()),
    ).rejects.toMatchObject({
      message: 'Screenshot: file not found: missing.png',
    });
  });
});

describe('checkTestResults', () => {
  it('fills in the source and keeps what was reported', () => {
    expect(checkTestResults([{ command: 'npm test', passed: false, summary: '3 failed' }])).toEqual([
      {
        command: 'npm test',
        passed: false,
        summary: '3 failed',
        source: 'agent',
        log: null,
      },
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
      '--tests-file: entry 1 has unknown field "pass". Allowed: command, passed, summary, source, log.',
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
      testConfig(),
    );
    expect(inputs.tests).toEqual([
      {
        id: 'T1',
        command: 'c'.repeat(300),
        passed: true,
        summary: 's'.repeat(1000),
        source: 'ci',
        log: null,
      },
    ]);
  });

  it('uses the first 10 results and warns about the rest', async () => {
    const warnings: string[] = [];
    const inputs = await buildContextInputs(
      { tests: Array.from({ length: 12 }, (_, i) => test(i)) },
      dir,
      testConfig(),
      (m) => warnings.push(m),
    );
    expect(inputs.tests).toHaveLength(10);
    expect(warnings).toEqual(['Only the first 10 test results are used.']);
  });

  it('refuses a result that is not what the types promise, instead of making up a value', async () => {
    const bad = [{ command: 'npm test', passed: 'false', summary: '3 failed' }] as never;
    await expect(buildContextInputs({ tests: bad }, dir, testConfig())).rejects.toMatchObject({
      code: 'USAGE',
      message: 'tests: entry 1 needs "passed" set to true or false.',
    });
  });
});

const PRIVACY = { maskEmails: true };

describe('unusedScreenshotWarning', () => {
  const inputs = (count: number): ContextInputs => ({
    task: null,
    notes: null,
    tests: [],
    recordings: [],
    repro: null,
    logs: [],
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
            recordingId: null,
            highlights: [],
          },
          after: {
            label: 'After',
            kind: 'screenshot',
            codeRef: null,
            bullets: [],
            terminal: [],
            screenshotId: id,
            recordingId: null,
            highlights: [],
          },
          caption: null,
        }
      : { type: 'screenshot', screenshotId: id, caption: null, highlights: [], focus: null };
    return storyboard;
  }

  it('says nothing when no screenshot was supplied, or all of them are shown', () => {
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(0), 'heuristic', PRIVACY)).toBeNull();
    expect(unusedScreenshotWarning(withScreenshot('SS1'), inputs(1), 'llm', PRIVACY)).toBeNull();
    expect(unusedScreenshotWarning(withScreenshot('SS1', true), inputs(1), 'agent', PRIVACY)).toBeNull();
  });

  it('explains that the offline storyboard never shows screenshots', () => {
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(1), 'heuristic', PRIVACY)).toBe(
      'The screenshot SS1 ("Dashboard") is not shown in the video. The offline storyboard never uses screenshots: write the storyboard yourself (--storyboard) or use --llm to show them.',
    );
  });

  it('names the screenshots that a written or model storyboard left out', () => {
    expect(unusedScreenshotWarning(withScreenshot('SS1'), inputs(3), 'agent', PRIVACY)).toBe(
      'The screenshots SS2, SS3 are not shown in the video.',
    );
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(1), 'llm', PRIVACY)).toBe(
      'The screenshot SS1 ("Dashboard") is not shown in the video.',
    );
  });
});

describe('unusedScreenshotWarning for recordings', () => {
  const recording = (n: number, caption: string) => ({
    id: `RC${n}`,
    path: `/x/${n}.mp4`,
    caption,
    moment: 'other' as const,
    durationSec: 5,
    width: 640,
    height: 360,
    codec: 'h264',
  });
  const inputs = (...recordings: ReturnType<typeof recording>[]): ContextInputs => ({
    task: null,
    notes: null,
    tests: [],
    screenshots: [],
    recordings,
    repro: null,
    logs: [],
  });
  const showing = (visual: Storyboard['scenes'][number]['visual']): Storyboard => {
    const storyboard = sampleStoryboard();
    storyboard.scenes[2]!.visual = visual;
    return storyboard;
  };
  const clip = {
    type: 'recording' as const,
    recordingId: 'RC1',
    caption: null,
    trim: null,
    speed: null,
    zoom: null,
    highlights: [],
    focus: null,
  };

  it('says nothing when every recording is shown', () => {
    expect(unusedScreenshotWarning(showing(clip), inputs(recording(1, '')), 'llm', PRIVACY)).toBeNull();
  });

  it('names a recording that the video does not show, and says why the offline storyboard skips it', () => {
    expect(
      unusedScreenshotWarning(sampleStoryboard(), inputs(recording(1, 'Checkout')), 'llm', PRIVACY),
    ).toBe('The recording RC1 ("Checkout") is not shown in the video.');
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(recording(1, '')), 'heuristic', PRIVACY)).toBe(
      'The recording RC1 is not shown in the video. The offline storyboard never uses recordings: write the storyboard yourself (--storyboard) or use --llm to show them.',
    );
    expect(
      unusedScreenshotWarning(
        showing(clip),
        inputs(recording(1, ''), recording(2, ''), recording(3, '')),
        'agent',
        PRIVACY,
      ),
    ).toBe('The recordings RC2, RC3 are not shown in the video.');
  });

  it('counts a recording panel as shown, and names screenshots and recordings together', () => {
    const panel = (kind: 'bullets' | 'recording', recordingId: string | null) => ({
      label: 'After',
      kind,
      codeRef: null,
      bullets: ['It works'],
      terminal: [],
      screenshotId: null,
      recordingId,
      highlights: [],
    });
    const shown = showing({
      type: 'before-after',
      before: panel('bullets', null),
      after: panel('recording', 'RC1'),
      caption: null,
    });
    expect(unusedScreenshotWarning(shown, inputs(recording(1, '')), 'llm', PRIVACY)).toBeNull();
    const both: ContextInputs = {
      ...inputs(recording(1, '')),
      screenshots: [{ id: 'SS1', path: '/x/a.png', caption: '', moment: 'other' }],
    };
    expect(unusedScreenshotWarning(sampleStoryboard(), both, 'llm', PRIVACY)).toBe(
      'The screenshot SS1 is not shown in the video. The recording RC1 is not shown in the video.',
    );
  });

  it('lists a shown recording among the evidence used', () => {
    expect(evidenceUsed(showing(clip))).toContain('RC1');
  });
});

describe('unusedScreenshotWarning masks captions', () => {
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const caption = `Sent to jane.doe@example.com with ${key}`;
  const base = { task: null, notes: null, tests: [], repro: null, logs: [] };
  const screenshots = [{ id: 'SS1', path: '/x/a.png', caption, moment: 'other' as const }];
  const recordings = [
    {
      id: 'RC1',
      path: '/x/a.mp4',
      caption,
      moment: 'other' as const,
      durationSec: 5,
      width: 640,
      height: 360,
      codec: 'h264',
    },
  ];

  it('masks an e-mail address and a secret in the caption of an unused capture', () => {
    for (const kind of ['screenshots', 'recordings'] as const) {
      const inputs: ContextInputs = {
        ...base,
        screenshots: [],
        recordings: [],
        [kind]: kind === 'screenshots' ? screenshots : recordings,
      };
      const warning = unusedScreenshotWarning(sampleStoryboard(), inputs, 'llm', { maskEmails: true }) ?? '';
      expect(warning).toContain('is not shown in the video');
      expect(warning).not.toContain('jane.doe@');
      expect(warning).not.toContain(key);
    }
  });

  it('keeps the e-mail address when e-mail masking is off, and still masks the secret', () => {
    const inputs: ContextInputs = { ...base, screenshots, recordings };
    const warning = unusedScreenshotWarning(sampleStoryboard(), inputs, 'llm', { maskEmails: false }) ?? '';
    expect(warning.split('jane.doe@example.com')).toHaveLength(3);
    expect(warning).not.toContain(key);
  });
});

describe('evidenceUsed', () => {
  const panel = (kind: 'bullets' | 'screenshot', screenshotId: string | null) => ({
    label: 'Before',
    kind,
    codeRef: null,
    bullets: kind === 'bullets' ? ['It failed'] : [],
    terminal: [],
    screenshotId,
  });
  const scene = (id: string, evidence: string[][], visual: unknown) => ({
    id,
    role: 'under-the-hood',
    title: 'A scene',
    narration: evidence.map((ids) => ({ text: 'A line.', evidence: ids })),
    visual,
    visualDescription: 'A picture.',
    transition: 'fade',
    targetSeconds: null,
  });
  const storyboard = {
    version: 1,
    title: 'Retry',
    summary: 'A change.',
    style: 'hybrid',
    language: 'en',
    scenes: [
      scene(
        's1',
        [
          ['TASK', 'F1'],
          ['F1', 'S2'],
        ],
        { type: 'screenshot', screenshotId: 'SS2', caption: null, highlights: [], focus: null },
      ),
      scene('s2', [['F1.H1']], {
        type: 'checklist',
        items: [
          { title: 'Check', detail: 'It', severity: 'low', ref: null, beat: 0, evidence: ['R1', 'TASK'] },
        ],
      }),
      scene('s3', [['S2']], {
        type: 'before-after',
        // A panel that is not a screenshot panel shows no screenshot, whatever id it still holds.
        before: panel('bullets', 'SS9'),
        after: panel('screenshot', 'SS1'),
        caption: null,
      }),
    ],
    reviewChecklist: [
      { title: 'Look', detail: 'Here', severity: 'info', ref: null, evidence: ['NOTES', 'F1'] },
    ],
    uncertainties: [],
  } as unknown as Storyboard;

  it('lists every cited id once, in the order of first use, then the screenshots that are only shown', () => {
    expect(evidenceUsed(storyboard)).toEqual(['TASK', 'F1', 'S2', 'F1.H1', 'R1', 'NOTES', 'SS2', 'SS1']);
  });

  it('names a shown screenshot where it is cited, not a second time', () => {
    const cited = structuredClone(storyboard);
    cited.scenes[0]?.narration[0]?.evidence.unshift('SS2');
    expect(evidenceUsed(cited)).toEqual(['SS2', 'TASK', 'F1', 'S2', 'F1.H1', 'R1', 'NOTES', 'SS1']);
  });
});

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

describe('buildContextInputs: recordings', () => {
  const rec = (name: string, caption = 'Clip', moment: 'before' | 'after' | 'other' = 'other') => ({
    path: join(dir, name),
    caption,
    moment,
  });

  it('does not look for ffprobe unless a recording was supplied', async () => {
    const config = testConfig({ render: { ffprobePath: join(dir, 'no-such-ffprobe') } });
    expect((await buildContextInputs({ task: 'x' }, dir, config)).recordings).toEqual([]);
    await expect(buildContextInputs({ recordings: [rec('a.mp4')] }, dir, config)).rejects.toMatchObject({
      code: 'FFMPEG_NOT_FOUND',
    });
  });

  describe.skipIf(tools === null)('with FFmpeg', () => {
    it('numbers the recordings RC1, RC2 and reads their facts', async (ctx) => {
      const made = [
        await makeClip(tools!.ffmpeg, join(dir, 'a.mp4'), { seconds: 2 }),
        await makeClip(tools!.ffmpeg, join(dir, 'b.mp4'), { seconds: 1, size: '160x120' }),
      ];
      if (made.includes(false)) return ctx.skip('this FFmpeg cannot encode H.264');
      const inputs = await buildContextInputs(
        { recordings: [rec('a.mp4', 'Before', 'before'), rec('b.mp4', 'x'.repeat(300))] },
        dir,
        testConfig(),
      );
      expect(inputs.recordings.map((r) => r.id)).toEqual(['RC1', 'RC2']);
      expect(inputs.recordings[0]).toMatchObject({
        path: join(dir, 'a.mp4'),
        caption: 'Before',
        moment: 'before',
        width: 320,
        height: 240,
        codec: 'h264',
      });
      expect(inputs.recordings[1]).toMatchObject({ moment: 'other', width: 160 });
      expect(inputs.recordings[1]?.caption).toHaveLength(200);
    });

    it('uses the first recordings and warns about the rest', async (ctx) => {
      for (const name of ['a.mp4', 'b.mp4', 'c.mp4'])
        if (!(await makeClip(tools!.ffmpeg, join(dir, name), { seconds: 1 })))
          return ctx.skip('this FFmpeg cannot encode H.264');
      const warnings: string[] = [];
      const inputs = await buildContextInputs(
        { recordings: ['a.mp4', 'b.mp4', 'c.mp4'].map((n) => rec(n)) },
        dir,
        testConfig({ inputs: { maxRecordings: 2 } }),
        (m) => warnings.push(m),
      );
      expect(inputs.recordings.map((r) => r.id)).toEqual(['RC1', 'RC2']);
      expect(warnings).toEqual(['Only the first 2 recordings are used.']);
    });

    it('refuses a clip over the length limit, naming the file', async (ctx) => {
      if (!(await makeClip(tools!.ffmpeg, join(dir, 'long.mp4'), { seconds: 3 })))
        return ctx.skip('this FFmpeg cannot encode H.264');
      await expect(
        buildContextInputs(
          { recordings: [rec('long.mp4')] },
          dir,
          testConfig({ inputs: { maxRecordingSeconds: 1 } }),
        ),
      ).rejects.toMatchObject({
        code: 'USAGE',
        message: expect.stringMatching(/long\.mp4.*3 s long, the limit is 1 s/),
      });
    });

    it('refuses a file that is not a video, whatever its name says', async () => {
      await writeFile(join(dir, 'fake.mp4'), makePng(4, 4));
      await expect(
        buildContextInputs({ recordings: [rec('fake.mp4')] }, dir, testConfig()),
      ).rejects.toMatchObject({
        code: 'USAGE',
        message: expect.stringContaining('fake.mp4'),
      });
    });
  });

  it('refuses a file over the size limit, before it is probed', async () => {
    await writeFile(join(dir, 'big.mp4'), '');
    await truncate(join(dir, 'big.mp4'), 2 * 1024 * 1024);
    const config = testConfig({ inputs: { maxRecordingMb: 1 } });
    // The size check comes first, so this needs no ffprobe unless one is found.
    await expect(buildContextInputs({ recordings: [rec('big.mp4')] }, dir, config)).rejects.toMatchObject({
      code: tools === null ? 'FFMPEG_NOT_FOUND' : 'USAGE',
    });
    if (tools !== null) {
      await expect(buildContextInputs({ recordings: [rec('big.mp4')] }, dir, config)).rejects.toMatchObject({
        message: 'Recording big.mp4 cannot be used: it is 2 MB, the limit is 1 MB.',
      });
    }
  });

  it.skipIf(tools === null)('refuses a missing file and a folder', async () => {
    await expect(
      buildContextInputs({ recordings: [rec('gone.mp4')] }, dir, testConfig()),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: 'Recording gone.mp4 cannot be used: the file was not found.',
    });
    await mkdir(join(dir, 'folder.mp4'));
    await expect(
      buildContextInputs({ recordings: [rec('folder.mp4')] }, dir, testConfig()),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not a regular file'),
    });
  });
});

describe('checkRepro', () => {
  const step = (extra: Record<string, unknown> = {}) => ({
    text: 'Open the page',
    ...extra,
  });
  const valid = { title: 'Basket count is wrong', steps: [step()] };
  const message = (value: unknown): string | null => {
    try {
      checkRepro(value, '--repro-file');
    } catch (err) {
      expect(err).toMatchObject({ code: 'USAGE' });
      return (err as Error).message;
    }
    return null;
  };

  it('keeps what was written and trims the texts', () => {
    expect(
      checkRepro({
        title: '  Basket count  ',
        environment: 'Chrome 130',
        steps: [
          step({ screenshot: 'SS2', result: 'bug' }),
          step({ recording: 'RC1', result: 'fixed' }),
          step(),
        ],
      }),
    ).toEqual({
      title: 'Basket count',
      environment: 'Chrome 130',
      steps: [
        { text: 'Open the page', screenshot: 'SS2', result: 'bug' },
        { text: 'Open the page', recording: 'RC1', result: 'fixed' },
        { text: 'Open the page' },
      ],
    });
    expect(checkRepro(valid)).toEqual(valid);
  });

  it('says what is wrong, and names the step', () => {
    expect(message('text')).toBe('--repro-file: expected a JSON object.');
    expect(message({ steps: valid.steps })).toBe('--repro-file: "title" needs a non-empty text.');
    expect(message({ ...valid, title: '  ' })).toBe('--repro-file: "title" needs a non-empty text.');
    expect(message({ ...valid, title: 'x'.repeat(121) })).toBe(
      '--repro-file: "title" is 121 characters, the limit is 120.',
    );
    expect(message({ ...valid, environment: 'x'.repeat(201) })).toBe(
      '--repro-file: "environment" is 201 characters, the limit is 200.',
    );
    expect(message({ ...valid, extra: 1 })).toBe(
      '--repro-file: unknown field "extra". Allowed: title, environment, steps.',
    );
    expect(message({ title: 'T' })).toBe('--repro-file: "steps" needs a list of 1 to 12 steps.');
    expect(message({ title: 'T', steps: [] })).toBe('--repro-file: "steps" needs a list of 1 to 12 steps.');
    expect(message({ title: 'T', steps: Array.from({ length: 13 }, () => step()) })).toBe(
      '--repro-file: 13 steps is too many (at most 12).',
    );
    expect(message({ title: 'T', steps: [step(), 'text'] })).toBe('--repro-file: step 2 is not an object.');
    expect(message({ title: 'T', steps: [step(), { text: '' }] })).toBe(
      '--repro-file: step 2 "text" needs a non-empty text.',
    );
    expect(message({ title: 'T', steps: [{ text: 5 }] })).toBe(
      '--repro-file: step 1 "text" needs a non-empty text.',
    );
    expect(message({ title: 'T', steps: [step({ text: 'x'.repeat(201) })] })).toBe(
      '--repro-file: step 1 "text" is 201 characters, the limit is 200.',
    );
    expect(message({ title: 'T', steps: [step({ shot: 'SS1' })] })).toBe(
      '--repro-file: step 1 has unknown field "shot". Allowed: text, screenshot, recording, result.',
    );
    expect(
      message({
        title: 'T',
        steps: [step(), step({ screenshot: 'SS1', recording: 'RC1' })],
      }),
    ).toBe('--repro-file: step 2 has both a screenshot and a recording. Use one thumbnail for each step.');
    expect(message({ title: 'T', steps: [step({ result: 'broken' })] })).toBe(
      '--repro-file: step 1 has result "broken". Use one of: expected, actual, bug, fixed.',
    );
    expect(message({ title: 'T', steps: [step({ screenshot: null })] })).toBe(
      '--repro-file: step 1 "screenshot" needs a non-empty text.',
    );
  });
});

describe('buildContextInputs: reproduction', () => {
  const file = (steps: Record<string, unknown>[]) => ({
    title: 'Basket count',
    environment: 'Chrome',
    steps: steps as { text: string }[],
  });

  it('is null without a reproduction', async () => {
    expect((await buildContextInputs({}, dir, testConfig())).repro).toBeNull();
  });

  it('makes the captures known by the ids that were supplied to this command', async () => {
    await writeFile(join(dir, 'a.png'), makePng(4, 4));
    const inputs = await buildContextInputs(
      {
        screenshots: [{ path: 'a.png', caption: 'A', moment: 'before' }],
        repro: file([{ text: 'Open it', screenshot: 'SS1', result: 'bug' }, { text: 'Look' }]),
      },
      dir,
      testConfig(),
    );
    expect(inputs.repro).toEqual({
      title: 'Basket count',
      environment: 'Chrome',
      steps: [
        {
          text: 'Open it',
          screenshotId: 'SS1',
          recordingId: null,
          result: 'bug',
        },
        { text: 'Look', screenshotId: null, recordingId: null, result: null },
      ],
    });
  });

  it('refuses a capture that was not supplied, and names the step', async () => {
    await writeFile(join(dir, 'a.png'), makePng(4, 4));
    const shots = [{ path: 'a.png', caption: 'A', moment: 'before' as const }];
    await expect(
      buildContextInputs(
        {
          screenshots: shots,
          repro: file([{ text: 'Open' }, { text: 'Look', screenshot: 'SS2' }]),
        },
        dir,
        testConfig(),
      ),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message:
        'The reproduction step 2 uses screenshot SS2, which was not supplied to this command (supplied: SS1).',
      hint: expect.stringMatching(/--screenshots-dir.*screenshots\/ folder of the work folder/),
    });
    await expect(
      buildContextInputs({ repro: file([{ text: 'Look', recording: 'RC1' }]) }, dir, testConfig()),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: 'The reproduction step 1 uses recording RC1, which was not supplied to this command.',
      hint: expect.stringContaining('recordings/ folder of the work folder'),
    });
  });

  it('checks the shape again, for a caller that does not use the command line', async () => {
    await expect(
      buildContextInputs({ repro: { title: 'T', steps: [{ text: ' ' }] } }, dir, testConfig()),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: 'repro: step 1 "text" needs a non-empty text.',
    });
  });
});

describe('the captures of a shown reproduction', () => {
  const repro = {
    title: 'T',
    environment: null,
    steps: [
      { text: 'a', screenshotId: 'SS1', recordingId: null, result: null },
      { text: 'b', screenshotId: null, recordingId: 'RC1', result: null },
      { text: 'c', screenshotId: 'SS2', recordingId: null, result: null },
    ],
  };
  const showing = (steps: number[]): Storyboard => {
    const storyboard = sampleStoryboard();
    storyboard.scenes[2]!.visual = {
      type: 'repro',
      steps: steps.map((step) => ({ step, beat: 0 })),
    };
    return storyboard;
  };
  const inputs: ContextInputs = {
    task: null,
    notes: null,
    tests: [],
    screenshots: ['SS1', 'SS2'].map((id) => ({
      id,
      path: '/x/a.png',
      caption: '',
      moment: 'other' as const,
    })),
    recordings: [
      {
        id: 'RC1',
        path: '/x/a.mp4',
        caption: '',
        moment: 'other' as const,
        durationSec: 5,
        width: 640,
        height: 360,
        codec: 'h264',
      },
    ],
    repro,
    logs: [],
  };

  it('count as shown, and only the captures of the shown steps', () => {
    expect(unusedScreenshotWarning(showing([1, 2, 3]), inputs, 'agent', PRIVACY)).toBeNull();
    expect(unusedScreenshotWarning(showing([1]), inputs, 'agent', PRIVACY)).toBe(
      'The screenshot SS2 is not shown in the video. The recording RC1 is not shown in the video.',
    );
  });

  it('are named by evidenceUsed', () => {
    const used = evidenceUsed(showing([2, 3]), repro);
    expect(used).toContain('RC1');
    expect(used).toContain('SS2');
    expect(used).not.toContain('SS1');
    // Without the reproduction nothing is known about the steps.
    expect(evidenceUsed(showing([2, 3]))).not.toContain('RC1');
  });
});

describe('the warning about captures that the offline storyboard leaves out, with a reproduction', () => {
  // The demo: RC1 and SS2 are shown through steps of the reproduction, RC2 and SS1 are not.
  const capture = (id: string) => ({ id, path: `/x/${id}`, caption: '', moment: 'other' as const });
  const inputs = (withRepro: boolean): ContextInputs => ({
    task: null,
    notes: null,
    tests: [],
    screenshots: [capture('SS1'), capture('SS2')],
    recordings: [
      { ...capture('RC1'), durationSec: 5, width: 640, height: 360, codec: 'h264' },
      { ...capture('RC2'), durationSec: 5, width: 640, height: 360, codec: 'h264' },
    ],
    repro: withRepro
      ? {
          title: 'T',
          environment: null,
          steps: [
            { text: 'a', screenshotId: null, recordingId: 'RC1', result: null },
            { text: 'b', screenshotId: 'SS2', recordingId: null, result: null },
          ],
        }
      : null,
    logs: [],
  });
  const showing = (): Storyboard => {
    const storyboard = sampleStoryboard();
    storyboard.scenes[2]!.visual = {
      type: 'repro',
      steps: [
        { step: 1, beat: 0 },
        { step: 2, beat: 0 },
      ],
    };
    return storyboard;
  };

  it('says that the offline storyboard shows the captures that a step names', () => {
    expect(unusedScreenshotWarning(showing(), inputs(true), 'heuristic', PRIVACY)).toBe(
      'The screenshot SS1 is not shown in the video. The offline storyboard shows only the screenshots that a step of the reproduction names: write the storyboard yourself (--storyboard) or use --llm to show the others. ' +
        'The recording RC2 is not shown in the video. The offline storyboard shows only the recordings that a step of the reproduction names: write the storyboard yourself (--storyboard) or use --llm to show the others.',
    );
  });

  it('keeps the old sentence when there is no reproduction', () => {
    const warning = unusedScreenshotWarning(sampleStoryboard(), inputs(false), 'heuristic', PRIVACY);
    expect(warning).toContain('The offline storyboard never uses screenshots');
    expect(warning).toContain('The offline storyboard never uses recordings');
    expect(warning).not.toContain('reproduction');
  });
});

describe('checkRepro: hidden characters', () => {
  const dirty = {
    title: 'Basket \u202eshows\u200b 23',
    environment: 'win\u0000dow\u0007',
    steps: [{ text: 'Open\u202e the basket\u200b page' }],
  };

  it('removes them from the title, the environment and the steps', () => {
    expect(checkRepro(dirty)).toEqual({
      title: 'Basket shows 23',
      environment: 'window',
      steps: [{ text: 'Open the basket page' }],
    });
  });

  it('treats a text that is empty after that as an empty text', () => {
    expect(() => checkRepro({ ...dirty, title: '\u202e\u200b' }, '--repro-file')).toThrow(
      '--repro-file: "title" needs a non-empty text.',
    );
    expect(() => checkRepro({ ...dirty, steps: [{ text: ' \u0007 ' }] }, '--repro-file')).toThrow(
      '--repro-file: step 1 "text" needs a non-empty text.',
    );
  });

  it('gives a plan that holds the clean text', async () => {
    const inputs = await buildContextInputs({ repro: dirty }, dir, testConfig());
    expect(inputs.repro).toMatchObject({
      title: 'Basket shows 23',
      environment: 'window',
      steps: [{ text: 'Open the basket page' }],
    });
  });
});

describe('checkRedactions', () => {
  const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const message = (value: unknown): string | null => {
    try {
      checkRedactions(value);
    } catch (err) {
      expect(err).toMatchObject({ code: 'USAGE' });
      return (err as Error).message;
    }
    return null;
  };

  it('reads regions by id, for a screenshot and a recording alike', () => {
    expect(checkRedactions({ SS2: [region], RC1: [region, region] })).toEqual(
      new Map([
        ['SS2', [region]],
        ['RC1', [region, region]],
      ]),
    );
    expect(checkRedactions({ SS1: [] })).toEqual(new Map([['SS1', []]]));
  });

  it('refuses "from" and "to" with their own message: a region is hidden for the whole clip', () => {
    for (const [value, at, field] of [
      [{ RC1: [{ ...region, from: 1, to: 2 }] }, 'RC1, region 1', 'from'],
      [{ RC2: [region, { ...region, to: 1 }] }, 'RC2, region 2', 'to'],
      [{ SS1: [{ ...region, from: 1 }] }, 'SS1, region 1', 'from'],
    ] as const) {
      expect(message(value)).toBe(
        `Hidden regions: ${at} has "${field}": a region cannot be limited to a part of a clip. Leave out "from" and "to", and the region is hidden for the whole clip.`,
      );
    }
  });

  it('fails on every mistake, naming the id and the entry, and skips nothing', () => {
    const cases: [unknown, string][] = [
      [[], 'expected a JSON object'],
      ['x', 'expected a JSON object'],
      [null, 'expected a JSON object'],
      [{ screen: [region] }, '"screen" is not the id of a screenshot or a recording'],
      [{ SS0: [region] }, '"SS0" is not the id'],
      [{ SS1: region }, 'SS1 needs a list of regions.'],
      [{ SS1: Array.from({ length: 21 }, () => region) }, 'SS1 has 21 regions, the most is 20.'],
      [{ SS1: [region, 'x'] }, 'SS1, region 2 is not an object.'],
      [{ SS1: [{ ...region, z: 1 }] }, 'SS1, region 1 has unknown field "z". Allowed: x, y, w, h.'],
      [{ SS1: [{ x: 0, y: 0, w: 1 }] }, 'SS1, region 1 needs "h" as a number.'],
      [{ SS1: [{ ...region, x: '0.1' }] }, 'SS1, region 1 needs "x" as a number.'],
      [{ SS1: [{ ...region, y: Number.NaN }] }, 'SS1, region 1 needs "y" as a number.'],
      [{ SS1: [{ ...region, w: null }] }, 'SS1, region 1 needs "w" as a number.'],
      [{ SS1: [{ ...region, w: 0 }] }, 'SS1, region 1 needs "w" and "h" above 0.'],
      [{ SS1: [{ ...region, h: -1 }] }, 'SS1, region 1 needs "w" and "h" above 0.'],
    ];
    for (const [value, expected] of cases) {
      expect(message(value), JSON.stringify(value)).toContain(expected);
    }
  });

  it('masks an e-mail address that is used as an id or a field name', () => {
    expect(message({ 'jane.doe@example.com': [] })).not.toContain('jane.doe@');
    expect(message({ SS1: [{ ...region, 'jane.doe@example.com': 1 }] })).not.toContain('jane.doe@');
  });
});

describe('buildContextInputs: regions to hide', () => {
  const shot = (name: string) => ({ path: join(dir, name), caption: 'Page', moment: 'after' as const });
  const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  beforeEach(async () => {
    await writeFile(join(dir, 'a.png'), makePng(4, 4));
    await writeFile(join(dir, 'b.png'), makePng(4, 4));
  });

  it('gives a screenshot its regions, and leaves a screenshot without regions as it was', async () => {
    const inputs = await buildContextInputs(
      { screenshots: [shot('a.png'), shot('b.png')], redact: { SS2: [region] } },
      dir,
      testConfig(),
    );
    expect(inputs.screenshots[0]).not.toHaveProperty('hidden');
    expect(inputs.screenshots[1]?.hidden).toEqual([region]);
    const plain = await buildContextInputs({ screenshots: [shot('a.png')] }, dir, testConfig());
    expect(plain.screenshots[0]).not.toHaveProperty('hidden');
  });

  it('cuts a region that reaches outside the picture to the picture', async () => {
    const inputs = await buildContextInputs(
      {
        screenshots: [shot('a.png')],
        redact: {
          SS1: [
            { x: -0.5, y: 0.8, w: 1, h: 0.5 },
            { x: 0.9, y: 0, w: 5, h: 0.1 },
          ],
        },
      },
      dir,
      testConfig(),
    );
    const [first, second] = inputs.screenshots[0]!.hidden!;
    expect(first).toMatchObject({ x: 0, w: 0.5 });
    expect(first!.y).toBeCloseTo(0.8);
    expect(first!.h).toBeCloseTo(0.2);
    expect(second!.x).toBeCloseTo(0.9);
    expect(second!.w).toBeCloseTo(0.1);
  });

  it('refuses a region with no part inside the picture', async () => {
    for (const bad of [
      { x: 1, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 1.2, w: 0.5, h: 0.5 },
      { x: -0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: -1, w: 0.5, h: 1 },
    ]) {
      await expect(
        buildContextInputs(
          { screenshots: [shot('a.png')], redact: { SS1: [region, bad] } },
          dir,
          testConfig(),
        ),
      ).rejects.toMatchObject({
        code: 'USAGE',
        message: 'Hidden regions: SS1, region 2 has no part inside the picture.',
      });
    }
  });

  it('refuses an id that this run does not have, and one that the limit dropped', async () => {
    await expect(
      buildContextInputs({ screenshots: [shot('a.png')], redact: { SS2: [region] } }, dir, testConfig()),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: 'Hidden regions: SS2 is not a screenshot or recording of this run.',
      hint: expect.stringContaining('This run has: SS1.'),
    });
    await expect(buildContextInputs({ redact: { RC1: [region] } }, dir, testConfig())).rejects.toMatchObject({
      hint: expect.stringContaining('no screenshots or recordings'),
    });
    const seven = Array.from({ length: 7 }, () => shot('a.png'));
    await expect(
      buildContextInputs({ screenshots: seven, redact: { SS7: [region] } }, dir, testConfig(), () => {}),
    ).rejects.toMatchObject({ message: expect.stringContaining('SS7 is not a screenshot or recording') });
  });

  it('refuses a screenshot that is stored turned when it has regions, also when only a reproduction step uses it', async () => {
    // A JPEG with an EXIF orientation of 6 (big endian) right after its first marker.
    const tiff = Buffer.alloc(26);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(6, 18);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(2 + 6 + tiff.length, 2);
    const jpeg = makeJpeg(64, 48);
    await writeFile(
      join(dir, 'turned.jpg'),
      Buffer.concat([jpeg.subarray(0, 2), head, Buffer.from('Exif\0\0', 'latin1'), tiff, jpeg.subarray(2)]),
    );
    const repro = { title: 'Bug', steps: [{ text: 'Open the page', screenshot: 'SS1' }] };
    await expect(
      buildContextInputs(
        { screenshots: [shot('turned.jpg')], repro, redact: { SS1: [region] } },
        dir,
        testConfig(),
      ),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('has hidden regions') });
    // Without a region it is accepted, so the refusal is about the regions.
    const plain = await buildContextInputs({ screenshots: [shot('turned.jpg')], repro }, dir, testConfig());
    expect(plain.screenshots[0]!.hidden).toBeUndefined();
  });

  it('checks the file before it reads any screenshot', async () => {
    await expect(
      buildContextInputs({ screenshots: [shot('missing.png')], redact: { SS1: 'x' } }, dir, testConfig()),
    ).rejects.toMatchObject({ message: expect.stringContaining('Hidden regions: SS1 needs a list') });
  });

  describe.skipIf(tools === null)('recordings', () => {
    const clip = (name: string) => ({ path: join(dir, name), caption: 'Clip', moment: 'before' as const });
    const makeC = async () => {
      if (!(await makeClip(tools!.ffmpeg, join(dir, 'c.mp4'), { seconds: 2 }))) throw new Error('no clip');
    };

    it('gives a recording its regions, cut to the picture, for the whole clip', async () => {
      await makeC();
      const inputs = await buildContextInputs(
        { recordings: [clip('c.mp4')], redact: { RC1: [region, { x: 0.9, y: 0, w: 5, h: 0.1 }] } },
        dir,
        testConfig(),
      );
      const [first, second] = inputs.recordings[0]!.hidden!;
      expect(first).toEqual(region);
      expect(Object.keys(second!)).toEqual(['x', 'y', 'w', 'h']);
      expect(second!.w).toBeCloseTo(0.1);
    });
  });
});

describe('buildContextInputs: logs', () => {
  const log = (path: string, caption = path) => ({ path, caption });
  const read = (path: string, extra: Parameters<typeof buildContextInputs>[0] = {}) =>
    buildContextInputs({ logs: [log(path)], ...extra }, dir, testConfig());

  it('numbers the logs, makes their paths absolute and splits them into lines', async () => {
    await writeFile(join(dir, 'a.log'), 'one\ntwo\nthree\n');
    await writeFile(join(dir, 'b.log'), 'only');
    const inputs = await buildContextInputs(
      { logs: [log('a.log', 'The run'), log('b.log', '')] },
      dir,
      testConfig(),
    );
    expect(inputs.logs).toEqual([
      {
        id: 'L1',
        path: join(dir, 'a.log'),
        caption: 'The run',
        lines: ['one', 'two', 'three'],
      },
      { id: 'L2', path: join(dir, 'b.log'), caption: '', lines: ['only'] },
    ]);
  });

  it('turns line ends into one kind and removes terminal colour and cursor codes', async () => {
    const esc = '\u001b';
    await writeFile(
      join(dir, 'term.log'),
      `﻿${esc}[32mok${esc}[0m first\r\nsecond\rthird ${esc}[2K${esc}]0;title\u0007end\n\nlast`,
    );
    const { logs } = await read('term.log');
    expect(logs[0]?.lines).toEqual(['ok first', 'second', 'third end', '', 'last']);
  });

  it('removes character-set and keypad escapes, and hidden and control characters', async () => {
    const esc = '\u001b';
    await writeFile(
      join(dir, 'odd.log'),
      `${esc}(B${esc}[m tput reset${esc}=${esc}>\nbidi \u202e evil\u200b\u0007\u0008 end\ttab\n`,
    );
    const { logs } = await read('odd.log');
    expect(logs[0]?.lines).toEqual([' tput reset', 'bidi  evil end\ttab']);
  });

  it('refuses a log with nothing to read, like an empty file', async () => {
    await writeFile(join(dir, 'blank.log'), '\n\n\n');
    await writeFile(join(dir, 'codes.log'), '\u001b[0m\n');
    for (const name of ['blank.log', 'codes.log']) {
      await expect(read(name), name).rejects.toThrow(`Log ${name} cannot be used: it is empty.`);
    }
  });

  it('keeps a line as it was read: it is masked where it is shown, not here', async () => {
    const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    await writeFile(join(dir, 'k.log'), `key ${key} for jane.doe@example.com\n`);
    expect((await read('k.log')).logs[0]?.lines).toEqual([`key ${key} for jane.doe@example.com`]);
  });

  it('refuses a log over 256 KB, from its size and before reading it, with the limit', async () => {
    const big = join(dir, 'big.log');
    await writeFile(big, 'x\n');
    await truncate(big, MAX_LOG_BYTES + 1);
    await expect(read('big.log')).rejects.toMatchObject({
      code: 'USAGE',
      message: 'Log big.log cannot be used: it is 257 KB, the limit is 256 KB.',
    });
    await truncate(big, MAX_LOG_BYTES);
    await expect(read('big.log')).rejects.toThrow(/not a text file/);
    // A file far over the limit is refused from its size: reading it is never tried.
    await truncate(big, 3 * 1024 ** 3);
    await expect(read('big.log')).rejects.toThrow(`it is ${3 * 1024 * 1024} KB, the limit is 256 KB`);
  });

  it('refuses a file that is not UTF-8 text, a missing file and an empty one', async () => {
    await writeFile(join(dir, 'nul.log'), Buffer.from('a\0b'));
    await writeFile(join(dir, 'latin.log'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await writeFile(join(dir, 'empty.log'), '');
    for (const name of ['nul.log', 'latin.log']) {
      await expect(read(name), name).rejects.toMatchObject({
        code: 'USAGE',
        message: `Log ${name} cannot be used: it is not a text file.`,
      });
    }
    await expect(read('empty.log')).rejects.toThrow('it is empty');
    await expect(read('missing.log')).rejects.toThrow('the file was not found');
    await expect(read('.')).rejects.toThrow('it is not a regular file');
  });

  it('refuses a line with one very long unbroken string, and names the line', async () => {
    await writeFile(join(dir, 'long.log'), `fine\n${'a'.repeat(1001)}\n`);
    await expect(read('long.log')).rejects.toThrow(
      'Log long.log cannot be used: line 2 has an unbroken string of more than 1000 characters.',
    );
    await writeFile(join(dir, 'ok.log'), `${'a'.repeat(1000)}\n${'a '.repeat(2000)}\n`);
    await expect(read('ok.log')).resolves.toBeDefined();
  });

  it('uses the first 4 logs and warns about the rest', async () => {
    for (const n of [1, 2, 3, 4, 5]) await writeFile(join(dir, `${n}.log`), `line ${n}\n`);
    const warnings: string[] = [];
    const inputs = await buildContextInputs(
      { logs: [1, 2, 3, 4, 5].map((n) => log(`${n}.log`)) },
      dir,
      testConfig(),
      (m) => warnings.push(m),
    );
    expect(inputs.logs.map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(warnings).toEqual(['Only the first 4 logs are used.']);
  });
});

describe('a test result that points at a log', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
  const test = (log?: string | null) => ({
    command: 'npm test',
    passed: true,
    summary: 'ok',
    source: 'agent' as const,
    ...(log === undefined ? {} : { log }),
  });
  const run = (log: string | null | undefined, withLog = true) =>
    buildContextInputs(
      {
        tests: [test(log)],
        ...(withLog ? { logs: [{ path: join(dir, 'a.log'), caption: 'a' }] } : {}),
      },
      dir,
      testConfig(),
    );

  it('keeps a log id that exists, as a range or as the whole log', async () => {
    await writeFile(join(dir, 'a.log'), lines(300));
    expect((await run('L1.120-140')).tests[0]?.log).toBe('L1.120-140');
    expect((await run('L1.7')).tests[0]?.log).toBe('L1.7');
    expect((await run('L1')).tests[0]?.log).toBe('L1');
    expect((await run(null)).tests[0]?.log).toBeNull();
    expect((await run(undefined)).tests[0]?.log).toBeNull();
  });

  it('refuses an id that is not a log of this command, naming the result and the id', async () => {
    await writeFile(join(dir, 'a.log'), lines(300));
    for (const id of ['L2', 'T1', 'F1']) {
      await expect(run(id), id).rejects.toMatchObject({
        code: 'USAGE',
        message: `Test result 1 points at the log "${id}", which is not a log of this command.`,
      });
    }
    for (const id of ['L1.0-3', 'L1.5-4', 'L1.290-301', 'L1.1-201', 'L1.x']) {
      await expect(run(id), id).rejects.toMatchObject({
        code: 'USAGE',
        message: `Test result 1 points at the log "${id}", which is not a valid range of a log of this command.`,
      });
    }
    await expect(run('L1.1-200')).resolves.toBeDefined();
    await expect(run('L1.5-4')).rejects.toMatchObject({
      hint: expect.stringContaining('L1 (300 lines)'),
    });
    await expect(run('L1.1-2', false)).rejects.toMatchObject({
      hint: expect.stringContaining('No log was passed.'),
    });
  });

  it('accepts a "log" in a list of test results only as a string or null', () => {
    expect(checkTestResults([{ command: 'x', passed: true, summary: '', log: 'L1.2-3' }])[0]?.log).toBe(
      'L1.2-3',
    );
    expect(checkTestResults([{ command: 'x', passed: true, summary: '' }])[0]?.log).toBeNull();
    expect(() => checkTestResults([{ command: 'x', passed: true, summary: '', log: 5 }])).toThrow(
      'tests: entry 1 needs "log" to be a log id such as "L1.120-140".',
    );
  });
});

describe('logs in the checks after a run', () => {
  const logs = [{ id: 'L1', path: '/x/run.log', caption: 'Run: "ok"', lines: ['a'] }];
  const inputs = (): ContextInputs => ({
    task: null,
    notes: null,
    tests: [],
    screenshots: [],
    recordings: [],
    repro: null,
    logs,
  });
  const shown = (logId: string) =>
    ({
      ...sampleStoryboard(),
      scenes: [
        {
          ...sampleStoryboard().scenes[0],
          visual: {
            type: 'log',
            logId,
            startLine: 1,
            endLine: 1,
            focus: [],
            caption: null,
          },
        },
      ],
    }) as unknown as Storyboard;

  it('warns about a log that no scene shows, and says why the offline storyboard skips it', () => {
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(), 'llm', PRIVACY)).toBe(
      'The log L1 ("Run: "ok"") is not shown in the video.',
    );
    expect(unusedScreenshotWarning(sampleStoryboard(), inputs(), 'heuristic', PRIVACY)).toContain(
      'The offline storyboard never uses logs',
    );
    expect(unusedScreenshotWarning(shown('L1'), inputs(), 'llm', PRIVACY)).toBeNull();
  });

  it('lists a shown log among the evidence used', () => {
    expect(evidenceUsed(shown('L1'))).toContain('L1');
  });
});

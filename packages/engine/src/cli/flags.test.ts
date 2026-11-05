/** Flags whose values must agree with what the engine can do: lengths, screenshots, and the follow-up commands. */
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateResult } from '../core/types.ts';
import { checkStoryboard, generate, prepareAuthoring, publishRun } from '../pipeline/index.ts';
import { makePng } from '../testing/png.ts';
import { MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import { runCli } from './program.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
  publishRun: vi.fn(),
}));

const generateMock = vi.mocked(generate);
const analyzeMock = vi.mocked(prepareAuthoring);
const validateMock = vi.mocked(checkStoryboard);
const publishMock = vi.mocked(publishRun);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-flags-'));
  for (const mock of [generateMock, analyzeMock, validateMock, publishMock]) mock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { MERGESTORY_HOME: join(dir, 'home') },
    cwd: dir,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

function fakeResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries',
    summary: 's',
    durationSec: 60,
    chapters: [{ title: 'Mission', startSec: 0 }],
    storyboardSource: 'heuristic',
    files: { video: '/runs/r1/video.mp4', poster: 'p', captions: 'c', storyboard: 's', watchPage: 'w' },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
    ...overrides,
  };
}

describe('the length flags', () => {
  it('refuse a value below the real minimum, naming it, and pass the minimum on', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const tooShort = await run(['generate', 'acme/app#1', '--max-duration', '5']);
    expect(tooShort.code).toBe(2);
    expect(tooShort.stderr).toContain('--max-duration');
    expect(tooShort.stderr).toContain('Must be at least 20.');
    const tooShortTarget = await run(['generate', 'acme/app#1', '--duration', '10']);
    expect(tooShortTarget.code).toBe(2);
    expect(tooShortTarget.stderr).toContain('Must be at least 20.');
    expect(generateMock).not.toHaveBeenCalled();

    expect((await run(['generate', 'acme/app#1', '--max-duration', '20', '--duration', '20'])).code).toBe(0);
    expect(generateMock.mock.calls[0]?.[0].config).toMatchObject({
      maxDurationSec: 20,
      targetDurationSec: 20,
    });
  });

  it('refuse a value above the maximum, for generate and validate', async () => {
    const generated = await run(['generate', 'acme/app#1', '--max-duration', '601']);
    expect(generated.code).toBe(2);
    expect(generated.stderr).toContain('Must be at most 600.');
    await writeFile(join(dir, 'storyboard.json'), '{}');
    const validated = await run(['validate', 'storyboard.json', '--max-duration', '5']);
    expect(validated.code).toBe(2);
    expect(validated.stderr).toContain('Must be at least 20.');
    expect(generateMock).not.toHaveBeenCalled();
    expect(validateMock).not.toHaveBeenCalled();
  });

  it('say in the help what the limit keeps, and what it does not', async () => {
    const generateHelp = (await run(['generate', '--help'])).stdout.replace(/\s+/g, ' ');
    expect(generateHelp).toContain('--max-duration <sec>');
    expect(generateHelp).toContain('20-600, default 150');
    expect(generateHelp).toContain('until the estimated length fits');
    expect(generateHelp).toContain('The mission and review scenes always stay');
    expect(generateHelp).toContain('the real voice may run a little over');
    expect(generateHelp).not.toContain('hard cap');
    expect(generateHelp).toContain('20-600');
    expect(generateHelp).toContain('a real screenshot, PNG or JPEG up to 4 MB');

    const validateHelp = (await run(['validate', '--help'])).stdout.replace(/\s+/g, ' ');
    expect(validateHelp).toContain('20-600, default 150');
    expect(validateHelp).toContain('warns when making the video would have to drop scenes');
    expect(validateHelp).not.toContain('hard cap');
  });
});

describe('screenshots', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]),
    Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00]),
    Buffer.from([0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]),
  ]);

  it('are checked the way the video checks them: by content, PNG or JPEG only', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await writeFile(join(dir, 'real.png'), makePng(8, 8));
    // The name says PNG, the bytes say JPEG: the bytes decide, as they do when the video is made.
    await writeFile(join(dir, 'really-a-jpeg.png'), jpeg);
    const accepted = await run([
      'generate',
      'acme/app#1',
      '--screenshot',
      'real.png:Dashboard:after',
      '--screenshot',
      'really-a-jpeg.png',
    ]);
    expect(accepted.code).toBe(0);
    expect(generateMock.mock.calls[0]?.[0].context?.screenshots).toHaveLength(2);

    for (const [name, bytes] of [
      ['fake.webp', Buffer.from('RIFF....WEBPVP8 ')],
      ['animated.gif', Buffer.from('GIF89a......')],
      ['fake.png', Buffer.from('png')],
      ['notes.jpg', Buffer.from('not an image')],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      const refused = await run(['generate', 'acme/app#1', '--screenshot', name]);
      expect(refused.code, name).toBe(2);
      expect(refused.stderr, name).toContain(`${name} is not a PNG or JPEG image`);
    }
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('are limited to the 4 MB that the video can embed, and the message says so', async () => {
    const big = join(dir, 'big.png');
    await writeFile(big, makePng(8, 8));
    await truncate(big, MAX_SCREENSHOT_BYTES + 1);
    const refused = await run(['generate', 'acme/app#1', '--screenshot', 'big.png']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('big.png is 4.1 MB, the limit is 4 MB.');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('are refused at once for a background job, before it is created', async () => {
    await writeFile(join(dir, 'fake.png'), 'png');
    const refused = await run(['generate', 'acme/app#1', '--async', '--screenshot', 'fake.png']);
    expect(refused.code).toBe(2);
    await expect(readdir(join(dir, 'home', 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('analyze: the commands in AUTHORING.md', () => {
  const authoring = {
    runId: 'r3',
    runDir: '/runs/r3',
    files: {
      analysis: '/runs/r3/analysis.json',
      evidence: '/runs/r3/evidence.md',
      guide: '/runs/r3/AUTHORING.md',
      schema: '/runs/r3/storyboard.schema.json',
    },
    summary: {
      title: 'T',
      changeLabel: 'PR #1',
      size: 'm',
      files: 3,
      suggestedDurationSec: 60,
      evidenceItems: 9,
    },
  };

  it('are given the source and every flag that creates evidence ids, with absolute file paths', async () => {
    analyzeMock.mockResolvedValue(authoring);
    await mkdir(join(dir, 'repo'));
    await writeFile(join(dir, 'task.md'), 'Make uploads resilient.');
    await writeFile(join(dir, 'notes.md'), 'Backoff with jitter.');
    await writeFile(
      join(dir, 'tests.json'),
      JSON.stringify([{ command: 'npm test', passed: true, summary: 'ok' }]),
    );
    await writeFile(join(dir, 'after.png'), makePng(8, 8));
    const { code, stdout } = await run([
      'analyze',
      'repo',
      '--base',
      'main',
      '--head',
      'feature/x',
      '--task-file',
      'task.md',
      '--notes-file',
      'notes.md',
      '--tests-file',
      'tests.json',
      '--screenshot',
      'after.png:Dashboard: done:after',
    ]);
    expect(code).toBe(0);
    expect(analyzeMock.mock.calls[0]?.[0].followUp).toEqual({
      source: join(dir, 'repo'),
      args: [
        '--base',
        'main',
        '--head',
        'feature/x',
        '--task-file',
        join(dir, 'task.md'),
        '--notes-file',
        join(dir, 'notes.md'),
        '--tests-file',
        join(dir, 'tests.json'),
        '--screenshot',
        `${join(dir, 'after.png')}:Dashboard: done:after`,
      ],
    });
    // The steps that the terminal prints leave the context out, so the flags are given once more.
    expect(stdout).toContain('Give steps 3 and 4 the same context flags');
    expect(stdout).toContain(`--task-file ${join(dir, 'task.md')} --notes-file ${join(dir, 'notes.md')}`);
    expect(stdout).toContain(`--screenshot '${join(dir, 'after.png')}:Dashboard: done:after'`);
  });

  it('are given an inline task as it was typed, and nothing else when no flag was used', async () => {
    analyzeMock.mockResolvedValue(authoring);
    await run(['analyze', 'acme/app#42', '--task', 'Add retries']);
    expect(analyzeMock.mock.calls[0]?.[0].followUp).toEqual({
      source: 'acme/app#42',
      args: ['--task', 'Add retries'],
    });
    const plain = await run(['analyze', 'acme/app#42']);
    expect(analyzeMock.mock.calls[1]?.[0].followUp).toEqual({ source: 'acme/app#42', args: [] });
    expect(plain.stdout).not.toContain('Give steps 3 and 4');
  });

  it('are printed with an inline task that starts with # in quotes, so a shell keeps it', async () => {
    analyzeMock.mockResolvedValue(authoring);
    const { stdout } = await run(['analyze', 'acme/app#42', '--task', '#42']);
    expect(analyzeMock.mock.calls[0]?.[0].followUp).toEqual({
      source: 'acme/app#42',
      args: ['--task', '#42'],
    });
    expect(stdout).toContain("--task '#42'");
    expect(stdout).not.toMatch(/--task #42/);
  });
});

describe('a pull request update that did not happen', () => {
  const published = {
    provider: 's3',
    watchUrl: 'https://videos.example.com/v/abc/index.html',
    videoUrl: 'https://videos.example.com/v/abc/video.mp4',
    posterUrl: null,
    captionsUrl: null,
    expiresAt: null,
    visibility: 'protected' as const,
    location: 's3://media/v/abc/',
  };

  it('keeps the link and the warning, and sets exit code 5, for generate and publish', async () => {
    const result = fakeResult({
      publish: published,
      notify: { commentUrl: null, descriptionUpdated: false },
      warnings: ['The pull request was not updated: Could not write to GitHub.'],
    });
    generateMock.mockResolvedValue(result);
    publishMock.mockResolvedValue(result);

    const generated = await run(['generate', 'acme/app#1', '--comment']);
    expect(generated.code).toBe(5);
    expect(generated.stdout).toContain('https://videos.example.com/v/abc/index.html');
    expect(generated.stdout).toContain('The pull request was not updated');

    const json = await run(['generate', 'acme/app#1', '--comment', '--json']);
    expect(json.code).toBe(5);
    expect(JSON.parse(json.stdout).publish.watchUrl).toBe(published.watchUrl);

    const republished = await run(['publish', 'r1', '--publish', 's3', '--comment']);
    expect(republished.code).toBe(5);
    expect(republished.stdout).toContain('https://videos.example.com/v/abc/index.html');
  });

  it('exits 0 when the update worked, was skipped on purpose, or was not asked for', async () => {
    for (const notify of [
      { commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-1', descriptionUpdated: false },
      { commentUrl: null, descriptionUpdated: true },
      null,
    ]) {
      generateMock.mockResolvedValue(fakeResult({ publish: published, notify }));
      expect((await run(['generate', 'acme/app#1'])).code).toBe(0);
    }
  });
});

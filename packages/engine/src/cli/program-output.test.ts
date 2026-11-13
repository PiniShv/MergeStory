import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { dir, fakePlan, fakeResult, generateMock, lastGenerateOptions, run } from '../testing/cli.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

describe('generate: --storyboard', () => {
  it('passes the parsed storyboard on', async () => {
    await writeFile(join(dir, 'storyboard.json'), JSON.stringify({ version: 1, scenes: [] }));
    generateMock.mockResolvedValue(fakeResult({ storyboardSource: 'agent' }));
    const result = await run(['generate', 'acme/app#1', '--storyboard', 'storyboard.json']);
    expect(result.code).toBe(0);
    expect(lastGenerateOptions().storyboard).toEqual({ version: 1, scenes: [] });
  });

  it('exits 3 for a file that is not a storyboard', async () => {
    await writeFile(join(dir, 'bad.json'), '{oops');
    const bad = await run(['generate', '--storyboard', 'bad.json']);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('error [STORYBOARD_INVALID]');
    await writeFile(join(dir, 'list.json'), '[1,2]');
    const list = await run(['generate', '--storyboard', 'list.json']);
    expect(list.code).toBe(3);
    expect(list.stderr).toContain('must contain a JSON object');
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('generate: output', () => {
  it('prints a short human summary', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code, stdout, stderr } = await run(['generate', 'acme/app#1']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Video ready: Add retries to the uploader');
    expect(stdout).toContain('/runs/r1/video.mp4');
    expect(stdout).toContain('1:23');
    expect(stdout).toContain('0:00  The mission');
    expect(stdout).toContain('0:31  Under the hood');
    expect(stdout).toContain(
      '$0.0042 (LLM $0.0040, speech $0.0002), estimated from list prices, budget $0.25',
    );
    expect(stdout).toContain('api.anthropic.com: storyboard, 40 KB (diff, pr-metadata)');
    expect(stdout).toContain('9 narration lines cite evidence, 1 automatic fix');
    expect(stdout).toContain('2 files were too large to show');
  });

  it('says plainly when nothing left the machine', async () => {
    generateMock.mockResolvedValue(
      fakeResult({ egress: [], cost: { totalUsd: 0, budgetUsd: 0.25, records: [] }, warnings: [] }),
    );
    const { stdout } = await run(['generate', 'acme/app#1']);
    expect(stdout).toContain('nothing left this machine');
    expect(stdout).toContain('$0.0000 (LLM $0.0000, speech $0.0000), budget $0.25');
    expect(stdout).not.toContain('Warnings');
  });

  it('shows where the video was published', async () => {
    generateMock.mockResolvedValue(
      fakeResult({
        publish: {
          provider: 's3',
          watchUrl: 'https://files.example.com/v/abc/index.html?X-Amz-Signature=0123456789abcdef',
          videoUrl: 'https://files.example.com/v/abc/video.mp4?X-Amz-Signature=0123456789abcdef',
          posterUrl: null,
          captionsUrl: null,
          expiresAt: '2026-11-10T00:00:00Z',
          visibility: 'private',
          location: 's3://bucket/prefix/',
        },
        notify: { commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-1', descriptionUpdated: true },
      }),
    );
    const { stdout } = await run(['generate', 'acme/app#1']);
    expect(stdout).toContain('index.html?X-Amz-Signature=0123456789abcdef');
    expect(stdout).toContain('private, link expires 2026-11-10T00:00:00Z');
    expect(stdout).toContain(
      'comment https://github.com/acme/app/pull/1#issuecomment-1, description updated',
    );
  });

  it('prints the plan for a dry run', async () => {
    generateMock.mockResolvedValue(fakePlan());
    const { code, stdout } = await run(['generate', 'acme/app#1', '--dry-run']);
    expect(code).toBe(0);
    expect(stdout).toContain('Dry run: Add retries to the uploader');
    expect(stdout).toContain('Nothing was sent, rendered or published.');
    expect(stdout).toContain('about 1:15');
    expect(stdout).toContain('LLM none, speech say, publish local');
    expect(stdout).toContain('Est. cost (high estimate)');
    expect(stdout).toContain('Scenes (2)');
    expect(stdout).toContain('1. The mission');
    expect(stdout).toContain('2. Retry loop');
    expect(stdout).toContain('nothing would leave this machine');
    expect(stdout).toContain('No LLM configured');
    expect(stdout).toContain('Run again without --dry-run');
  });

  it('prints exactly one JSON document with --json', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code, stdout, stderr } = await run(['generate', 'acme/app#1', '--json']);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual(fakeResult());
    expect(stderr).toBe('');
  });

  it('keeps logs on stderr, away from the JSON', async () => {
    generateMock.mockImplementation(async (options) => {
      options.logger?.info('Reading the change');
      return fakeResult();
    });
    const { stdout, stderr } = await run(['generate', 'acme/app#1', '--json']);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('Reading the change');
    expect(stdout).not.toContain('Reading the change');
  });

  it('redacts secrets in the result, but keeps signed links working', async () => {
    const key = `sk-ant-${'Ab3De5Gh7Jk9Mn1P'.repeat(2)}`;
    const link =
      'https://files.example.com/v/abc/video.mp4?X-Amz-Signature=0123456789abcdef&X-Amz-Expires=3600';
    generateMock.mockResolvedValue(
      fakeResult({
        title: `Rotate ${key}`,
        warnings: [`saw ${key}`],
        publish: {
          provider: 's3',
          watchUrl: null,
          videoUrl: link,
          posterUrl: null,
          captionsUrl: null,
          expiresAt: null,
          visibility: 'private',
          location: 's3://b/p/',
        },
      }),
    );
    const json = await run(['generate', 'acme/app#1', '--json']);
    expect(json.stdout).not.toContain(key);
    expect(JSON.parse(json.stdout).publish.videoUrl).toBe(link);
    const human = await run(['generate', 'acme/app#1']);
    expect(human.stdout).not.toContain(key);
    expect(human.stdout).toContain('X-Amz-Signature=0123456789abcdef');
  });

  it('logs at the requested level and format', async () => {
    generateMock.mockImplementation(async (options) => {
      options.logger?.debug('detail');
      options.logger?.info('step');
      return fakeResult();
    });
    const quiet = await run(['generate', 'acme/app#1', '-q']);
    expect(quiet.stderr).toBe('');
    expect(lastGenerateOptions().logger?.level).toBe('error');
    const debug = await run(['generate', 'acme/app#1', '--log-level', 'debug']);
    expect(debug.stderr).toContain('detail');
    const json = await run(['generate', 'acme/app#1', '--log-format', 'json']);
    expect(JSON.parse(json.stderr.trim().split('\n')[0] as string)).toMatchObject({
      level: 'info',
      msg: 'step',
    });
    const silent = await run(['generate', 'acme/app#1', '--log-level', 'silent']);
    expect(silent.stderr).toBe('');
  });
});

describe('generate: errors and exit codes', () => {
  it('prints "error [CODE]: message" and a hint on stderr, and exits with the code of the error', async () => {
    generateMock.mockRejectedValue(
      new MergeStoryError('BUDGET_EXCEEDED', 'Speech would cost $0.50.', {
        hint: 'Raise the limit with --budget.',
      }),
    );
    const { code, stdout, stderr } = await run(['generate', 'acme/app#1']);
    expect(code).toBe(4);
    expect(stdout).toBe('');
    expect(stderr).toContain('error [BUDGET_EXCEEDED]: Speech would cost $0.50.');
    expect(stderr).toContain('hint: Raise the limit with --budget.');
  });

  it('uses the exit code table for each kind of failure', async () => {
    const cases: [ConstructorParameters<typeof MergeStoryError>[0], number][] = [
      ['CONFIG_INVALID', 2],
      ['STORYBOARD_INVALID', 3],
      ['BUDGET_EXCEEDED', 4],
      ['LLM_FAILED', 5],
      ['FFMPEG_NOT_FOUND', 6],
      ['PRIVACY_BLOCKED', 7],
      ['RENDER_FAILED', 1],
    ];
    for (const [errorCode, exit] of cases) {
      generateMock.mockRejectedValue(new MergeStoryError(errorCode, 'failed'));
      expect((await run(['generate', 'acme/app#1'])).code, errorCode).toBe(exit);
    }
  });

  it('prints {"ok":false,...} on stdout with --json', async () => {
    generateMock.mockRejectedValue(
      new MergeStoryError('GITHUB_AUTH', 'Bad credentials.', {
        hint: 'Set GITHUB_TOKEN.',
        details: { status: 401 },
      }),
    );
    const { code, stdout, stderr } = await run(['generate', 'acme/app#1', '--json']);
    expect(code).toBe(5);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: {
        code: 'GITHUB_AUTH',
        message: 'Bad credentials.',
        hint: 'Set GITHUB_TOKEN.',
        details: { status: 401 },
      },
    });
    expect(stderr).toBe('');
  });

  it('treats an unexpected error as INTERNAL and shows the stack only in debug mode', async () => {
    generateMock.mockRejectedValue(new TypeError('boom'));
    const plain = await run(['generate', 'acme/app#1']);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain('error [INTERNAL]: boom');
    expect(plain.stderr).toContain('--log-level debug');
    expect(plain.stderr).not.toContain('at ');
    const debug = await run(['generate', 'acme/app#1', '--log-level', 'debug']);
    expect(debug.stderr).toContain('TypeError: boom');
    expect(debug.stderr).toMatch(/\n\s+at /);
  });

  it('never prints a secret that ended up in an error message', async () => {
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    generateMock.mockRejectedValue(
      new MergeStoryError('LLM_FAILED', `401 for key ${key}`, { hint: `check ${key}` }),
    );
    const human = await run(['generate', 'acme/app#1']);
    expect(human.stderr).not.toContain(key);
    const json = await run(['generate', 'acme/app#1', '--json']);
    expect(json.stdout).not.toContain(key);
  });

  it('exits 130 when the run is cancelled', async () => {
    generateMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
    const { code, stderr } = await run(['generate', 'acme/app#1']);
    expect(code).toBe(130);
    expect(stderr).toContain('error [ABORTED]');
  });
});

describe('usage errors', () => {
  it('exits 2 for an unknown option, command or missing argument', async () => {
    const option = await run(['generate', '--bogus']);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('error [USAGE]: unknown option');
    expect(option.stderr).toContain('hint:');
    const command = await run(['frobnicate']);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain("unknown command 'frobnicate'");
    const missing = await run(['validate']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('missing required argument');
    const extra = await run(['schema', 'extra']);
    expect(extra.code).toBe(2);
  });

  it('prints the usage error as JSON too with --json', async () => {
    const { code, stdout } = await run(['generate', '--bogus', '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });

  it('exits 2 and shows the help when no command is given', async () => {
    const { code, stderr } = await run([]);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage: mergestory');
  });

  it('prints one JSON error and no help when --json is given without a command', async () => {
    for (const argv of [['--json'], ['--log-level', 'debug', '--json'], ['--json', '--quiet']]) {
      const { code, stdout, stderr } = await run(argv);
      expect(code, argv.join(' ')).toBe(2);
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
      expect(stderr).not.toContain('Usage:');
    }
    // Help and the version are still help and the version.
    const help = await run(['--json', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: mergestory');
  });

  it('prints the version and the help on stdout and exits 0', async () => {
    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const command of [
      'generate',
      'analyze',
      'validate',
      'schema',
      'doctor',
      'setup',
      'status',
      'jobs',
      'serve',
      'cache',
    ]) {
      expect(help.stdout, command).toContain(command);
    }
    expect(help.stdout).not.toContain('worker');
    const sub = await run(['generate', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--dry-run');
    expect(sub.stdout).toContain('--json');
  });
});

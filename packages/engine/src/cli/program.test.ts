import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dir, fakePlan, fakeResult, generateMock, lastGenerateOptions, run } from '../testing/cli.ts';
import { makePng } from '../testing/png.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

describe('generate: flags become GenerateOptions', () => {
  it('uses the current directory and sets nothing else by default', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run(['generate']);
    expect(code).toBe(0);
    const options = lastGenerateOptions();
    expect(options.source).toBe(dir);
    expect(options.config).toBeUndefined();
    expect(options.context).toBeUndefined();
    expect(options.base).toBeUndefined();
    expect(options.head).toBeUndefined();
    expect(options.dryRun).toBeUndefined();
    expect(options.storyboard).toBeUndefined();
    expect(options.configPath).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.logger).toBeDefined();
  });

  it('leaves a pull request reference exactly as typed', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['generate', 'acme/app#42']);
    expect(lastGenerateOptions().source).toBe('acme/app#42');
    await run(['generate', 'https://github.com/acme/app/pull/42']);
    expect(lastGenerateOptions().source).toBe('https://github.com/acme/app/pull/42');
  });

  it('makes an existing local directory absolute', async () => {
    await mkdir(join(dir, 'work', 'repo'), { recursive: true });
    generateMock.mockResolvedValue(fakeResult());
    await run(['generate', 'work/repo', '--base', 'main', '--head', 'feature/x']);
    const options = lastGenerateOptions();
    expect(options.source).toBe(join(dir, 'work', 'repo'));
    expect(options.base).toBe('main');
    expect(options.head).toBe('feature/x');
  });

  it('maps every config flag to the matching setting', async () => {
    await writeFile(join(dir, 'music.mp3'), 'x');
    generateMock.mockResolvedValue(fakePlan());
    const { code } = await run([
      'generate',
      'acme/app#42',
      '--style',
      'product',
      '--quality',
      'draft',
      '--max-duration',
      '90',
      '--duration',
      '60',
      '--language',
      'de',
      '--theme',
      'light',
      '--llm',
      'anthropic',
      '--model',
      'claude-haiku-5-5',
      '--llm-base-url',
      'http://localhost:11434/v1',
      '--tts',
      'say',
      '--voice',
      'Samantha',
      '--publish',
      's3',
      '--visibility',
      'public',
      '--comment',
      '--update-description',
      '--budget',
      '0.1',
      '--out',
      'out',
      '--no-cache',
      '--no-captions',
      '--music',
      'music.mp3',
      '--dry-run',
    ]);
    expect(code).toBe(0);
    const options = lastGenerateOptions();
    expect(options.config).toEqual({
      style: 'product',
      quality: 'draft',
      maxDurationSec: 90,
      targetDurationSec: 60,
      language: 'de',
      theme: 'light',
      budgetUsd: 0.1,
      captions: false,
      outDir: resolve(dir, 'out'),
      llm: { provider: 'anthropic', model: 'claude-haiku-5-5', baseUrl: 'http://localhost:11434/v1' },
      tts: { provider: 'say', voice: 'Samantha' },
      publish: { provider: 's3', visibility: 'public' },
      github: { comment: true, updateDescription: true },
      cache: { enabled: false },
      render: { musicPath: join(dir, 'music.mp3') },
    });
    expect(options.dryRun).toBe(true);
    expect(options.configPath).toBeUndefined();
  });

  it('does not switch anything on or off that was not asked for', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['generate', 'acme/app#1', '--style', 'technical']);
    const config = lastGenerateOptions().config as Record<string, unknown>;
    expect(config).toEqual({ style: 'technical' });
  });

  it('accepts flags before and after the source, and global flags after the command', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code, stdout } = await run(['generate', '--style', 'product', 'acme/app#1', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).title).toBe('Add retries to the uploader');
  });

  it('refuses refs and sources that could be read as options', async () => {
    const ref = await run(['generate', '--base=--upload-pack=touch x']);
    expect(ref.code).toBe(2);
    expect(ref.stderr).toContain('error [USAGE]');
    expect(ref.stderr).toContain('--base');
    const space = await run(['generate', '--head', 'two words']);
    expect(space.code).toBe(2);
    const source = await run(['generate', '--', '-rf']);
    expect(source.code).toBe(2);
    expect(source.stderr).toContain('not a valid source');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses credentials in the LLM base URL', async () => {
    for (const url of ['https://user:pass@example.com/v1', 'ftp://example.com', 'not a url']) {
      const result = await run(['generate', '--llm-base-url', url]);
      expect(result.code, url).toBe(2);
      expect(result.stderr).not.toContain('pass@');
    }
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('takes only an address on this machine in --llm-base-url', async () => {
    for (const url of ['https://example.com/v1', 'http://10.0.0.5:11434/v1', 'http://app.localhost/v1']) {
      const result = await run(['generate', '--llm-base-url', url]);
      expect(result.code, url).toBe(2);
      expect(result.stderr).toContain('only takes an address on this machine');
    }
    expect(generateMock).not.toHaveBeenCalled();
    generateMock.mockResolvedValue(fakeResult());
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      expect((await run(['generate', '--llm-base-url', url])).code, url).toBe(0);
      expect(lastGenerateOptions().config?.llm?.baseUrl).toBe(url);
    }
  });

  it('keeps any host for the LLM base URL from the environment', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run(['generate'], { MERGESTORY_LLM_BASE_URL: 'https://llm.example.com/v1' });
    expect(code).toBe(0);
  });

  it('refuses an --out folder inside the repository being explained', async () => {
    await mkdir(join(dir, 'repo'));
    const result = await run(['generate', 'repo', '--out', 'repo/videos']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('inside the repository');
    expect(generateMock).not.toHaveBeenCalled();
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['generate', 'repo', '--out', 'videos'])).code).toBe(0);
  });

  it('rejects numbers that are not numbers, and unknown choices', async () => {
    expect((await run(['generate', '--budget', 'lots'])).code).toBe(2);
    expect((await run(['generate', '--max-duration', '1.5'])).code).toBe(2);
    expect((await run(['generate', '--style', 'fancy'])).code).toBe(2);
    expect((await run(['generate', '--tts', 'azure'])).code).toBe(2);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('generate: context files', () => {
  it('reads task, notes, tests and screenshots', async () => {
    await writeFile(join(dir, 'task.md'), 'Make uploads resilient.\n');
    await writeFile(join(dir, 'notes.md'), 'Backoff with jitter, capped at 20 seconds.');
    await writeFile(
      join(dir, 'tests.json'),
      JSON.stringify([
        { command: 'npm test', passed: true, summary: '42 passed' },
        { command: 'npm run lint', passed: false, summary: '1 error', source: 'ci' },
      ]),
    );
    await writeFile(join(dir, 'before.png'), makePng(8, 8));
    await writeFile(join(dir, 'after.png'), makePng(8, 8));
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run([
      'generate',
      'acme/app#1',
      '--task-file',
      'task.md',
      '--notes-file',
      'notes.md',
      '--tests-file',
      'tests.json',
      '--screenshot',
      'before.png:Login page:before',
      '--screenshot',
      'after.png:Login page: with error:after',
    ]);
    expect(code).toBe(0);
    expect(lastGenerateOptions().context).toEqual({
      task: 'Make uploads resilient.\n',
      notes: 'Backoff with jitter, capped at 20 seconds.',
      tests: [
        { command: 'npm test', passed: true, summary: '42 passed', source: 'agent' },
        { command: 'npm run lint', passed: false, summary: '1 error', source: 'ci' },
      ],
      screenshots: [
        { path: join(dir, 'before.png'), caption: 'Login page', moment: 'before' },
        { path: join(dir, 'after.png'), caption: 'Login page: with error', moment: 'after' },
      ],
    });
  });

  it('takes the task from --task', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['generate', 'acme/app#1', '--task', 'Fix the flaky upload']);
    expect(lastGenerateOptions().context).toEqual({ task: 'Fix the flaky upload' });
  });

  it('refuses --task together with --task-file', async () => {
    await writeFile(join(dir, 't.md'), 'x');
    const result = await run(['generate', '--task', 'a', '--task-file', 't.md']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('either --task or --task-file');
  });

  it('enforces the size limits and names the file and the limit', async () => {
    await writeFile(join(dir, 'big-task.md'), 'x'.repeat(64 * 1024 + 1));
    await writeFile(join(dir, 'big-notes.md'), 'y'.repeat(70 * 1024));
    await writeFile(join(dir, 'big-tests.json'), `[${' '.repeat(256 * 1024)}]`);
    await writeFile(join(dir, 'big-storyboard.json'), `{"x": "${'z'.repeat(1024 * 1024)}"}`);
    for (const [flag, file, label, limit] of [
      ['--task-file', 'big-task.md', '--task-file', '64 KB'],
      ['--notes-file', 'big-notes.md', '--notes-file', '64 KB'],
      ['--tests-file', 'big-tests.json', '--tests-file', '256 KB'],
      ['--storyboard', 'big-storyboard.json', '--storyboard', '1 MB'],
    ] as const) {
      const result = await run(['generate', 'acme/app#1', flag, file]);
      expect(result.code, flag).toBe(2);
      expect(result.stderr, flag).toContain(`${label}: ${file}`);
      expect(result.stderr, flag).toContain(`the limit is ${limit}`);
    }
    const task = await run(['generate', '--task', 'x'.repeat(64 * 1024 + 1)]);
    expect(task.code).toBe(2);
    expect(task.stderr).toContain('--task is');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the limit', async () => {
    // Words, not one long string: a long unbroken string is refused for another reason.
    await writeFile(join(dir, 'task.md'), `${'ab '.repeat(21_845)}a`);
    expect((await stat(join(dir, 'task.md'))).size).toBe(64 * 1024);
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['generate', 'acme/app#1', '--task-file', 'task.md'])).code).toBe(0);
  });

  it('explains a missing file and a directory', async () => {
    const missing = await run(['generate', '--notes-file', 'nope.md']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--notes-file: file not found: nope.md');
    await mkdir(join(dir, 'a-folder'));
    const folder = await run(['generate', '--notes-file', 'a-folder']);
    expect(folder.code).toBe(2);
    expect(folder.stderr).toMatch(/directory|regular file/);
  });

  it('refuses files that look like credentials', async () => {
    await writeFile(join(dir, '.env'), 'API_KEY=abc');
    const result = await run(['generate', '--notes-file', '.env']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('credentials file');
    expect(result.stderr).not.toContain('abc');
  });

  it('refuses binary files', async () => {
    await writeFile(join(dir, 'notes.bin'), Buffer.from([0x68, 0x00, 0x69]));
    const result = await run(['generate', '--notes-file', 'notes.bin']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not a text file');
  });

  it('is strict about the shape of --tests-file', async () => {
    const cases: [unknown, RegExp][] = [
      [{ command: 'x' }, /JSON array/],
      [[{ command: 'x', pass: true, summary: '' }], /unknown field "pass"/],
      [[{ command: 'x', summary: 's' }], /"passed"/],
      [[{ passed: true, summary: 's' }], /"command"/],
      [[{ command: 'x', passed: true }], /"summary"/],
      [[{ command: 'x', passed: 'yes', summary: 's' }], /"passed"/],
      [[{ command: 'x', passed: true, summary: 's', source: 'robot' }], /source "robot"/],
      [['npm test'], /not an object/],
    ];
    for (const [value, pattern] of cases) {
      await writeFile(join(dir, 'tests.json'), JSON.stringify(value));
      const result = await run(['generate', 'acme/app#1', '--tests-file', 'tests.json']);
      expect(result.code, JSON.stringify(value)).toBe(2);
      expect(result.stderr, JSON.stringify(value)).toMatch(pattern);
    }
    await writeFile(join(dir, 'tests.json'), '{broken');
    const broken = await run(['generate', 'acme/app#1', '--tests-file', 'tests.json']);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain('not valid JSON');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('checks screenshot files', async () => {
    const missing = await run(['generate', '--screenshot', 'none.png']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('file not found: none.png');
    await writeFile(join(dir, 'notes.txt'), 'x');
    const notImage = await run(['generate', '--screenshot', 'notes.txt']);
    expect(notImage.code).toBe(2);
    expect(notImage.stderr).toContain('not a PNG');
    const empty = await run(['generate', '--screenshot', ':caption']);
    expect(empty.code).toBe(2);
  });

  it('refuses a text with a very long unbroken string, which the secret scan could not handle quickly', async () => {
    await writeFile(join(dir, 'notes.md'), `Here is a blob: ${'a.'.repeat(600)} and more.`);
    const result = await run(['generate', 'acme/app#1', '--notes-file', 'notes.md']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('The notes contains an unbroken string of more than 1000 characters');
    expect(generateMock).not.toHaveBeenCalled();
    const task = await run(['generate', 'acme/app#1', '--task', 'x'.repeat(1001)]);
    expect(task.code).toBe(2);
    expect(task.stderr).toContain('The task contains');
    await writeFile(join(dir, 'ok.md'), `${'a'.repeat(1000)} is fine`);
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['generate', 'acme/app#1', '--notes-file', 'ok.md'])).code).toBe(0);
  });

  it('masks secret-like values in the context and says so', async () => {
    const key = `sk-ant-${'Ab3De5Gh7Jk9Mn1P'.repeat(2)}`;
    await writeFile(join(dir, 'notes.md'), `Calls the API with ${key} and retries.`);
    generateMock.mockResolvedValue(fakeResult());
    const result = await run([
      'generate',
      'acme/app#1',
      '--notes-file',
      'notes.md',
      '--task',
      `token ${key}`,
    ]);
    expect(result.code).toBe(0);
    const context = lastGenerateOptions().context;
    expect(JSON.stringify(context)).not.toContain(key);
    expect(context?.notes).toContain('retries');
    expect(result.stderr).toMatch(/Masked 2 secret-like value/);
    expect(result.stderr).not.toContain(key);
  });
});

describe('the removed --config option', () => {
  it.each([['--config', 'my.json'], ['--config=my.json']])(
    'explains the replacement for %s',
    async (...words) => {
      const { code, stderr } = await run(['generate', ...words]);
      expect(code).toBe(2);
      expect(stderr).toContain('removed in 1.1.0');
      expect(stderr).toContain('MERGESTORY_CONFIG');
      expect(generateMock).not.toHaveBeenCalled();
    },
  );

  it('prints the usual JSON error with --json', async () => {
    const { code, stdout } = await run(['--json', '--config', 'my.json', 'doctor']);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: {
        code: 'USAGE',
        message: 'The --config option was removed in 1.1.0.',
        hint: 'Set MERGESTORY_CONFIG=<file> instead, or put the file at ~/.mergestory/config.json.',
        details: null,
      },
    });
  });
});

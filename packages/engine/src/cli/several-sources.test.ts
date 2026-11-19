/** The --source flag: its forms, its errors, and what the commands that follow it repeat. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectSourceInput } from '../sources/index.ts';
import {
  analyzeMock,
  dir,
  fakeResult,
  generateMock,
  lastGenerateOptions,
  run,
  validateMock,
} from '../testing/cli.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

async function folders(...names: string[]): Promise<void> {
  for (const name of names) await mkdir(join(dir, name), { recursive: true });
}

const refused = async (argv: string[], message: RegExp): Promise<void> => {
  const { code, stderr } = await run(argv);
  expect(code, argv.join(' ')).toBe(2);
  expect(stderr).toMatch(message);
  expect(generateMock).not.toHaveBeenCalled();
  expect(analyzeMock).not.toHaveBeenCalled();
  expect(validateMock).not.toHaveBeenCalled();
};

describe('--source', () => {
  it('gives every source to the pipeline, with its own range', async () => {
    await folders('api', 'web');
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run([
      'generate',
      '--source',
      'api:main..fix/x',
      '--source',
      'web',
      '--source',
      'acme/app#7',
    ]);
    expect(code).toBe(0);
    const options = lastGenerateOptions();
    expect(options.sources).toEqual([
      { kind: 'local', repoPath: join(dir, 'api'), base: 'main', head: 'fix/x' },
      { kind: 'local', repoPath: join(dir, 'web'), base: null, head: null },
      { kind: 'github', url: 'https://github.com/acme/app/pull/7' },
    ]);
    expect(options.source).toEqual(options.sources?.[0]);
    expect(options.base).toBeUndefined();
  });

  it('takes a missing side of a range as the default', async () => {
    await folders('api', 'web');
    await run(['generate', '--source', 'api:main..', '--source', 'web:..fix/x']);
    expect(lastGenerateOptions().sources).toEqual([
      { kind: 'local', repoPath: join(dir, 'api'), base: 'main', head: null },
      { kind: 'local', repoPath: join(dir, 'web'), base: null, head: 'fix/x' },
    ]);
  });

  it('never takes a URL for a range', async () => {
    await folders('api');
    await run(['generate', '--source', 'https://github.com/acme/app/pull/7', '--source', 'api']);
    expect(lastGenerateOptions().sources?.[0]).toEqual({
      kind: 'github',
      url: 'https://github.com/acme/app/pull/7',
    });
  });

  it('with one --source is the positional form', async () => {
    await folders('api');
    await run(['generate', '--source', 'api']);
    const one = lastGenerateOptions();
    expect(one.sources).toBeUndefined();
    expect(one.source).toEqual(detectSourceInput('api', { cwd: dir }));
    await run(['generate', 'api']);
    expect(detectSourceInput(lastGenerateOptions().source as string, { cwd: dir })).toEqual(one.source);
    await run(['generate', '--source', 'api:main..x']);
    expect(lastGenerateOptions().source).toEqual(
      detectSourceInput('api', { cwd: dir, base: 'main', head: 'x' }),
    );
  });

  it('is refused together with a source argument, --base or --head', async () => {
    await folders('api', 'web');
    await refused(['generate', 'api', '--source', 'web'], /--source cannot be used together/);
    await refused(['generate', '--source', 'api', '--base', 'main'], /--source cannot be used together/);
    await refused(['analyze', '--source', 'api', '--head', 'x'], /--source cannot be used together/);
    await refused(['validate', 'sb.json', 'api', '--source', 'web'], /--source cannot be used together/);
  });

  it('is refused for more than four sources, for the same source twice and for a bad range', async () => {
    await folders('a', 'b', 'c', 'd', 'e');
    const four = ['a', 'b', 'c', 'd'].flatMap((name) => ['--source', name]);
    await refused(['generate', ...four, '--source', 'e'], /at most 4/);
    await refused(['generate', '--source', 'a', '--source', 'a'], /same source was given more than once/);
    await refused(['generate', '--source', 'a:main..x', '--source', 'a:main..x'], /same source/);
    await refused(['generate', '--source', 'a:-x..y', '--source', 'b'], /not a valid git ref/);
    await refused(
      ['generate', '--source', 'acme/app#1:main..x', '--source', 'a'],
      /only apply to a local repository/,
    );
    await refused(['generate', '--source', '-x', '--source', 'a'], /not a valid source/);
  });

  it('is refused when --out is inside any of the repositories', async () => {
    await folders('api', 'web');
    await refused(
      ['generate', '--source', 'api', '--source', 'web', '--out', join(dir, 'web', 'runs')],
      /--out is inside the repository/,
    );
  });

  it('is refused together with --comment or --update-description, before any work', async () => {
    await folders('api', 'web');
    await refused(
      ['generate', '--source', 'api', '--source', 'web', '--comment'],
      /nothing is posted to a pull request/,
    );
    await refused(
      ['generate', '--source', 'api', '--source', 'web', '--update-description'],
      /nothing is posted to a pull request/,
    );
    // One source is the ordinary form: the flags still work.
    await run(['generate', '--source', 'api', '--comment']);
    expect(lastGenerateOptions().config?.github?.comment).toBe(true);
  });

  it('works on analyze and validate', async () => {
    await folders('api', 'web');
    analyzeMock.mockResolvedValue({
      runId: 'r',
      runDir: join(dir, 'run'),
      files: { analysis: 'a', evidence: 'e', guide: 'g', schema: 's' },
      summary: {
        title: 'T',
        changeLabel: 'x',
        size: 'xs',
        files: 2,
        suggestedDurationSec: 45,
        evidenceItems: 3,
      },
    });
    validateMock.mockResolvedValue({
      storyboard: null,
      errors: [],
      warnings: [],
      fixes: [],
      groundedClaims: 0,
    });
    const { code, stdout } = await run([
      'analyze',
      '--source',
      'api:main..x',
      '--source',
      'web',
      '--task',
      'T',
    ]);
    expect(code).toBe(0);
    expect(analyzeMock.mock.calls[0]?.[0].sources).toHaveLength(2);
    // The commands that follow repeat every --source, with the folder made absolute, and take no source argument.
    const api = `--source ${join(dir, 'api')}:main..x --source ${join(dir, 'web')}`;
    expect(stdout).toContain(`mergestory validate ${join(dir, 'run', 'storyboard.json')} ${api}`);
    expect(stdout).toContain(
      `mergestory generate ${api} --storyboard ${join(dir, 'run', 'storyboard.json')}`,
    );
    expect(analyzeMock.mock.calls[0]?.[0].followUp).toEqual({
      source: '',
      args: ['--source', `${join(dir, 'api')}:main..x`, '--source', join(dir, 'web'), '--task', 'T'],
    });
    await writeFile(join(dir, 'sb.json'), '{}');
    await run(['validate', 'sb.json', '--source', 'api', '--source', 'web']);
    expect(validateMock.mock.calls[0]?.[0].sources).toHaveLength(2);
  });
});

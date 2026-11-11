import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../core/config.ts';
import type { AuthoringResult } from '../../pipeline/index.ts';
import {
  analyzeMock,
  dir,
  fakePlan,
  fakeResult,
  generateMock,
  lastGenerateOptions,
  run,
  validateMock,
} from '../../testing/cli.ts';
import { localOnlyOverrides } from './agent.ts';

vi.mock('../../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

const work = (name = 'fix-1'): string => join(dir, 'home', 'work', name);

const authoring: AuthoringResult = {
  runId: 'r1',
  runDir: '/w',
  files: {
    analysis: '/w/analysis.json',
    evidence: '/w/evidence.md',
    guide: '/w/AUTHORING.md',
    schema: '/w/s.json',
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
const valid = { storyboard: null, errors: [], warnings: [], fixes: [], groundedClaims: 2 };

/** Make the test folder a git repository with these remotes. */
function gitRepo(remotes: Record<string, string>): void {
  execFileSync('git', ['init', '-q', dir]);
  for (const [name, url] of Object.entries(remotes)) {
    execFileSync('git', ['remote', 'add', name, url], { cwd: dir });
  }
}

const NOT_HERE = 'The agent commands only explain the repository of the current folder.';
const LINK = 'is a symbolic link or holds one. MergeStory does not read or write through links.';

describe('agent: the work folder', () => {
  it.each([
    [[]],
    [['--name', 'Fix']],
    [['--name', '-x']],
    [['--name', '../x']],
    [['--name', 'a/b']],
    [['--name', 'x'.repeat(65)]],
  ])('refuses the name %j', async (words) => {
    const { code, stderr } = await run(['agent', 'analyze', ...words]);
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('creates work/<name> with mode 0700 and writes the analysis there', async () => {
    analyzeMock.mockResolvedValue(authoring);
    const { code } = await run(['agent', 'analyze', '--name', 'a1.b_c-d']);
    expect(code).toBe(0);
    for (const path of [join(dir, 'home', 'work'), work('a1.b_c-d')]) {
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(analyzeMock.mock.calls[0]?.[0].outDir).toBe(work('a1.b_c-d'));
  });

  it.each([
    [
      'work is a link',
      async () => {
        await mkdir(join(dir, 'elsewhere'));
        await mkdir(join(dir, 'home'));
        await symlink(join(dir, 'elsewhere'), join(dir, 'home', 'work'));
      },
    ],
    [
      'work/<name> is a link',
      async () => {
        await mkdir(join(dir, 'elsewhere'));
        await mkdir(join(dir, 'home', 'work'), { recursive: true });
        await symlink(join(dir, 'elsewhere'), work());
      },
    ],
    [
      'a file in it is a link to a file',
      async () => {
        await mkdir(work(), { recursive: true });
        await writeFile(join(dir, 'secret.txt'), 'x');
        await symlink(join(dir, 'secret.txt'), join(work(), 'task.md'));
      },
    ],
    [
      'a folder deep in it is a link to a folder',
      async () => {
        await mkdir(join(work(), 'a', 'b'), { recursive: true });
        await symlink(dir, join(work(), 'a', 'b', 'up'));
      },
    ],
  ])('refuses to work when %s', async (_label, setup) => {
    await setup();
    for (const command of ['analyze', 'validate', 'render']) {
      const { code, stderr } = await run(['agent', command, '--name', 'fix-1']);
      expect(code, command).toBe(2);
      expect(stderr.replace(/\s+/g, ' ')).toContain(LINK);
    }
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(validateMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('reads task.md, notes.md and tests.json in every command, with the same masking', async () => {
    await mkdir(work(), { recursive: true });
    const key = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('-');
    await writeFile(join(work(), 'task.md'), 'Make uploads resilient.');
    await writeFile(join(work(), 'notes.md'), `Backoff. key ${key}`);
    await writeFile(
      join(work(), 'tests.json'),
      JSON.stringify([{ command: 'npm test', passed: true, summary: 'ok' }]),
    );
    await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
    analyzeMock.mockResolvedValue(authoring);
    validateMock.mockResolvedValue(valid);
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
    expect((await run(['agent', 'validate', '--name', 'fix-1'])).code).toBe(0);
    expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
    const contexts = [
      analyzeMock.mock.calls[0]?.[0].context,
      validateMock.mock.calls[0]?.[0].context,
      lastGenerateOptions().context,
    ];
    for (const context of contexts) {
      expect(context?.task).toBe('Make uploads resilient.');
      expect(context?.notes).toContain('Backoff.');
      expect(context?.notes).not.toContain(key);
      expect(context?.tests).toHaveLength(1);
    }
    expect(validateMock.mock.calls[0]?.[0].storyboard).toEqual({ title: 'x' });
    expect(lastGenerateOptions().storyboard).toEqual({ title: 'x' });
  });

  it('needs storyboard.json for validate', async () => {
    const { code, stderr } = await run(['agent', 'validate', '--name', 'fix-1']);
    expect(code).toBe(2);
    expect(stderr).toContain('There is no storyboard.json in the work folder');
    expect(validateMock).not.toHaveBeenCalled();
    // A mistyped name leaves no folder behind: only `agent analyze` creates one.
    expect(existsSync(work())).toBe(false);
  });

  it('renders the offline storyboard when there is no storyboard.json', async () => {
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
    expect(lastGenerateOptions().storyboard).toBeUndefined();
    expect(existsSync(work())).toBe(false);
  });
});

describe('agent: the source', () => {
  it('explains the repository of the current folder by default and for "."', async () => {
    analyzeMock.mockResolvedValue(authoring);
    await run(['agent', 'analyze', '--name', 'fix-1']);
    await run(['agent', 'analyze', '.', '--name', 'fix-1', '--base', 'main']);
    expect(analyzeMock.mock.calls.map((call) => call[0].source)).toEqual([dir, dir]);
    expect(analyzeMock.mock.calls[1]?.[0].base).toBe('main');
  });

  it.each([
    ['acme/app#1', { origin: 'git@github.com:Acme/App.git' }],
    ['https://github.com/ACME/app/pull/1', { upstream: 'https://github.com/acme/app' }],
    ['https://github.com/acme/app/pull/1/files', { origin: 'ssh://git@github.com/acme/app.git' }],
    ['https://ghe.example.com/acme/app/pull/1', { origin: 'git@ghe.example.com:acme/app.git' }],
  ])('accepts %s, a pull request of a remote', async (source, remotes) => {
    gitRepo(remotes);
    analyzeMock.mockResolvedValue(authoring);
    const env = { GITHUB_API_URL: 'https://ghe.example.com/api/v3' };
    const { code, stderr } = await run(['agent', 'analyze', source, '--name', 'fix-1'], env);
    expect(code, stderr).toBe(0);
    expect(analyzeMock.mock.calls[0]?.[0].source).toBe(source);
  });

  it.each([
    ['another repository', 'acme/other#1'],
    ['another owner', 'evil/app#1'],
    ['another host', 'https://evil.example.com/acme/app/pull/1'],
    ['a path outside the repository', '..'],
    ['an absolute path', '/'],
    ['a subfolder', 'sub'],
    ['something that looks like an option', '-x'],
  ])('refuses %s', async (_label, source) => {
    gitRepo({ origin: 'https://github.com/acme/app.git', other: 'https://evil.example.com/acme/app.git' });
    await mkdir(join(dir, 'sub'));
    for (const command of ['analyze', 'render']) {
      const { code, stderr } = await run(['agent', command, '--name', 'fix-1', '--', source]);
      expect(code).toBe(2);
      expect(stderr).toContain(NOT_HERE);
      expect(stderr).toContain('mergestory analyze');
    }
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses a pull request outside a git repository', async () => {
    const { code, stderr } = await run(['agent', 'analyze', 'acme/app#1', '--name', 'fix-1']);
    expect(code).toBe(2);
    expect(stderr).toContain(NOT_HERE);
  });
});

describe('agent: refused flags', () => {
  it.each([
    ['--out', 'out'],
    ['--task', 'x'],
    ['--task-file', 'task.md'],
    ['--notes-file', 'notes.md'],
    ['--tests-file', 'tests.json'],
    ['--storyboard', 'sb.json'],
    ['--screenshot', 'a.png'],
    ['--music', 'music.mp3'],
    ['--llm', 'anthropic'],
    ['--model', 'm'],
    ['--llm-base-url', 'http://localhost:1/v1'],
    ['--publish', 's3'],
    ['--visibility', 'public'],
    ['--comment'],
    ['--update-description'],
    ['--budget', '1'],
    ['--async'],
  ])('refuses %s', async (...words) => {
    for (const command of ['analyze', 'validate', 'render']) {
      const { code, stderr } = await run(['agent', command, '--name', 'fix-1', ...words]);
      expect(code, command).toBe(2);
      expect(stderr).toContain('unknown option');
    }
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(validateMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses a paid voice', async () => {
    const { code, stderr } = await run(['agent', 'render', '--name', 'fix-1', '--tts', 'openai']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('agent render: local only', () => {
  const REMOTE_ENV = {
    MERGESTORY_LLM_PROVIDER: 'anthropic',
    MERGESTORY_PUBLISH_PROVIDER: 's3',
    MERGESTORY_TTS_PROVIDER: 'openai',
    MERGESTORY_CONFIG: 'remote.json',
  };

  it('stays on this machine whatever the environment and the config file say', async () => {
    await writeFile(
      join(dir, 'remote.json'),
      JSON.stringify({
        github: { comment: true, updateDescription: true },
        publish: { provider: 's3', localDir: '/elsewhere' },
        render: { musicPath: '/music.mp3' },
        outDir: '/elsewhere/runs',
      }),
    );
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run(['agent', 'render', '--name', 'fix-1', '--style', 'product'], REMOTE_ENV);
    expect(code).toBe(0);
    const config = resolveConfig({
      overrides: lastGenerateOptions().config,
      env: { ...REMOTE_ENV, MERGESTORY_HOME: join(dir, 'home') },
      cwd: dir,
    });
    expect(config.llm.provider).toBe('none');
    expect(config.tts.provider).toBe('auto');
    expect(config.publish.provider).toBe('local');
    expect(config.publish.localDir).toBeNull();
    expect(config.github.comment).toBe(false);
    expect(config.github.updateDescription).toBe(false);
    expect(config.render.musicPath).toBeNull();
    expect(config.outDir).toBeNull();
    expect(config.style).toBe('product');
    expect(lastGenerateOptions().configPath).toBeUndefined();
  });

  it('keeps a local voice that was asked for', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['agent', 'render', '--name', 'fix-1', '--tts', 'say', '--voice', 'Samantha']);
    expect(lastGenerateOptions().config?.tts).toEqual({ provider: 'say', voice: 'Samantha' });
  });

  it('never passes on a remote voice', () => {
    expect(localOnlyOverrides({ tts: 'openai' }).tts).toEqual({ provider: 'auto' });
    expect(localOnlyOverrides({}).tts).toEqual({ provider: 'auto' });
  });
});

describe('agent: output', () => {
  it('prints the work folder and the files of analyze', async () => {
    analyzeMock.mockResolvedValue(authoring);
    const { code, stdout } = await run(['agent', 'analyze', '--name', 'fix-1', '--base', 'main', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      name: 'fix-1',
      workDir: work(),
      files: authoring.files,
      summary: authoring.summary,
    });
  });

  it('has AUTHORING.md show the agent commands', async () => {
    analyzeMock.mockResolvedValue(authoring);
    await run(['agent', 'analyze', '.', '--name', 'fix-1', '--base', 'main', '--head', 'topic']);
    expect(analyzeMock.mock.calls[0]?.[0].followUp).toEqual({
      source: '.',
      args: ['--name', 'fix-1', '--base', 'main', '--head', 'topic'],
      agent: true,
    });
  });

  it('prints the same object as validate, with exit code 3 for errors', async () => {
    await mkdir(work(), { recursive: true });
    await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
    await writeFile(join(dir, 'sb.json'), JSON.stringify({ title: 'x' }));
    const issue = { path: 'scenes', code: 'unknown-evidence', message: 'm' };
    validateMock.mockResolvedValue({ ...valid, errors: [issue] } as never);
    const agent = await run(['agent', 'validate', '--name', 'fix-1', '--json']);
    const general = await run(['validate', 'sb.json', '--json']);
    expect(agent.code).toBe(3);
    expect(general.code).toBe(3);
    expect(JSON.parse(agent.stdout)).toEqual(JSON.parse(general.stdout));
  });

  it('prints the same object as generate', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const rendered = await run(['agent', 'render', '--name', 'fix-1', '--json']);
    const generated = await run(['generate', '--json']);
    expect(rendered.code).toBe(generated.code);
    expect(JSON.parse(rendered.stdout)).toEqual(JSON.parse(generated.stdout));
  });

  it('shows the plan with --dry-run', async () => {
    generateMock.mockResolvedValue(fakePlan());
    const { code, stdout } = await run(['agent', 'render', '--name', 'fix-1', '--dry-run', '--json']);
    expect(code).toBe(0);
    expect(lastGenerateOptions().dryRun).toBe(true);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(fakePlan())));
  });
});

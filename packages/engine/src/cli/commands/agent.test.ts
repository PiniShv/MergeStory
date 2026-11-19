import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../core/config.ts';
import type { AuthoringResult } from '../../pipeline/index.ts';
import { buildContextInputs } from '../../pipeline/inputs.ts';
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
import { testConfig } from '../../testing/context.ts';
import { makePng } from '../../testing/png.ts';
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

  it('reads repro.json in every command, masked, and leaves the context without it when there is none', async () => {
    await mkdir(work(), { recursive: true });
    const key = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('-');
    await writeFile(
      join(work(), 'repro.json'),
      JSON.stringify({
        title: 'Basket count',
        steps: [{ text: `Open the page with ${key}`, result: 'bug' }],
      }),
    );
    await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
    analyzeMock.mockResolvedValue(authoring);
    validateMock.mockResolvedValue(valid);
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
    expect((await run(['agent', 'validate', '--name', 'fix-1'])).code).toBe(0);
    expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
    for (const context of [
      analyzeMock.mock.calls[0]?.[0].context,
      validateMock.mock.calls[0]?.[0].context,
      lastGenerateOptions().context,
    ]) {
      expect(context?.repro?.title).toBe('Basket count');
      expect(context?.repro?.steps[0]).toMatchObject({ result: 'bug' });
      expect(context?.repro?.steps[0]?.text).toContain('Open the page');
      expect(context?.repro?.steps[0]?.text).not.toContain(key);
    }
    await rm(join(work(), 'repro.json'));
    expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
    expect(analyzeMock.mock.calls[1]?.[0].context?.repro).toBeUndefined();
  });

  it('refuses a repro.json that is not valid, and names the file and the step', async () => {
    await mkdir(work(), { recursive: true });
    await writeFile(
      join(work(), 'repro.json'),
      JSON.stringify({
        title: 'T',
        steps: [{ text: 'a' }, { text: 'b', screenshot: 'SS1', recording: 'RC1' }],
      }),
    );
    const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
    expect(code).toBe(2);
    expect(stderr).toContain('repro.json: step 2 has both a screenshot and a recording');
    expect(stderr).not.toContain('--repro-file');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  describe('recordings/ and screenshots/', () => {
    const folder = (): string => join(work(), 'recordings');
    const shots = (): string => join(work(), 'screenshots');
    const contexts = async () => {
      analyzeMock.mockResolvedValue(authoring);
      validateMock.mockResolvedValue(valid);
      generateMock.mockResolvedValue(fakeResult());
      await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
      expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'validate', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
      return [
        analyzeMock.mock.calls[0]?.[0].context,
        validateMock.mock.calls[0]?.[0].context,
        lastGenerateOptions().context,
      ];
    };

    it('uses every recording file, sorted by name, with the captions of captions.json, in every command', async () => {
      await mkdir(folder(), { recursive: true });
      for (const name of ['b.webm', 'a.mp4', 'c.MP4', 'd.mov', 'e.mkv', 'f.m4v', 'notes.txt', 'g.avi'])
        await writeFile(join(folder(), name), 'x');
      await writeFile(
        join(folder(), 'captions.json'),
        JSON.stringify({
          'b.webm': { caption: 'Slow: before the fix', side: 'before' },
          'a.mp4': { side: 'after' },
        }),
      );
      for (const context of await contexts()) {
        expect(context?.recordings).toEqual([
          { path: join(folder(), 'a.mp4'), caption: 'a', moment: 'after' },
          { path: join(folder(), 'b.webm'), caption: 'Slow: before the fix', moment: 'before' },
          { path: join(folder(), 'c.MP4'), caption: 'c', moment: 'other' },
          { path: join(folder(), 'd.mov'), caption: 'd', moment: 'other' },
          { path: join(folder(), 'e.mkv'), caption: 'e', moment: 'other' },
          { path: join(folder(), 'f.m4v'), caption: 'f', moment: 'other' },
        ]);
      }
    });

    it('uses every picture of screenshots/ in name order, with its captions, together with recordings/', async () => {
      await mkdir(shots(), { recursive: true });
      await mkdir(folder(), { recursive: true });
      for (const name of ['2-after.png', '1-before.PNG', 'c.jpg', 'd.jpeg', 'e.gif', 'notes.txt'])
        await writeFile(join(shots(), name), 'x');
      await mkdir(join(shots(), 'sub.png'));
      await writeFile(join(folder(), 'clip.mp4'), 'x');
      await writeFile(
        join(shots(), 'captions.json'),
        JSON.stringify({
          '1-before.PNG': { caption: 'Basket: before the fix', side: 'before' },
          '2-after.png': { side: 'after' },
        }),
      );
      for (const context of await contexts()) {
        expect(context?.screenshots).toEqual([
          { path: join(shots(), '1-before.PNG'), caption: 'Basket: before the fix', moment: 'before' },
          { path: join(shots(), '2-after.png'), caption: '2-after', moment: 'after' },
          { path: join(shots(), 'c.jpg'), caption: 'c', moment: 'other' },
          { path: join(shots(), 'd.jpeg'), caption: 'd', moment: 'other' },
        ]);
        expect(context?.recordings).toEqual([
          { path: join(folder(), 'clip.mp4'), caption: 'clip', moment: 'other' },
        ]);
      }
    });

    it('lets a step of repro.json name a picture of screenshots/ by its id, in every command', async () => {
      await mkdir(shots(), { recursive: true });
      await writeFile(join(shots(), '1-before.png'), makePng(4, 4));
      await writeFile(join(shots(), '2-after.png'), makePng(4, 4));
      await writeFile(
        join(work(), 'repro.json'),
        JSON.stringify({
          title: 'The bug',
          steps: [{ text: 'Open' }, { text: 'Look', screenshot: 'SS2', result: 'bug' }],
        }),
      );
      for (const context of await contexts()) {
        const inputs = await buildContextInputs(context ?? {}, work(), testConfig());
        expect(inputs.screenshots.map((s) => s.id)).toEqual(['SS1', 'SS2']);
        expect(inputs.repro?.steps.map((step) => step.screenshotId)).toEqual([null, 'SS2']);
      }
    });

    it.each([
      [
        'a key that is not a picture',
        { 'gone.png': {} },
        'is not a screenshot (.png, .jpg, .jpeg) in the screenshots folder',
      ],
      ['an unknown field', { 'a.png': { title: 'y' } }, 'unknown field "title"'],
      ['a side that does not exist', { 'a.png': { side: 'middle' } }, 'is not "before" or "after"'],
    ])('refuses screenshots/captions.json with %s', async (_label, content, message) => {
      await mkdir(shots(), { recursive: true });
      await writeFile(join(shots(), 'a.png'), 'x');
      await writeFile(join(shots(), 'captions.json'), JSON.stringify(content));
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain('screenshots/captions.json');
      expect(stderr).toContain(message);
      expect(analyzeMock).not.toHaveBeenCalled();
    });

    it('names screenshots/, not captions.json, for a picture with a credentials-like name', async () => {
      await mkdir(shots(), { recursive: true });
      await writeFile(join(shots(), '.env.png'), 'x');
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain('screenshots/: refusing to read .env.png');
      expect(stderr).not.toContain('captions.json');
    });

    it('works without captions.json, and without the folder', async () => {
      await mkdir(work(), { recursive: true });
      for (const context of await contexts()) expect(context?.recordings).toBeUndefined();
      await mkdir(folder());
      await writeFile(join(folder(), 'clip.mp4'), 'x');
      analyzeMock.mockClear();
      validateMock.mockClear();
      generateMock.mockClear();
      expect((await contexts())[0]?.recordings).toEqual([
        { path: join(folder(), 'clip.mp4'), caption: 'clip', moment: 'other' },
      ]);
    });

    it.each([
      [
        'a file that is not in the folder',
        { 'gone.mp4': { caption: 'x' } },
        'is not a recording (.mp4, .m4v, .mov, .webm, .mkv) in the recordings folder',
      ],
      ['an unknown field', { 'a.mp4': { caption: 'x', title: 'y' } }, 'unknown field "title"'],
      ['a side that does not exist', { 'a.mp4': { side: 'middle' } }, 'is not "before" or "after"'],
      ['a caption that is not text', { 'a.mp4': { caption: 5 } }, 'is not a string'],
      ['a list', [], 'expected a JSON object'],
    ])('refuses captions.json with %s', async (_label, content, message) => {
      await mkdir(folder(), { recursive: true });
      await writeFile(join(folder(), 'a.mp4'), 'x');
      await writeFile(join(folder(), 'captions.json'), JSON.stringify(content));
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain(message);
      expect(analyzeMock).not.toHaveBeenCalled();
    });

    it('refuses a recording named like a credentials file', async () => {
      await mkdir(folder(), { recursive: true });
      await writeFile(join(folder(), '.env.mp4'), 'x');
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain('credentials file');
    });

    it('is not created by validate or render', async () => {
      await run(['agent', 'validate', '--name', 'fix-1']);
      await run(['agent', 'render', '--name', 'fix-1']);
      expect(existsSync(work())).toBe(false);
    });
  });

  describe('redact.json', () => {
    const regions = {
      SS1: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
      RC1: [{ x: 0, y: 0, w: 1, h: 0.1 }],
    };
    const contexts = async () => {
      analyzeMock.mockResolvedValue(authoring);
      validateMock.mockResolvedValue(valid);
      generateMock.mockResolvedValue(fakeResult());
      await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
      expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'validate', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
      return [
        analyzeMock.mock.calls[0]?.[0].context,
        validateMock.mock.calls[0]?.[0].context,
        lastGenerateOptions().context,
      ];
    };

    it('is read in every command, and nothing is hidden without it', async () => {
      await mkdir(work(), { recursive: true });
      for (const context of await contexts()) expect(context?.redact).toBeUndefined();
      analyzeMock.mockClear();
      validateMock.mockClear();
      generateMock.mockClear();
      await writeFile(join(work(), 'redact.json'), JSON.stringify(regions));
      for (const context of await contexts()) expect(context?.redact).toEqual(regions);
    });

    it('names a picture of screenshots/ by its id, in the same order as the folder', async () => {
      await mkdir(join(work(), 'screenshots'), { recursive: true });
      await writeFile(join(work(), 'screenshots', 'b.png'), makePng(8, 8));
      await writeFile(join(work(), 'screenshots', 'a.png'), makePng(8, 8));
      await writeFile(join(work(), 'redact.json'), JSON.stringify({ SS2: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }));
      for (const context of await contexts()) {
        const inputs = await buildContextInputs(context!, dir, testConfig());
        // SS2 is b.png, the second of the folder in name order.
        expect(
          inputs.screenshots.map((s) => [s.id, s.path.endsWith('b.png'), s.hidden?.length ?? 0]),
        ).toEqual([
          ['SS1', false, 0],
          ['SS2', true, 1],
        ]);
      }
    });

    it('is refused in every command when a region has "from" or "to"', async () => {
      await mkdir(join(work(), 'screenshots'), { recursive: true });
      await writeFile(join(work(), 'screenshots', 'a.png'), makePng(8, 8));
      await writeFile(
        join(work(), 'redact.json'),
        JSON.stringify({ SS1: [{ x: 0, y: 0, w: 0.5, h: 0.5, from: 1 }] }),
      );
      for (const context of await contexts()) {
        await expect(buildContextInputs(context!, dir, testConfig())).rejects.toMatchObject({
          code: 'USAGE',
          message: expect.stringContaining(
            'SS1, region 1 has "from": a region cannot be limited to a part of a clip.',
          ),
        });
      }
    });

    it('stops the command when the file is not valid JSON', async () => {
      await mkdir(work(), { recursive: true });
      await writeFile(join(work(), 'redact.json'), '{');
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain('is not valid JSON');
      expect(analyzeMock).not.toHaveBeenCalled();
    });
  });

  describe('logs/', () => {
    const folder = (): string => join(work(), 'logs');
    const contexts = async () => {
      analyzeMock.mockResolvedValue(authoring);
      validateMock.mockResolvedValue(valid);
      generateMock.mockResolvedValue(fakeResult());
      await writeFile(join(work(), 'storyboard.json'), JSON.stringify({ title: 'x' }));
      expect((await run(['agent', 'analyze', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'validate', '--name', 'fix-1'])).code).toBe(0);
      expect((await run(['agent', 'render', '--name', 'fix-1'])).code).toBe(0);
      return [
        analyzeMock.mock.calls[0]?.[0].context,
        validateMock.mock.calls[0]?.[0].context,
        lastGenerateOptions().context,
      ];
    };

    it('uses every .log and .txt file, sorted by name, with the captions of captions.json, in every command', async () => {
      await mkdir(folder(), { recursive: true });
      for (const name of ['b.log', 'a.txt', 'c.LOG', 'notes.md', 'd.mp4', 'e.json'])
        await writeFile(join(folder(), name), 'x');
      await writeFile(
        join(folder(), 'captions.json'),
        JSON.stringify({
          'b.log': { caption: 'Tests: all green' },
          'a.txt': {},
        }),
      );
      for (const context of await contexts()) {
        expect(context?.logs).toEqual([
          { path: join(folder(), 'a.txt'), caption: 'a' },
          { path: join(folder(), 'b.log'), caption: 'Tests: all green' },
          { path: join(folder(), 'c.LOG'), caption: 'c' },
        ]);
        expect(context?.recordings).toBeUndefined();
      }
    });

    it('works without captions.json, and without the folder', async () => {
      await mkdir(work(), { recursive: true });
      for (const context of await contexts()) expect(context?.logs).toBeUndefined();
    });

    it.each([
      [
        'a file that is not in the folder',
        { 'gone.log': { caption: 'x' } },
        'is not a log (.log, .txt) in the logs folder',
      ],
      ['a side, which only a recording has', { 'a.log': { side: 'before' } }, 'unknown field "side"'],
      ['an unknown field', { 'a.log': { caption: 'x', title: 'y' } }, 'unknown field "title"'],
      ['a caption that is not text', { 'a.log': { caption: 5 } }, 'is not a string'],
      ['a list', [], 'expected a JSON object with one entry per log file'],
    ])('refuses captions.json with %s', async (_label, content, message) => {
      await mkdir(folder(), { recursive: true });
      await writeFile(join(folder(), 'a.log'), 'x');
      await writeFile(join(folder(), 'captions.json'), JSON.stringify(content));
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain(message);
      expect(analyzeMock).not.toHaveBeenCalled();
    });

    it('refuses a log named like a credentials file', async () => {
      await mkdir(folder(), { recursive: true });
      await writeFile(join(folder(), '.env.log'), 'x');
      const { code, stderr } = await run(['agent', 'analyze', '--name', 'fix-1']);
      expect(code).toBe(2);
      expect(stderr).toContain('credentials file');
    });

    it('is not created by validate or render', async () => {
      await run(['agent', 'validate', '--name', 'fix-1']);
      await run(['agent', 'render', '--name', 'fix-1']);
      expect(existsSync(work())).toBe(false);
    });
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
    ['--source', 'other-repo'],
    ['--task', 'x'],
    ['--task-file', 'task.md'],
    ['--notes-file', 'notes.md'],
    ['--tests-file', 'tests.json'],
    ['--repro-file', 'repro.json'],
    ['--storyboard', 'sb.json'],
    ['--screenshot', 'a.png'],
    ['--screenshots-dir', 'shots'],
    ['--recording', 'a.mp4'],
    ['--log', 'a.log'],
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

  it('takes a theme by name only: an agent never points it at a folder', async () => {
    generateMock.mockResolvedValue(fakeResult());
    expect((await run(['agent', 'render', '--name', 'fix-1', '--theme', 'terminal'])).code).toBe(0);
    expect(lastGenerateOptions().config).toMatchObject({ theme: 'terminal' });
    const calls = generateMock.mock.calls.length;
    for (const path of ['./brand', '/tmp/brand', '../brand', 'C:\\brand']) {
      const { code, stderr } = await run(['agent', 'render', '--name', 'fix-1', '--theme', path]);
      expect(code, path).toBe(2);
      expect(stderr, path).toContain('A path is not accepted here');
    }
    expect((await run(['agent', 'render', '--name', 'fix-1', '--allow-low-contrast'])).code).toBe(2);
    expect(generateMock.mock.calls.length).toBe(calls);
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

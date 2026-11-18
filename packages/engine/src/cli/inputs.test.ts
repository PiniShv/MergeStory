import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { buildContextInputs } from '../pipeline/inputs.ts';
import { testConfig } from '../testing/context.ts';
import { makePng } from '../testing/png.ts';
import { MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import { formatBytes, readJsonFile, readTextFile } from './files.ts';
import { buildContext, parseScreenshotSpec, readCaptureFolder, SCREENSHOT_KIND } from './inputs.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-inputs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseScreenshotSpec', () => {
  it('reads <path>[:<caption>[:before|after]]', () => {
    expect(parseScreenshotSpec('a.png')).toEqual({ path: 'a.png', caption: null, moment: 'other' });
    expect(parseScreenshotSpec('a.png:Login')).toEqual({ path: 'a.png', caption: 'Login', moment: 'other' });
    expect(parseScreenshotSpec('a.png:Login:before')).toEqual({
      path: 'a.png',
      caption: 'Login',
      moment: 'before',
    });
    expect(parseScreenshotSpec('a.png:Login:after')).toEqual({
      path: 'a.png',
      caption: 'Login',
      moment: 'after',
    });
  });

  it('is case-insensitive about the moment and trims it', () => {
    expect(parseScreenshotSpec('a.png:Login: AFTER ')).toEqual({
      path: 'a.png',
      caption: 'Login',
      moment: 'after',
    });
  });

  it('allows colons in the caption', () => {
    expect(parseScreenshotSpec('a.png:Login: error state:after')).toEqual({
      path: 'a.png',
      caption: 'Login: error state',
      moment: 'after',
    });
    expect(parseScreenshotSpec('a.png:Step 1: open the page')).toEqual({
      path: 'a.png',
      caption: 'Step 1: open the page',
      moment: 'other',
    });
  });

  it('treats only "before" and "after" after a caption as a moment', () => {
    expect(parseScreenshotSpec('a.png:Caption:other')).toEqual({
      path: 'a.png',
      caption: 'Caption:other',
      moment: 'other',
    });
    expect(parseScreenshotSpec('a.png:after')).toEqual({ path: 'a.png', caption: 'after', moment: 'other' });
  });

  it('accepts an empty caption together with a moment', () => {
    expect(parseScreenshotSpec('a.png::after')).toEqual({ path: 'a.png', caption: null, moment: 'after' });
  });

  it('does not mistake a Windows drive letter for a separator', () => {
    expect(parseScreenshotSpec('C:\\shots\\a.png')).toEqual({
      path: 'C:\\shots\\a.png',
      caption: null,
      moment: 'other',
    });
    expect(parseScreenshotSpec('C:\\shots\\a.png:Home:after')).toEqual({
      path: 'C:\\shots\\a.png',
      caption: 'Home',
      moment: 'after',
    });
    expect(parseScreenshotSpec('d:/x/a.png:Home')).toEqual({
      path: 'd:/x/a.png',
      caption: 'Home',
      moment: 'other',
    });
  });

  it('keeps spaces in the path', () => {
    expect(parseScreenshotSpec('my shots/a b.png:My caption')).toEqual({
      path: 'my shots/a b.png',
      caption: 'My caption',
      moment: 'other',
    });
  });
});

describe('readTextFile', () => {
  const options = (maxBytes: number) => ({ label: '--notes-file', maxBytes, cwd: dir });

  it('reads UTF-8 and strips a byte order mark', async () => {
    await writeFile(join(dir, 'a.md'), '\uFEFFcaf\u00e9 \u2713');
    expect(await readTextFile('a.md', options(100))).toBe('caf\u00e9 \u2713');
  });

  it('reads exactly the limit and refuses one byte more', async () => {
    await writeFile(join(dir, 'ok.md'), 'x'.repeat(100));
    await writeFile(join(dir, 'big.md'), 'x'.repeat(101));
    expect(await readTextFile('ok.md', options(100))).toHaveLength(100);
    await expect(readTextFile('big.md', options(100))).rejects.toThrow(
      '--notes-file: big.md is 101 B, the limit is 100 B.',
    );
  });

  it('counts bytes, not characters', async () => {
    await writeFile(join(dir, 'wide.md'), '\u20ac'.repeat(40));
    await expect(readTextFile('wide.md', options(100))).rejects.toThrow(/120 B/);
  });

  it('resolves relative paths from the given directory', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'n.md'), 'hello');
    expect(await readTextFile('sub/n.md', options(100))).toBe('hello');
    expect(await readTextFile(join(dir, 'sub', 'n.md'), { ...options(100), cwd: '/' })).toBe('hello');
  });

  it('refuses directories, binary data and credential files', async () => {
    await mkdir(join(dir, 'folder'));
    await expect(readTextFile('folder', options(100))).rejects.toThrow(MergeStoryError);
    await writeFile(join(dir, 'bin'), Buffer.from([1, 0, 2]));
    await expect(readTextFile('bin', options(100))).rejects.toThrow(/not a text file/);
    for (const name of ['.env', '.env.production', 'server.pem', 'id_rsa', 'credentials.json', '.npmrc']) {
      await writeFile(join(dir, name), 'TOKEN=abc');
      await expect(readTextFile(name, options(100)), name).rejects.toThrow(/credentials file/);
    }
  });

  it('follows a link to a normal file but still checks the real size', async () => {
    await writeFile(join(dir, 'real.md'), 'x'.repeat(200));
    await symlink(join(dir, 'real.md'), join(dir, 'link.md'));
    await expect(readTextFile('link.md', options(100))).rejects.toThrow(/limit is 100 B/);
  });

  it('says what went wrong for a missing file', async () => {
    const error = await readTextFile('missing.md', options(100)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect((error as MergeStoryError).code).toBe('USAGE');
    expect((error as MergeStoryError).message).toBe('--notes-file: file not found: missing.md');
    expect((error as MergeStoryError).hint).toBeDefined();
  });
});

describe('readJsonFile', () => {
  it('parses JSON and picks the error code for broken JSON', async () => {
    await writeFile(join(dir, 'ok.json'), '{"a": [1, 2]}');
    expect(await readJsonFile('ok.json', { label: '--x', maxBytes: 100, cwd: dir })).toEqual({ a: [1, 2] });
    await writeFile(join(dir, 'bad.json'), '{"a": ');
    await expect(readJsonFile('bad.json', { label: '--x', maxBytes: 100, cwd: dir })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(
      readJsonFile('bad.json', { label: '--x', maxBytes: 100, cwd: dir, invalidCode: 'STORYBOARD_INVALID' }),
    ).rejects.toMatchObject({ code: 'STORYBOARD_INVALID' });
  });
});

describe('buildContext', () => {
  it('returns nothing when no context flag was given', async () => {
    expect(await buildContext({}, dir)).toBeUndefined();
    expect(await buildContext({ screenshot: [] }, dir)).toBeUndefined();
  });

  it('uses the file name as the caption when none is given', async () => {
    await writeFile(join(dir, 'login-page.png'), makePng(4, 4));
    const context = await buildContext({ screenshot: ['login-page.png'] }, dir);
    expect(context?.screenshots).toEqual([
      { path: join(dir, 'login-page.png'), caption: 'login-page', moment: 'other' },
    ]);
  });

  it('limits the size of a screenshot to what the video can embed', async () => {
    const huge = join(dir, 'huge.png');
    await writeFile(huge, '');
    const { truncate } = await import('node:fs/promises');
    await truncate(huge, MAX_SCREENSHOT_BYTES + 1);
    await expect(buildContext({ screenshot: ['huge.png'] }, dir)).rejects.toThrow(/the limit is 4 MB/);
    // Exactly at the limit is fine when the content is an image.
    const exact = join(dir, 'exact.png');
    await writeFile(
      exact,
      Buffer.concat([makePng(4, 4), Buffer.alloc(MAX_SCREENSHOT_BYTES)]).subarray(0, MAX_SCREENSHOT_BYTES),
    );
    await expect(buildContext({ screenshot: ['exact.png'] }, dir)).resolves.toBeDefined();
  });

  it('reads the format from the content, so WebP, GIF and text named like a PNG are refused', async () => {
    for (const [name, bytes] of [
      ['a.webp', Buffer.from('RIFF....WEBPVP8 ')],
      ['b.gif', Buffer.from('GIF89a......')],
      ['c.png', Buffer.from('png')],
    ] as const) {
      await writeFile(join(dir, name), bytes);
      await expect(buildContext({ screenshot: [name] }, dir), name).rejects.toThrow(
        /is not a PNG or JPEG image/,
      );
    }
  });
});

describe('buildContext: recordings', () => {
  it('makes the path absolute, defaults the caption to the file name and reads the moment', async () => {
    const context = await buildContext(
      { recording: ['clip.mp4', 'sub/after.webm:Done: all green:after'] },
      dir,
    );
    expect(context?.recordings).toEqual([
      { path: join(dir, 'clip.mp4'), caption: 'clip', moment: 'other' },
      { path: join(dir, 'sub/after.webm'), caption: 'Done: all green', moment: 'after' },
    ]);
  });

  it('refuses a missing path and a credentials-like file name', async () => {
    await expect(buildContext({ recording: [':caption'] }, dir)).rejects.toThrow(
      /--recording: missing a file path/,
    );
    await expect(buildContext({ recording: ['.env'] }, dir)).rejects.toThrow(/credentials file/);
  });
});

describe('buildContext: --screenshots-dir', () => {
  const folder = (): string => join(dir, 'shots');
  const png = async (name: string, where = folder()) => writeFile(join(where, name), makePng(4, 4));
  const refused = async (captions: unknown, message: string) => {
    await writeFile(join(folder(), 'captions.json'), JSON.stringify(captions));
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining(message),
    });
  };
  beforeEach(async () => {
    await mkdir(folder());
  });

  it('uses every .png, .jpg and .jpeg, sorted by name (capitals first), in any letter case, and nothing else', async () => {
    for (const name of ['a.png', 'B.PNG', 'c.Jpg', 'd.jpeg', 'e.gif', 'f.webp', 'notes.txt']) await png(name);
    await mkdir(join(folder(), 'sub.png'));
    await mkdir(join(folder(), 'deeper'));
    await png('inside.png', join(folder(), 'deeper'));
    const context = await buildContext({ screenshotsDir: 'shots' }, dir);
    expect(context?.screenshots?.map((s) => s.path)).toEqual(
      ['B.PNG', 'a.png', 'c.Jpg', 'd.jpeg'].map((name) => join(folder(), name)),
    );
  });

  it('gives a picture without an entry its file name as caption and no side, and reads captions.json', async () => {
    await png('1-before.png');
    await png('2-after.png');
    await png('3.png');
    await writeFile(
      join(folder(), 'captions.json'),
      JSON.stringify({
        '1-before.png': { caption: 'Basket: before the fix', side: 'before' },
        '2-after.png': { side: 'after' },
      }),
    );
    expect((await buildContext({ screenshotsDir: 'shots' }, dir))?.screenshots).toEqual([
      { path: join(folder(), '1-before.png'), caption: 'Basket: before the fix', moment: 'before' },
      { path: join(folder(), '2-after.png'), caption: '2-after', moment: 'after' },
      { path: join(folder(), '3.png'), caption: '3', moment: 'other' },
    ]);
  });

  it('puts the pictures of --screenshot first, in the order given, then the folder', async () => {
    await png('a.png');
    await writeFile(join(dir, 'z.png'), makePng(4, 4));
    await writeFile(join(dir, 'y.png'), makePng(4, 4));
    const context = await buildContext({ screenshot: ['z.png', 'y.png:Why'], screenshotsDir: 'shots' }, dir);
    expect(context?.screenshots?.map((s) => s.path)).toEqual([
      join(dir, 'z.png'),
      join(dir, 'y.png'),
      join(folder(), 'a.png'),
    ]);
    // The same file given twice is used twice.
    const twice = await buildContext({ screenshot: [join(folder(), 'a.png')], screenshotsDir: 'shots' }, dir);
    expect(twice?.screenshots).toHaveLength(2);
  });

  it('lets a step of --repro-file name a picture of the folder by its id, after the pictures of --screenshot', async () => {
    await png('a.png');
    await png('b.png');
    await writeFile(join(dir, 'z.png'), makePng(4, 4));
    await writeFile(
      join(dir, 'repro.json'),
      JSON.stringify({
        title: 'The bug',
        steps: [
          { text: 'Open', screenshot: 'SS1' },
          { text: 'Look', screenshot: 'SS3', result: 'bug' },
        ],
      }),
    );
    const context = await buildContext(
      { screenshot: ['z.png'], screenshotsDir: 'shots', reproFile: 'repro.json' },
      dir,
    );
    const inputs = await buildContextInputs(context ?? {}, dir, testConfig());
    expect(inputs.screenshots.map((s) => [s.id, s.path])).toEqual([
      ['SS1', join(dir, 'z.png')],
      ['SS2', join(folder(), 'a.png')],
      ['SS3', join(folder(), 'b.png')],
    ]);
    expect(inputs.repro?.steps.map((step) => step.screenshotId)).toEqual(['SS1', 'SS3']);
  });

  it('is fine with an empty folder', async () => {
    expect(await buildContext({ screenshotsDir: 'shots' }, dir)).toEqual({ screenshots: [] });
  });

  it('refuses an empty or blank folder path instead of reading the current folder', async () => {
    for (const value of ['', '  ']) {
      await expect(buildContext({ screenshotsDir: value }, dir), value).rejects.toMatchObject({
        code: 'USAGE',
        message: '--screenshots-dir: missing a folder path.',
      });
    }
  });

  it('refuses a picture or a captions.json that is a link, naming it', async () => {
    await writeFile(join(dir, 'real.png'), makePng(4, 4));
    await symlink(join(dir, 'real.png'), join(folder(), 'linked.png'));
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toMatchObject({
      code: 'USAGE',
      message: '--screenshots-dir: linked.png is a link.',
    });
    await rm(join(folder(), 'linked.png'));
    await writeFile(join(dir, 'other.json'), '{}');
    await symlink(join(dir, 'other.json'), join(folder(), 'captions.json'));
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toMatchObject({
      code: 'USAGE',
      message: '--screenshots-dir: captions.json is a link.',
    });
  });

  it('refuses a folder that cannot be listed, but the optional folder of the agent commands is just empty', async (ctx) => {
    if (process.getuid?.() === 0) return ctx.skip();
    await png('a.png');
    await chmod(folder(), 0o000);
    try {
      await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toMatchObject({
        code: 'USAGE',
        message: '--screenshots-dir: the folder could not be read.',
      });
      expect(await readCaptureFolder(folder(), SCREENSHOT_KIND)).toEqual([]);
    } finally {
      await chmod(folder(), 0o755);
    }
  });

  it('names the flag, not captions.json, when a picture has a credentials-like name', async () => {
    await png('.env.png');
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toMatchObject({
      message: expect.stringMatching(/^--screenshots-dir: refusing to read \.env\.png/),
    });
  });

  it('refuses a folder that is missing or is a file', async () => {
    await writeFile(join(dir, 'file.txt'), 'x');
    for (const name of ['nope', 'file.txt']) {
      await expect(buildContext({ screenshotsDir: name }, dir), name).rejects.toMatchObject({
        code: 'USAGE',
        message: `--screenshots-dir: ${name} is not a folder.`,
      });
    }
  });

  it('checks every picture like a --screenshot file: content, size and name', async () => {
    await writeFile(join(folder(), 'fake.png'), 'not an image');
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toThrow(
      /--screenshots-dir: .*fake\.png is not a PNG or JPEG image/,
    );
    await rm(join(folder(), 'fake.png'));
    await png('.env.png');
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toThrow(/credentials file/);
    await rm(join(folder(), '.env.png'));
    await png('big.png');
    await truncate(join(folder(), 'big.png'), MAX_SCREENSHOT_BYTES + 1);
    await expect(buildContext({ screenshotsDir: 'shots' }, dir)).rejects.toThrow(/the limit is 4 MB/);
  });

  it.each([
    [
      'a key that is not a picture of the folder',
      { 'gone.png': { caption: 'x' } },
      '"gone.png" is not a screenshot (.png, .jpg, .jpeg) in the shots folder',
    ],
    [
      'a key that is a file of another kind',
      { 'notes.txt': { caption: 'x' } },
      '"notes.txt" is not a screenshot',
    ],
    ['an unknown field', { 'a.png': { caption: 'x', title: 'y' } }, 'unknown field "title"'],
    ['a side that does not exist', { 'a.png': { side: 'middle' } }, 'is not "before" or "after"'],
    ['a caption that is not text', { 'a.png': { caption: 5 } }, 'is not a string'],
    ['an entry that is not an object', { 'a.png': 'x' }, 'is not an object'],
    ['a list', [], 'expected a JSON object with one entry per screenshot file'],
  ])('refuses captions.json with %s', async (_label, content, message) => {
    await png('a.png');
    await writeFile(join(folder(), 'notes.txt'), 'x');
    await refused(content, message);
  });
});

describe('formatBytes', () => {
  it('uses B, KB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(64 * 1024)).toBe('64 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
  });
});

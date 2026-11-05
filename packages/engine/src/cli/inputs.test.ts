import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { makePng } from '../testing/png.ts';
import { MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import { formatBytes, readJsonFile, readTextFile } from './files.ts';
import { buildContext, parseScreenshotSpec } from './inputs.ts';

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

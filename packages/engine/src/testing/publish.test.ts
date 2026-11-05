import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pageData, publishMeta, writeBundle } from './publish.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-testing-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('pageData and publishMeta', () => {
  it('give complete data, and let a test change any part of it', () => {
    expect(pageData().chapters.length).toBeGreaterThan(1);
    expect(pageData({ title: 'Other' }).title).toBe('Other');
    expect(pageData().title).toBe('Add retry with backoff');
    expect(publishMeta().durationSec).toBe(90);
    expect(publishMeta({ durationSec: 30 }).durationSec).toBe(30);
  });
});

describe('writeBundle', () => {
  it('writes the video, the poster and the captions, and lists them in that order', async () => {
    const dir = join(root, 'render');
    const { bundle, video, bytes } = await writeBundle({ dir });
    expect(bundle.files).toEqual([
      { name: 'video.mp4', path: join(dir, 'video.mp4') },
      { name: 'poster.jpg', path: join(dir, 'poster.jpg') },
      { name: 'captions.vtt', path: join(dir, 'captions.vtt') },
    ]);
    expect((await readdir(dir)).sort()).toEqual(['captions.vtt', 'poster.jpg', 'video.mp4']);
    expect(video.toString()).toBe('VIDEO-BYTES');
    expect(await readFile(join(dir, 'captions.vtt'), 'utf8')).toBe('WEBVTT\n');
    expect(bytes).toBe('VIDEO-BYTES'.length + 'POSTER-BYTES'.length + 'WEBVTT\n'.length);
  });

  it('writes what it is asked to, and leaves out what it is told to', async () => {
    const sized = await writeBundle({
      dir: join(root, 'a'),
      video: 5,
      poster: 'poster.png',
      captions: false,
    });
    expect(sized.video.toString()).toBe('vvvvv');
    expect(sized.bundle.files.map((file) => file.name)).toEqual(['video.mp4', 'poster.png']);
    const bare = await writeBundle({ dir: join(root, 'b'), video: Buffer.from('abc'), poster: false });
    expect(bare.bundle.files.map((file) => file.name)).toEqual(['video.mp4', 'captions.vtt']);
    expect(bare.bytes).toBe(3 + 'WEBVTT\n'.length);
  });

  it('describes the repository as unknown unless it is told otherwise', async () => {
    expect((await writeBundle({ dir: join(root, 'a') })).bundle.repoIsPrivate).toBeNull();
    expect((await writeBundle({ dir: join(root, 'b'), repoIsPrivate: false })).bundle.repoIsPrivate).toBe(
      false,
    );
    expect((await writeBundle({ dir: join(root, 'c'), repoIsPrivate: true })).bundle.repoIsPrivate).toBe(
      true,
    );
  });

  it('carries the text for YouTube only when it is given', async () => {
    expect((await writeBundle({ dir: join(root, 'a') })).bundle).not.toHaveProperty('meta');
    const meta = publishMeta({ title: 'Mine' });
    expect((await writeBundle({ dir: join(root, 'b'), meta })).bundle.meta).toBe(meta);
  });

  it('builds the page from the page data and remembers the links it was given', async () => {
    const { bundle, seen } = await writeBundle({ dir: root, page: { title: 'A title for the test' } });
    expect(seen.urls).toBeNull();
    const urls = { video: 'video.mp4', poster: null, captions: null, linkExpiresAt: null };
    expect(bundle.buildWatchPage(urls)).toContain('A title for the test');
    expect(seen.urls).toBe(urls);
  });
});

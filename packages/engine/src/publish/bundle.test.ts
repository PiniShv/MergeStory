import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishFile } from '../core/providers.ts';
import { classifyBundle } from './bundle.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-bundle-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(name: string, content = 'x'): Promise<PublishFile> {
  await writeFile(join(root, name), content);
  return { name, path: join(root, name) };
}

describe('classifyBundle', () => {
  it('finds the video, poster and captions and orders them for upload', async () => {
    const poster = await file('poster.jpg', '123');
    const video = await file('video.mp4', '12345');
    const captions = await file('captions.vtt', '12');
    const other = await file('notes.json', '1');
    const result = await classifyBundle({ files: [poster, other, captions, video] });
    expect(result.video.file).toBe(video);
    expect(result.poster?.file).toBe(poster);
    expect(result.captions?.file).toBe(captions);
    expect(result.ordered.map((e) => e.file.name)).toEqual([
      'video.mp4',
      'captions.vtt',
      'poster.jpg',
      'notes.json',
    ]);
    expect(result.totalBytes).toBe(11);
  });

  it('allows a bundle with only a video', async () => {
    const result = await classifyBundle({ files: [await file('video.mp4')] });
    expect(result.poster).toBeNull();
    expect(result.captions).toBeNull();
  });

  it('rejects a directory in place of a file', async () => {
    await mkdir(join(root, 'video.mp4'));
    await expect(
      classifyBundle({ files: [{ name: 'video.mp4', path: join(root, 'video.mp4') }] }),
    ).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
    });
  });

  it('rejects names with the wrong shape, whatever their case', async () => {
    const video = await file('video.mp4');
    for (const name of ['INDEX.HTML', 'a b.mp4', '', 'x'.repeat(200)]) {
      await expect(classifyBundle({ files: [video, { ...video, name }] })).rejects.toMatchObject({
        code: 'PUBLISH_FAILED',
      });
    }
  });

  it('treats names that differ only in case as the same file', async () => {
    const video = await file('video.mp4');
    await expect(classifyBundle({ files: [video, { ...video, name: 'VIDEO.mp4' }] })).rejects.toMatchObject({
      message: expect.stringContaining('twice'),
    });
  });
});

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MergeStoryError } from './errors.ts';
import {
  PublishInputSchema,
  readRunJson,
  resultFiles,
  runFolder,
  StoredResultSchema,
  writeRunJson,
} from './run-folder.ts';
import { MAX_SOURCES } from './source-views.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-run-folder-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runFolder', () => {
  it('names every file inside the run folder', () => {
    const folder = runFolder('/runs/a');
    expect(folder.video).toBe('/runs/a/video.mp4');
    expect(folder.publishInput).toBe('/runs/a/publish-input.json');
    expect(folder.watchPage).toBe('/runs/a/watch/index.html');
    expect(folder.watchHtml).toBe('/runs/a/watch.html');
    expect(resultFiles('/runs/a')).toEqual({
      video: '/runs/a/video.mp4',
      poster: null,
      captions: '/runs/a/captions.vtt',
      captionsSrt: '/runs/a/captions.srt',
      storyboard: '/runs/a/storyboard.json',
      watchPage: '/runs/a/watch/index.html',
    });
  });
});

describe('resultFiles without a poster', () => {
  it('names no poster and no watch.html when the files are not there', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mergestory-files-'));
    try {
      expect(resultFiles(empty).poster).toBeNull();
      await writeFile(join(empty, 'poster.jpg'), 'P');
      expect(resultFiles(empty).poster).toBe(join(empty, 'poster.jpg'));
      // A folder that an older version made has no watch.html next to the video.
      expect('watchHtml' in resultFiles(empty)).toBe(false);
      await writeFile(join(empty, 'watch.html'), '<!doctype html>');
      expect(resultFiles(empty).watchHtml).toBe(join(empty, 'watch.html'));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('writeRunJson and readRunJson', () => {
  const Schema = z.object({ n: z.number() });

  it('writes private, formatted JSON and leaves no temporary file', async () => {
    const path = join(dir, 'x.json');
    await writeRunJson(path, { n: 1 });
    expect(await readFile(path, 'utf8')).toBe('{\n  "n": 1\n}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['x.json']);
    expect(await readRunJson(path, Schema, 'x.json')).toEqual({ n: 1 });
  });

  it('reports a missing file, bad JSON and a wrong shape as SOURCE_INVALID', async () => {
    const path = join(dir, 'x.json');
    await expect(readRunJson(path, Schema, 'x.json')).rejects.toMatchObject({ code: 'SOURCE_INVALID' });
    await writeFile(path, '{ nope');
    await expect(readRunJson(path, Schema, 'x.json')).rejects.toThrow(/not valid JSON/);
    await writeFile(path, '{"n":"one"}');
    const error = await readRunJson(path, Schema, 'x.json').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect((error as MergeStoryError).code).toBe('SOURCE_INVALID');
  });
});

describe('PublishInputSchema', () => {
  it('refuses a source count above the most sources one video may join', () => {
    const sourceIssues = (sources: number) =>
      PublishInputSchema.safeParse({ sources }).error?.issues.filter((i) => i.path[0] === 'sources') ?? [];
    expect(sourceIssues(MAX_SOURCES)).toEqual([]);
    expect(sourceIssues(MAX_SOURCES + 1)).toHaveLength(1);
  });
});

describe('StoredResultSchema', () => {
  it('accepts a result with its lists and refuses anything else', () => {
    const result = { ok: true, cost: { records: [] }, egress: [], warnings: [], files: {} };
    expect(StoredResultSchema.safeParse(result).success).toBe(true);
    for (const broken of [{ ...result, ok: false }, { ...result, egress: 'x' }, null, []]) {
      expect(StoredResultSchema.safeParse(broken).success).toBe(false);
    }
  });
});

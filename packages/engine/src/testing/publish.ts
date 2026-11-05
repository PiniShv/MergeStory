/**
 * Fixtures for the publish tests. This folder is not part of the build (see tsconfig.build.json), so
 * nothing in it reaches the package.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetUrls, PublishBundle, PublishMeta } from '../core/providers.ts';
import type { EgressContent } from '../core/types.ts';
import { buildWatchPage, type WatchPageData } from '../publish/index.ts';

/** Page data with every part filled in: chapters, review items, and claims with and without evidence. */
export function pageData(overrides: Partial<WatchPageData> = {}): WatchPageData {
  return {
    title: 'Add retry with backoff',
    summary: 'Failed calls are retried up to four times.',
    repoLabel: 'example/weather',
    changeLabel: 'PR #482',
    changeUrl: null,
    headSha: '3f9c2ab1d0e49b7a55c3e2f1a0b9c8d7e6f5a4b3',
    durationSec: 128,
    chapters: [
      { title: 'Why this change', startSec: 0 },
      { title: 'The retry helper', startSec: 21 },
      { title: 'Wrap up', startSec: 121 },
    ],
    checklist: [
      {
        title: 'Retries on POST',
        detail: 'Check the retry limit.',
        severity: 'high',
        ref: { label: 'src/client.ts:88-120', url: null },
      },
      { title: 'Changelog added', detail: '', severity: 'info', ref: null },
    ],
    claims: [
      {
        chapter: 'Why this change',
        text: 'Calls used to fail on the first error.',
        evidence: [{ label: 'PR description', url: null }],
      },
      {
        chapter: 'Why this change',
        text: 'The change adds a retry helper.',
        evidence: [
          { label: 'F1', url: null },
          { label: 'F2', url: null },
        ],
      },
      {
        chapter: 'The retry helper',
        text: 'It gives up after four attempts.',
        evidence: [{ label: 'src/retry.ts:8', url: null }],
      },
      { chapter: 'Wrap up', text: 'Review the retry limit.', evidence: [] },
    ],
    uncertainties: ['No benchmark was supplied.'],
    storyboardSource: 'llm',
    generator: { llm: 'example-model-1', tts: 'kokoro' },
    hasSimulatedVisuals: false,
    generatedAt: '2026-11-03T21:45:01.000Z',
    engineVersion: '1.0.0',
    ...overrides,
  };
}

/** The text that a host such as YouTube shows next to the video. */
export function publishMeta(overrides: Partial<PublishMeta> = {}): PublishMeta {
  return {
    title: 'Add retry with backoff',
    summary:
      'Failed forecast calls are retried with exponential backoff, so short outages no longer fail requests.',
    language: 'en',
    durationSec: 90,
    chapters: [
      { title: 'Why this change', startSec: 0 },
      { title: 'The retry loop', startSec: 12 },
      { title: 'Tests', startSec: 30 },
      { title: 'What to review', startSec: 55 },
    ],
    checklist: [
      { title: 'Is the retry limit sensible?', severity: 'medium' },
      { title: 'Are client errors excluded?', severity: 'high' },
    ],
    changeUrl: 'https://github.com/example/weather/pull/482',
    repoLabel: 'example/weather',
    changeLabel: 'PR #482',
    headSha: '3f9c2ab1d0e49b7a55c3',
    engineVersion: '1.0.0',
    ...overrides,
  };
}

export interface BundleOptions {
  /** The folder that receives the files. It is created when it is missing. */
  dir: string;
  /** What video.mp4 holds: its text, its bytes, or a number of bytes to fill with "v". */
  video?: string | Buffer | number;
  /** The file name of the poster, or false to leave it out. */
  poster?: string | false;
  /** What captions.vtt holds, or false to leave the file out. */
  captions?: string | false;
  /** What the files hold, for the egress report. */
  contains?: EgressContent[];
  /** The privacy of the repository: null is unknown. */
  repoIsPrivate?: boolean | null;
  /** The text for hosts that show a title and a description (YouTube). Left out by default. */
  meta?: PublishMeta;
  /** Changes to the data of the watch page. */
  page?: Partial<WatchPageData>;
}

export interface TestBundle {
  bundle: PublishBundle;
  /** The bytes of video.mp4. */
  video: Buffer;
  /** The size of all the files together, in bytes. */
  bytes: number;
  /** The links that the last watch page was built with. */
  seen: { urls: AssetUrls | null };
}

/**
 * Write a video, a poster and a caption file into `dir` and describe them as a bundle, in the order
 * video, poster, captions. The watch page is built from `pageData()` and the links it is given.
 */
export async function writeBundle(options: BundleOptions): Promise<TestBundle> {
  const { dir } = options;
  await mkdir(dir, { recursive: true });
  const content = options.video ?? 'VIDEO-BYTES';
  const video = typeof content === 'number' ? Buffer.alloc(content, 'v') : Buffer.from(content);
  const files = [{ name: 'video.mp4', body: video }];
  if (options.poster !== false) {
    files.push({ name: options.poster ?? 'poster.jpg', body: Buffer.from('POSTER-BYTES') });
  }
  if (options.captions !== false) {
    files.push({ name: 'captions.vtt', body: Buffer.from(options.captions ?? 'WEBVTT\n') });
  }
  for (const { name, body } of files) await writeFile(join(dir, name), body);
  const seen: TestBundle['seen'] = { urls: null };
  const bundle: PublishBundle = {
    files: files.map(({ name }) => ({ name, path: join(dir, name) })),
    buildWatchPage: (urls) => {
      seen.urls = urls;
      return buildWatchPage(pageData(options.page), urls);
    },
    contains: options.contains ?? ['video'],
    repoIsPrivate: options.repoIsPrivate ?? null,
    ...(options.meta ? { meta: options.meta } : {}),
  };
  return { bundle, video, bytes: files.reduce((sum, { body }) => sum + body.length, 0), seen };
}

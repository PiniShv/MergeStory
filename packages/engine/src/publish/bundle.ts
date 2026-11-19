/** Checks on a publish bundle that every publisher needs before it touches storage. */
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { MergeStoryError } from '../core/errors.ts';
import type { PublishBundle, PublishFile } from '../core/providers.ts';

/** Name of the generated watch page. Bundles may not contain a file with this name. */
export const WATCH_PAGE_NAME = 'index.html';

/** The only files that a publisher is handed, by name without the extension: the video, its poster and its captions. */
const PUBLISHED_STEMS = ['video', 'poster', 'captions'];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const CAPTION_EXT = /\.vtt$/i;

export interface BundleFile {
  file: PublishFile;
  sizeBytes: number;
}

export interface ClassifiedBundle {
  video: BundleFile;
  poster: BundleFile | null;
  captions: BundleFile | null;
  /** Upload order: video first (fail early), then captions and poster. */
  ordered: BundleFile[];
  totalBytes: number;
}

function invalid(message: string, hint: string): MergeStoryError {
  return new MergeStoryError('PUBLISH_FAILED', message, { hint });
}

/** File names become object keys and file names, so they must be plain names. */
function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw invalid(
      `"${name.slice(0, 40)}" is not a valid name for a published file.`,
      'Use plain file names such as video.mp4.',
    );
  }
  if (name.toLowerCase() === WATCH_PAGE_NAME) {
    throw invalid(
      `The bundle may not contain a file named ${WATCH_PAGE_NAME}.`,
      'The watch page is generated while publishing.',
    );
  }
}

/**
 * Validate the files of a bundle (names, existence, sizes) and sort out which one is the
 * video, poster and captions.
 */
export async function classifyBundle(bundle: Pick<PublishBundle, 'files'>): Promise<ClassifiedBundle> {
  const seen = new Set<string>();
  const entries: BundleFile[] = [];
  for (const file of bundle.files) {
    assertSafeName(file.name);
    // Only these three leave the machine. A capture, a frame of a recording or the render plan can never be in a bundle.
    if (!PUBLISHED_STEMS.includes(file.name.replace(/\.[^.]*$/, '').toLowerCase())) {
      throw invalid(
        `${file.name.slice(0, 40)} is not the video, its poster or its captions.`,
        'Only the video, its poster and its captions are published.',
      );
    }
    const key = file.name.toLowerCase();
    if (seen.has(key))
      throw invalid(`The bundle lists ${file.name} twice.`, 'Each published file needs a unique name.');
    seen.add(key);
    let info: Stats;
    try {
      info = await stat(file.path);
    } catch (err) {
      throw new MergeStoryError('PUBLISH_FAILED', `The file ${file.name} to publish does not exist.`, {
        hint: 'Render the video before publishing.',
        cause: err,
      });
    }
    if (!info.isFile())
      throw invalid(`${file.name} is not a regular file.`, 'Point the bundle at the rendered files.');
    entries.push({ file, sizeBytes: info.size });
  }
  const video = entries.find((e) => VIDEO_EXT.test(e.file.name));
  if (!video) throw invalid('The bundle has no video file.', 'Render the video before publishing.');
  const poster = entries.find((e) => IMAGE_EXT.test(e.file.name)) ?? null;
  const captions = entries.find((e) => CAPTION_EXT.test(e.file.name)) ?? null;
  const ordered = [video, captions, poster].filter((e): e is BundleFile => e !== null);
  return { video, poster, captions, ordered, totalBytes: ordered.reduce((sum, e) => sum + e.sizeBytes, 0) };
}

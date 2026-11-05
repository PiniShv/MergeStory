/**
 * Local publisher: copies the bundle into a folder and writes a watch page that links to the
 * copies with relative paths. Nothing is uploaded and nothing leaves the machine. The pipeline
 * writes the watch folder of every run the same way.
 */
import { constants } from 'node:fs';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../core/errors.ts';
import { ensureDir } from '../core/paths.ts';
import type { AssetUrls, PublishBundle, PublishCheckContext, Publisher } from '../core/providers.ts';
import type { CaptionCue, EgressRecord, PublishResult } from '../core/types.ts';
import { type ClassifiedBundle, classifyBundle, WATCH_PAGE_NAME } from './bundle.ts';
import { parseVtt } from './vtt.ts';

const MAX_CAPTION_BYTES = 2 * 1024 * 1024;

/** Marker that the watch page carries, used to recognise a folder MergeStory wrote earlier. */
const GENERATOR_TAG = '<meta name="generator" content="MergeStory';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** true when both paths lead to the same file on disk. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([stat(a), stat(b)]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

async function isMergeStoryPage(path: string): Promise<boolean> {
  try {
    return (await readFile(path)).subarray(0, 4096).toString('utf8').includes(GENERATOR_TAG);
  } catch {
    return false;
  }
}

interface Target {
  name: string;
  /** The file that is copied to this name, or null for generated files. */
  source: string | null;
}

/**
 * A folder chosen by the user may hold other files. MergeStory only overwrites files that an
 * earlier run wrote, which it recognises by the watch page. A file that is already the very
 * file to publish is fine.
 */
async function assertOwnFolder(dir: string, targets: Target[]): Promise<void> {
  const present: string[] = [];
  for (const { name, source } of targets) {
    const path = join(dir, name);
    if ((await exists(path)) && !(source && (await sameFile(source, path)))) present.push(name);
  }
  if (present.length === 0 || (await isMergeStoryPage(join(dir, WATCH_PAGE_NAME)))) return;
  throw new MergeStoryError(
    'CONFIG_INVALID',
    `The publish folder already contains ${present.join(', ')}, which MergeStory did not write.`,
    { hint: 'Set publish.localDir to an empty folder, or remove those files first.' },
  );
}

/** The cues of a caption file, or none when it is missing, too big or not readable. */
async function readCues(path: string, sizeBytes: number): Promise<CaptionCue[]> {
  if (sizeBytes > MAX_CAPTION_BYTES) return [];
  try {
    return parseVtt(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

async function copyUnlessSame(from: string, to: string): Promise<void> {
  if (await sameFile(from, to)) return;
  // A clone where the file system supports it (APFS, btrfs, XFS), so the run keeps one copy of the
  // video on disk; a plain copy everywhere else.
  await copyFile(from, to, constants.COPYFILE_FICLONE);
}

interface WatchFolder {
  /** The folder for the files and the page. It is created when it is missing. */
  dir: string;
  files: ClassifiedBundle;
  /** Builds the page for the links to the copies, which are the plain file names. */
  buildPage: (urls: AssetUrls) => string;
  /** The cues of the caption file, for a caller that has them. Without them they are read from the file. */
  captionCues?: CaptionCue[];
  /** The mode of the page. Without it the page gets the mode that the system gives a new file. */
  pageMode?: number;
}

/**
 * Write the watch page into a folder and copy the files next to it. The page links to the copies
 * by name, so the folder can be moved, zipped or served as it is. The page goes first: it marks the
 * folder as MergeStory's, so a run that stops halfway can be repeated. Returns the path of the page.
 */
export async function writeWatchFolder(folder: WatchFolder): Promise<string> {
  const { dir, files } = folder;
  await ensureDir(dir);

  // Browsers do not load a caption file next to a page that is opened from disk, so the page carries the cues.
  const captionCues =
    folder.captionCues ??
    (files.captions ? await readCues(files.captions.file.path, files.captions.sizeBytes) : []);
  const html = folder.buildPage({
    video: files.video.file.name,
    poster: files.poster?.file.name ?? null,
    captions: files.captions?.file.name ?? null,
    linkExpiresAt: null,
    captionCues,
  });
  const page = join(dir, WATCH_PAGE_NAME);
  await writeFile(page, html, { encoding: 'utf8', mode: folder.pageMode });
  for (const { file } of files.ordered) await copyUnlessSame(file.path, join(dir, file.name));
  return page;
}

export class LocalPublisher implements Publisher {
  readonly id = 'local';
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /** Nothing leaves the machine, so no setting and no repository can stop it. */
  async check(_ctx: PublishCheckContext, _repoIsPrivate: boolean | null): Promise<MergeStoryError | null> {
    return null;
  }

  plannedEgress(_estimatedBytes: number): EgressRecord[] {
    return [];
  }

  async publish(bundle: PublishBundle, ctx: RunContext): Promise<PublishResult> {
    const custom = this.config.publish.localDir;
    const dir = custom ? resolve(custom) : join(ctx.runDir, 'publish');
    const files = await classifyBundle(bundle);
    assertNotAborted(ctx.signal);

    if (custom) {
      const targets: Target[] = files.ordered.map((e) => ({ name: e.file.name, source: e.file.path }));
      await assertOwnFolder(dir, [...targets, { name: WATCH_PAGE_NAME, source: null }]);
    }
    await writeWatchFolder({ dir, files, buildPage: bundle.buildWatchPage });
    ctx.logger.debug('Saved the video bundle locally', {
      files: files.ordered.length + 1,
      bytes: files.totalBytes,
    });

    const fileUrl = (name: string) => pathToFileURL(join(dir, name)).href;
    return {
      provider: 'local',
      watchUrl: fileUrl(WATCH_PAGE_NAME),
      videoUrl: fileUrl(files.video.file.name),
      posterUrl: files.poster ? fileUrl(files.poster.file.name) : null,
      captionsUrl: files.captions ? fileUrl(files.captions.file.name) : null,
      expiresAt: null,
      // Nobody else can open these files, so they never count as shared.
      visibility: 'private',
      location: `${pathToFileURL(dir).href}/`,
    };
  }
}

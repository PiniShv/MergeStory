import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigInput, resolveConfig } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import type { AssetUrls, PublishBundle, PublishFile } from '../core/providers.ts';
import type { CaptionCue, PublishResult } from '../core/types.ts';
import { testContext } from '../testing/context.ts';
import { writeBundle } from '../testing/publish.ts';
import { classifyBundle } from './bundle.ts';
import { LocalPublisher, writeWatchFolder } from './local.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-local-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function context(publish: NonNullable<ConfigInput['publish']> = {}, signal?: AbortSignal): RunContext {
  return testContext({
    config: { publish: { provider: 'local', ...publish } },
    runId: 'run-1',
    runDir: join(root, 'run'),
    signal,
  }).ctx;
}

/** Publish with the settings of the run context, as createPublisher does. */
function publishLocally(bundle: PublishBundle, ctx: RunContext): Promise<PublishResult> {
  return new LocalPublisher(ctx.config).publish(bundle, ctx);
}

async function makeBundle(options: { poster?: false; captions?: false } = {}): Promise<PublishBundle> {
  return (await writeBundle({ dir: join(root, 'render'), ...options })).bundle;
}

describe('LocalPublisher', () => {
  it('copies the bundle into <runDir>/publish and writes the watch page', async () => {
    const ctx = context();
    const result = await publishLocally(await makeBundle(), ctx);
    const dir = join(ctx.runDir, 'publish');
    expect((await readdir(dir)).sort()).toEqual(['captions.vtt', 'index.html', 'poster.jpg', 'video.mp4']);
    expect(await readFile(join(dir, 'video.mp4'), 'utf8')).toBe('VIDEO-BYTES');
    expect(await readFile(join(dir, 'poster.jpg'), 'utf8')).toBe('POSTER-BYTES');
    expect(await readFile(join(dir, 'captions.vtt'), 'utf8')).toBe('WEBVTT\n');
    expect(result.provider).toBe('local');
  });

  it('returns file URLs and points the watch URL at index.html', async () => {
    const ctx = context();
    const result = await publishLocally(await makeBundle(), ctx);
    const dir = join(ctx.runDir, 'publish');
    expect(fileURLToPath(result.watchUrl ?? '')).toBe(join(dir, 'index.html'));
    expect(fileURLToPath(result.videoUrl)).toBe(join(dir, 'video.mp4'));
    expect(fileURLToPath(result.posterUrl ?? '')).toBe(join(dir, 'poster.jpg'));
    expect(fileURLToPath(result.captionsUrl ?? '')).toBe(join(dir, 'captions.vtt'));
    expect(result.location.startsWith('file://')).toBe(true);
    expect(result.location.endsWith('/publish/')).toBe(true);
    expect(result.expiresAt).toBeNull();
  });

  it('has nothing to check and nothing to send, whatever the repository is', async () => {
    const publisher = new LocalPublisher(context().config);
    for (const repoIsPrivate of [true, false, null]) {
      expect(await publisher.check(context(), repoIsPrivate)).toBeNull();
    }
    expect(publisher.plannedEgress(11_000_000)).toEqual([]);
  });

  it('never counts local files as shared, whatever the settings ask for', async () => {
    const result = await publishLocally(await makeBundle(), context({ visibility: 'public' }));
    expect(result.visibility).toBe('private');
  });

  it('writes a watch page whose relative links resolve to the copied files', async () => {
    const ctx = context();
    await publishLocally(await makeBundle(), ctx);
    const dir = join(ctx.runDir, 'publish');
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    const links = [
      /<source src="([^"]+)"/.exec(html)?.[1],
      /poster="([^"]+)"/.exec(html)?.[1],
      /<track [^>]*src="([^"]+)"/.exec(html)?.[1],
    ];
    expect(links).toEqual(['video.mp4', 'poster.jpg', 'captions.vtt']);
    for (const link of links) expect((await stat(join(dir, link ?? ''))).isFile()).toBe(true);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("media-src 'self'");
  });

  it('carries the captions inside the page, because browsers do not load a caption file from disk', async () => {
    const ctx = context();
    const bundle = await makeBundle();
    await writeFile(
      join(root, 'render', 'captions.vtt'),
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst line.\n\n00:00:02.000 --> 00:00:04.000\nSecond line.\n',
    );
    await publishLocally(bundle, ctx);
    const dir = join(ctx.runDir, 'publish');
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    expect(html).toContain('[[0,2,"First line."],[2,4,"Second line."]]');
    expect(html).not.toContain('<track');
    expect(await readFile(join(dir, 'captions.vtt'), 'utf8')).toContain('First line.');
  });

  it('works without a poster and captions', async () => {
    const ctx = context();
    const result = await publishLocally(await makeBundle({ poster: false, captions: false }), ctx);
    expect(result.posterUrl).toBeNull();
    expect(result.captionsUrl).toBeNull();
    const html = await readFile(join(ctx.runDir, 'publish', 'index.html'), 'utf8');
    expect(html).not.toContain('poster=');
    expect(html).not.toContain('<track');
  });

  it('uses publish.localDir when it is set, and creates it', async () => {
    const localDir = join(root, 'out', 'videos');
    const result = await publishLocally(await makeBundle(), context({ localDir }));
    expect((await readdir(localDir)).sort()).toEqual([
      'captions.vtt',
      'index.html',
      'poster.jpg',
      'video.mp4',
    ]);
    expect(fileURLToPath(result.watchUrl ?? '')).toBe(join(localDir, 'index.html'));
  });

  it('takes its config from the constructor, not from the run context', async () => {
    const localDir = join(root, 'from-constructor');
    const config = resolveConfig({
      skipFile: true,
      env: {},
      overrides: { publish: { provider: 'local', localDir } },
    });
    await new LocalPublisher(config).publish(await makeBundle(), context());
    expect((await readdir(localDir)).length).toBe(4);
  });

  it('sends nothing over the network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is off')));
    vi.stubGlobal('fetch', fetchSpy);
    await publishLocally(await makeBundle(), context());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('can publish again into the same folder', async () => {
    const localDir = join(root, 'again');
    const publisher = new LocalPublisher(context({ localDir }).config);
    const bundle = await makeBundle();
    await publisher.publish(bundle, context({ localDir }));
    await writeFile(join(root, 'render', 'video.mp4'), 'NEW-VIDEO');
    await publisher.publish(bundle, context({ localDir }));
    expect(await readFile(join(localDir, 'video.mp4'), 'utf8')).toBe('NEW-VIDEO');
  });

  it('copes with a bundle that already lives in the target folder', async () => {
    const localDir = join(root, 'inplace');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, 'video.mp4'), 'IN-PLACE');
    const bundle: PublishBundle = {
      ...(await makeBundle({ poster: false, captions: false })),
      files: [{ name: 'video.mp4', path: join(localDir, 'video.mp4') }],
    };
    await publishLocally(bundle, context({ localDir }));
    expect(await readFile(join(localDir, 'video.mp4'), 'utf8')).toBe('IN-PLACE');
  });

  it('leaves other files in the folder alone', async () => {
    const localDir = join(root, 'shared');
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, 'notes.txt'), 'keep me');
    await publishLocally(await makeBundle(), context({ localDir }));
    expect(await readFile(join(localDir, 'notes.txt'), 'utf8')).toBe('keep me');
  });

  describe('protects folders it did not write', () => {
    it('refuses to replace a page of its own', async () => {
      const localDir = join(root, 'docs');
      await mkdir(localDir, { recursive: true });
      await writeFile(join(localDir, 'index.html'), '<h1>My docs</h1>');
      await expect(publishLocally(await makeBundle(), context({ localDir }))).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        hint: expect.stringContaining('empty folder'),
      });
      expect(await readFile(join(localDir, 'index.html'), 'utf8')).toBe('<h1>My docs</h1>');
      expect(await readdir(localDir)).toEqual(['index.html']);
    });

    it('refuses to replace a video of its own', async () => {
      const localDir = join(root, 'movies');
      await mkdir(localDir, { recursive: true });
      await writeFile(join(localDir, 'video.mp4'), 'holiday');
      await expect(publishLocally(await makeBundle(), context({ localDir }))).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('video.mp4'),
      });
      expect(await readFile(join(localDir, 'video.mp4'), 'utf8')).toBe('holiday');
    });
  });

  describe('after a run that stopped halfway', () => {
    it('accepts the folder again, because the page was written before the copies', async () => {
      const localDir = join(root, 'videos');
      const bundle = await makeBundle();
      const files = await classifyBundle(bundle);
      await rm(join(root, 'render', 'poster.jpg')); // the copy of the poster fails after the video was copied
      await expect(
        writeWatchFolder({ dir: localDir, files, buildPage: bundle.buildWatchPage }),
      ).rejects.toThrow();
      expect(await readdir(localDir)).toContain('video.mp4');
      expect(await readdir(localDir)).toContain('index.html');

      const again = await makeBundle();
      await publishLocally(again, context({ localDir }));
      expect((await readdir(localDir)).sort()).toEqual([
        'captions.vtt',
        'index.html',
        'poster.jpg',
        'video.mp4',
      ]);
    });
  });

  describe('checks the bundle', () => {
    it('reports a file that is missing', async () => {
      const bundle = await makeBundle();
      await rm(join(root, 'render', 'poster.jpg'));
      await expect(publishLocally(bundle, context())).rejects.toMatchObject({
        code: 'PUBLISH_FAILED',
        message: expect.stringContaining('poster.jpg'),
      });
    });

    it('needs a video', async () => {
      const bundle = {
        ...(await makeBundle()),
        files: [{ name: 'captions.vtt', path: join(root, 'render', 'captions.vtt') }],
      };
      await expect(publishLocally(bundle, context())).rejects.toMatchObject({
        code: 'PUBLISH_FAILED',
      });
    });

    it('rejects names that could leave the folder', async () => {
      await writeFile(join(root, 'secret.mp4'), 'x');
      for (const name of ['../secret.mp4', 'sub/video.mp4', '..', '.hidden.mp4', 'a\\b.mp4']) {
        const bundle = { ...(await makeBundle()), files: [{ name, path: join(root, 'secret.mp4') }] };
        await expect(publishLocally(bundle, context())).rejects.toMatchObject({
          code: 'PUBLISH_FAILED',
        });
      }
      expect(await readdir(root)).not.toContain('video.mp4');
    });

    it('does not accept a second file with the same name or a file named index.html', async () => {
      const base = await makeBundle();
      const video = base.files[0] as PublishFile;
      await expect(publishLocally({ ...base, files: [video, video] }, context())).rejects.toMatchObject({
        code: 'PUBLISH_FAILED',
      });
      const page = { name: 'index.html', path: video.path };
      await expect(publishLocally({ ...base, files: [video, page] }, context())).rejects.toMatchObject({
        code: 'PUBLISH_FAILED',
      });
    });

    it('stops when the run was cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(publishLocally(await makeBundle(), context({}, controller.signal))).rejects.toMatchObject({
        code: 'ABORTED',
      });
    });
  });
});

describe('writeWatchFolder', () => {
  interface FolderOptions {
    poster?: false;
    captions?: string | false;
    captionCues?: CaptionCue[];
  }
  const classified = async (options: FolderOptions = {}) => {
    const { captionCues: _cues, ...bundleOptions } = options;
    return classifyBundle((await writeBundle({ dir: join(root, 'render'), ...bundleOptions })).bundle);
  };
  /** The links that the page is built for. */
  const linksOf = async (options: FolderOptions = {}): Promise<AssetUrls> => {
    let seen: AssetUrls | null = null;
    await writeWatchFolder({
      dir: join(root, 'watch'),
      files: await classified(options),
      ...(options.captionCues ? { captionCues: options.captionCues } : {}),
      buildPage: (urls) => {
        seen = urls;
        return '';
      },
    });
    return seen as unknown as AssetUrls;
  };

  it('copies the files, writes the page next to them and returns the path of the page', async () => {
    const dir = join(root, 'watch');
    const page = await writeWatchFolder({
      dir,
      files: await classified(),
      buildPage: () => '<p>the page</p>',
    });
    expect(page).toBe(join(dir, 'index.html'));
    expect((await readdir(dir)).sort()).toEqual(['captions.vtt', 'index.html', 'poster.jpg', 'video.mp4']);
    expect(await readFile(page, 'utf8')).toBe('<p>the page</p>');
    expect(await readFile(join(dir, 'video.mp4'), 'utf8')).toBe('VIDEO-BYTES');
  });

  it('builds the page for links to the copies by name, which never expire', async () => {
    expect(await linksOf()).toMatchObject({
      video: 'video.mp4',
      poster: 'poster.jpg',
      captions: 'captions.vtt',
      linkExpiresAt: null,
    });
    expect(await linksOf({ poster: false, captions: false })).toMatchObject({
      video: 'video.mp4',
      poster: null,
      captions: null,
      captionCues: [],
    });
  });

  it('gives the page the cues it was given, and reads them from the caption file otherwise', async () => {
    const captions = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFrom the file.\n';
    expect((await linksOf({ captions })).captionCues).toEqual([
      { startSec: 0, endSec: 2, text: 'From the file.' },
    ]);
    const given = [{ startSec: 1, endSec: 3, text: 'Given.' }];
    expect((await linksOf({ captions, captionCues: given })).captionCues).toEqual(given);
  });

  it.runIf(process.platform !== 'win32')('gives the page the mode it is asked for', async () => {
    const page = await writeWatchFolder({
      dir: join(root, 'watch'),
      files: await classified(),
      buildPage: () => '',
      pageMode: 0o600,
    });
    expect((await stat(page)).mode & 0o777).toBe(0o600);
  });
});

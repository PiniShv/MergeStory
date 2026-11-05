/**
 * YouTube publisher (YouTube Data API v3, plain HTTP).
 *
 * Uploads the video with the resumable protocol, then (each optional, each only a warning when it
 * fails) sets the thumbnail, uploads the caption track and adds the video to a playlist.
 * The privacy status is always sent: YouTube makes a video public when it is left out.
 */
import { readFile } from 'node:fs/promises';
import type { Config } from '../../core/config.ts';
import type { RunContext } from '../../core/context.ts';
import { assertNotAborted, describeProblem, MergeStoryError } from '../../core/errors.ts';
import type { PublishBundle, PublishCheckContext, Publisher, PublishMeta } from '../../core/providers.ts';
import type { EgressRecord, PublishResult } from '../../core/types.ts';
import { type BundleFile, type ClassifiedBundle, classifyBundle } from '../bundle.ts';
import { contentTypeFor } from '../content-types.ts';
import { assertNotDryRun, exposureProblem } from '../privacy.ts';
import { BUNDLE_CONTAINS } from '../types.ts';
import { loadCredentials } from './credentials.ts';
import { buildDescription, buildTags, buildTitle, youTubeLanguage } from './description.ts';
import {
  callApi,
  DEFAULT_TIMING,
  GOOGLE_ENDPOINTS,
  type Timing,
  toYouTubeError,
  type YouTubeEndpoints,
} from './google-api.ts';
import { AccessTokens } from './oauth.ts';
import { SCOPES, scopeAllows, shortScope } from './scopes.ts';
import { CHUNK_UNIT, DEFAULT_CHUNK_BYTES, uploadResumable } from './upload.ts';

type PrivacyStatus = Config['publish']['youtube']['privacyStatus'];

/** Limits of the thumbnail and caption endpoints (checked 2026-11, see the current Google docs). */
const MAX_THUMBNAIL_BYTES = 50 * 1024 * 1024;
const MAX_CAPTION_BYTES = 100 * 1024 * 1024;
/** The slowest connection that the timeout for a small upload allows for: bytes per second. */
const MIN_BYTES_PER_SEC = 20_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;
const PRIVACY_VALUES: readonly string[] = ['private', 'unlisted', 'public'];
const PRIVACY_RANK: Record<PrivacyStatus, number> = { private: 0, unlisted: 1, public: 2 };

export interface YouTubePublisherOptions {
  /** Where the Google services are. Only tests change this. */
  endpoints?: Partial<YouTubeEndpoints>;
  timing?: Partial<Timing>;
  /** Upload chunk size in bytes; a multiple of 256 KiB. */
  chunkBytes?: number;
}

/** Quota each call uses, for the cost report (checked 2026-11, see the current Google docs). */
const QUOTA = {
  'videos.insert': '1 upload call',
  'thumbnails.set': '50 units',
  'captions.insert': '400 units',
  'playlistItems.insert': '50 units',
} as const;

function apiUrl(base: string, path: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `${base.replace(/\/+$/, '')}${path}?${query}`;
}

/** Public repositories only, or a private video, or an explicit opt-in. */
function privacyProblem(config: Config, repoIsPrivate: boolean | null): MergeStoryError | null {
  return exposureProblem(config, config.publish.youtube.privacyStatus !== 'private', repoIsPrivate, {
    isPrivate: 'This repository is private, so a YouTube video that others can open is blocked.',
    unknown:
      'MergeStory cannot tell whether this repository is private, so a YouTube video that others can open is blocked.',
    hint:
      'Set publish.youtube.privacyStatus to "private" (only you can watch it, unless you share it in YouTube Studio), or set ' +
      'publish.allowPublicForPrivateRepos to true if anyone with the link may watch the video.',
  });
}

interface CreatedVideo {
  id: string;
  privacyStatus: PrivacyStatus | null;
}

function parseCreated(json: unknown): CreatedVideo {
  const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const id = typeof record.id === 'string' ? record.id : '';
  if (!VIDEO_ID.test(id)) {
    throw new MergeStoryError(
      'PUBLISH_FAILED',
      'YouTube accepted the upload but did not return a video id.',
      {
        hint: 'Check YouTube Studio: the video may exist. Delete it there before you publish again.',
      },
    );
  }
  const status =
    record.status && typeof record.status === 'object' ? (record.status as Record<string, unknown>) : {};
  const privacy = typeof status.privacyStatus === 'string' ? status.privacyStatus : '';
  return { id, privacyStatus: PRIVACY_VALUES.includes(privacy) ? (privacy as PrivacyStatus) : null };
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Everything the steps after the upload share. */
interface Run {
  ctx: RunContext;
  tokens: AccessTokens;
  /** Scopes the saved sign-in has, or null when Google did not say. */
  granted: string[] | null;
  /** Host name for the egress report. */
  host: string;
  videoId: string;
  language: string | null;
  warn: (message: string) => void;
}

export class YouTubePublisher implements Publisher {
  readonly id = 'youtube';
  private readonly config: Config;
  private readonly endpoints: YouTubeEndpoints;
  private readonly timing: Timing;
  private readonly chunkBytes: number;

  constructor(config: Config, options: YouTubePublisherOptions = {}) {
    this.config = config;
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes <= 0 || this.chunkBytes % CHUNK_UNIT !== 0) {
      throw new MergeStoryError(
        'INTERNAL',
        `The upload chunk size must be a multiple of ${CHUNK_UNIT} bytes.`,
      );
    }
  }

  /** The privacy rule first, then the sign-in (the saved one or the environment's), as the upload meets them. */
  async check(ctx: PublishCheckContext, repoIsPrivate: boolean | null): Promise<MergeStoryError | null> {
    const blocked = privacyProblem(this.config, repoIsPrivate);
    if (blocked) return blocked;
    try {
      await loadCredentials(ctx);
      return null;
    } catch (err) {
      if (err instanceof MergeStoryError) return err;
      throw err;
    }
  }

  plannedEgress(estimatedBytes: number): EgressRecord[] {
    return [
      {
        destination: new URL(this.endpoints.apiBase).hostname,
        purpose: 'video upload',
        bytes: estimatedBytes,
        contains: [...BUNDLE_CONTAINS],
      },
    ];
  }

  async publish(bundle: PublishBundle, ctx: RunContext): Promise<PublishResult> {
    const settings = this.config.publish.youtube;
    const requested = settings.privacyStatus;

    assertNotDryRun(ctx);
    // Checked first, before any network activity: the privacy rule, then the sign-in, as check() does.
    const blocked = privacyProblem(this.config, bundle.repoIsPrivate);
    if (blocked) throw blocked;
    const credentials = await loadCredentials(ctx);
    const meta = bundle.meta;
    if (!meta) {
      throw new MergeStoryError('PUBLISH_FAILED', 'The bundle has no title and description for YouTube.', {
        hint: 'Publish with `mergestory generate` or `mergestory publish`, which fill them in.',
      });
    }
    const files = await classifyBundle(bundle);
    assertNotAborted(ctx.signal);

    const tokens = new AccessTokens(
      credentials,
      { endpoints: this.endpoints, signal: ctx.signal, timing: this.timing },
      ctx,
    );
    // Sign in before reading the video, so a bad sign-in fails fast.
    await tokens.get();
    const granted = tokens.scopes;
    if (!scopeAllows(granted, 'videos.insert')) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        'The saved YouTube sign-in is not allowed to upload videos.',
        {
          hint: `Run \`mergestory setup youtube\` again and allow the permission it asks for (${shortScope(SCOPES.upload)}).`,
        },
      );
    }

    const host = new URL(this.endpoints.apiBase).hostname;
    const created = await this.uploadVideo(bundle, meta, files, ctx, tokens, host);
    const run: Run = {
      ctx,
      tokens,
      granted,
      host,
      videoId: created.id,
      language: youTubeLanguage(meta.language),
      // A warning goes to the log and to whoever listens to progress, and never stops the publish.
      warn: (message) => ctx.progress({ stage: 'publish', status: 'warn', message }),
    };

    if (created.privacyStatus && created.privacyStatus !== requested) {
      const studioUrl = `https://studio.youtube.com/video/${created.id}/edit`;
      run.warn(
        PRIVACY_RANK[created.privacyStatus] > PRIVACY_RANK[requested]
          ? `YouTube made the video "${created.privacyStatus}" although "${requested}" was requested. Check ${studioUrl} now and change it if needed.`
          : `YouTube set the video to "${created.privacyStatus}" although "${requested}" was requested. This can happen because of account or channel settings. See ${studioUrl}.`,
      );
    }

    // Everything below is optional: the video is already on YouTube, so a failure is only a warning.
    if (settings.setThumbnail && files.poster) await this.setThumbnail(run, files.poster);
    if (settings.uploadCaptions) await this.uploadCaptions(run, files.captions);
    if (settings.playlistId) await this.addToPlaylist(run, settings.playlistId);

    const visibility = created.privacyStatus ?? requested;
    const watchUrl = `https://www.youtube.com/watch?v=${created.id}`;
    return {
      provider: 'youtube',
      watchUrl,
      videoUrl: watchUrl,
      posterUrl: visibility === 'private' ? null : `https://i.ytimg.com/vi/${created.id}/hqdefault.jpg`,
      captionsUrl: null,
      expiresAt: null,
      visibility,
      location: `youtube:${created.id}`,
    };
  }

  /** Upload the video with its title, description, tags and privacy status. */
  private async uploadVideo(
    bundle: PublishBundle,
    meta: PublishMeta,
    files: ClassifiedBundle,
    ctx: RunContext,
    tokens: AccessTokens,
    host: string,
  ): Promise<CreatedVideo> {
    const settings = this.config.publish.youtube;
    const repoIsPublic = bundle.repoIsPrivate === false;
    const language = youTubeLanguage(meta.language);
    const resource = {
      snippet: {
        title: buildTitle(meta),
        description: buildDescription({ meta, repoIsPublic }),
        tags: buildTags(meta, repoIsPublic),
        categoryId: settings.categoryId,
        ...(language ? { defaultLanguage: language } : {}),
      },
      status: { privacyStatus: settings.privacyStatus, selfDeclaredMadeForKids: false, embeddable: true },
    };

    ctx.logger.info('Uploading the video to YouTube', {
      privacy: settings.privacyStatus,
      bytes: files.video.sizeBytes,
    });
    ctx.egress.record(host, 'video details', Buffer.byteLength(JSON.stringify(resource)), ['pr-metadata']);
    const contentType = contentTypeFor(files.video.file.name);
    try {
      const outcome = await uploadResumable({
        // notifySubscribers=false: a video per pull request must not ping subscribers.
        startUrl: apiUrl(this.endpoints.apiBase, '/upload/youtube/v3/videos', {
          uploadType: 'resumable',
          part: 'snippet,status',
          notifySubscribers: 'false',
        }),
        metadata: resource,
        filePath: files.video.file.path,
        sizeBytes: files.video.sizeBytes,
        contentType: contentType.startsWith('video/') ? contentType : 'application/octet-stream',
        chunkBytes: this.chunkBytes,
        tokens,
        signal: ctx.signal,
        timing: this.timing,
        redactor: ctx.redactor,
        onBytesSent: (bytes) => ctx.egress.record(host, 'video upload', bytes, ['video']),
        onProgress: (sent, total) =>
          ctx.progress({
            stage: 'publish',
            status: 'progress',
            progress: sent / total,
            message: `Uploaded ${Math.round((sent / total) * 100)}% of the video`,
          }),
        onRetry: ({ failures, reason }) =>
          ctx.logger.warn('The YouTube upload was interrupted, trying again', { attempt: failures, reason }),
      });
      const created = parseCreated(outcome.json);
      this.recordQuota(ctx, 'videos.insert', files.video.sizeBytes);
      return created;
    } catch (err) {
      throw toYouTubeError(err, 'Uploading the video to YouTube', ctx);
    }
  }

  /** Run an optional step: a failure becomes a warning, and a cancelled run skips it. */
  private async optional(run: Run, what: string, step: () => Promise<void>): Promise<void> {
    if (run.ctx.signal.aborted) {
      run.warn(`Skipped the ${what} because the run was cancelled.`);
      return;
    }
    try {
      await step();
    } catch (err) {
      const failure = toYouTubeError(err, `Setting up the ${what}`, run.ctx);
      run.warn(`The video is on YouTube, but the ${what} failed: ${describeProblem(failure)}`);
    }
  }

  /** Use the poster as the thumbnail. Custom thumbnails need a verified channel. */
  private async setThumbnail(run: Run, poster: BundleFile): Promise<void> {
    const mime = /\.png$/i.test(poster.file.name)
      ? 'image/png'
      : /\.jpe?g$/i.test(poster.file.name)
        ? 'image/jpeg'
        : null;
    if (!scopeAllows(run.granted, 'thumbnails.set')) {
      run.warn(
        'Skipped the thumbnail: the saved sign-in does not allow it. Run `mergestory setup youtube` again.',
      );
    } else if (!mime) {
      run.warn('Skipped the thumbnail: YouTube accepts JPEG and PNG images only.');
    } else if (poster.sizeBytes > MAX_THUMBNAIL_BYTES) {
      run.warn('Skipped the thumbnail: it is larger than the 50 MB that YouTube allows.');
    } else {
      await this.optional(run, 'thumbnail', async () => {
        const bytes = await readFile(poster.file.path);
        run.ctx.egress.record(run.host, 'video thumbnail', bytes.length, ['video']);
        await callApi(
          {
            url: apiUrl(this.endpoints.apiBase, '/upload/youtube/v3/thumbnails/set', {
              videoId: run.videoId,
              uploadType: 'media',
            }),
            method: 'POST',
            headers: { 'Content-Type': mime },
            body: bytes,
            timeoutMs: this.timing.requestTimeoutMs + Math.ceil(bytes.length / MIN_BYTES_PER_SEC) * 1000,
          },
          { tokens: run.tokens, signal: run.ctx.signal, timing: this.timing },
        );
        this.recordQuota(run.ctx, 'thumbnails.set', bytes.length);
      });
    }
  }

  /** Upload the WebVTT file as a caption track. This costs 400 units of quota, so it is opt-in. */
  private async uploadCaptions(run: Run, captions: BundleFile | null): Promise<void> {
    if (!captions) {
      run.warn('Skipped the captions: the bundle has no caption file.');
    } else if (!scopeAllows(run.granted, 'captions.insert')) {
      run.warn(
        `Skipped the captions: they need the ${shortScope(SCOPES.forceSsl)} permission. Run \`mergestory setup youtube\` again with captions turned on.`,
      );
    } else if (captions.sizeBytes > MAX_CAPTION_BYTES || captions.sizeBytes === 0) {
      run.warn('Skipped the captions: the caption file is empty or larger than YouTube allows.');
    } else {
      await this.optional(run, 'captions', async () => {
        const code = run.language ?? 'en';
        run.ctx.egress.record(run.host, 'captions', captions.sizeBytes, ['narration-text']);
        await uploadResumable({
          startUrl: apiUrl(this.endpoints.apiBase, '/upload/youtube/v3/captions', {
            uploadType: 'resumable',
            part: 'snippet',
          }),
          metadata: {
            snippet: { videoId: run.videoId, language: code, name: languageName(code), isDraft: false },
          },
          filePath: captions.file.path,
          sizeBytes: captions.sizeBytes,
          contentType: 'application/octet-stream',
          chunkBytes: this.chunkBytes,
          tokens: run.tokens,
          signal: run.ctx.signal,
          timing: this.timing,
          redactor: run.ctx.redactor,
        });
        this.recordQuota(run.ctx, 'captions.insert', captions.sizeBytes);
      });
    }
  }

  private async addToPlaylist(run: Run, playlistId: string): Promise<void> {
    if (!scopeAllows(run.granted, 'playlistItems.insert')) {
      run.warn(
        `Skipped the playlist: it needs the ${shortScope(SCOPES.forceSsl)} permission. Run \`mergestory setup youtube\` again with the playlist set.`,
      );
      return;
    }
    await this.optional(run, 'playlist entry', async () => {
      await callApi(
        {
          url: apiUrl(this.endpoints.apiBase, '/youtube/v3/playlistItems', { part: 'snippet' }),
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({
            snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: run.videoId } },
          }),
        },
        { tokens: run.tokens, signal: run.ctx.signal, timing: this.timing },
      );
      this.recordQuota(run.ctx, 'playlistItems.insert');
    });
  }

  /** The Data API has no price, only a quota: the cost is zero, and the quota use is named. */
  private recordQuota(ctx: RunContext, method: keyof typeof QUOTA, bytes?: number): void {
    ctx.cost.record({
      provider: 'youtube',
      kind: 'other',
      model: `${method} (${QUOTA[method]})`,
      ...(bytes === undefined ? {} : { bytes }),
      costUsd: 0,
      estimated: false,
    });
  }
}

/** Returns the publisher for provider "youtube". */
export function createYouTubePublisher(config: Config, options: YouTubePublisherOptions = {}): Publisher {
  return new YouTubePublisher(config, options);
}

/**
 * Google Drive publisher (Drive API v3, plain HTTP).
 *
 * Uploads the video into a folder named MergeStory that MergeStory created (the drive.file permission
 * reaches nothing else), then shares it as publish.visibility says. When the share fails, the video
 * stays private in the user's Drive and the publish still succeeds, with a warning.
 */
import type { Config } from '../../core/config.ts';
import type { RunContext } from '../../core/context.ts';
import { assertNotAborted, describeProblem, MergeStoryError } from '../../core/errors.ts';
import type { PublishBundle, PublishCheckContext, Publisher } from '../../core/providers.ts';
import type { EgressContent, EgressRecord, PublishResult } from '../../core/types.ts';
import { classifyBundle } from '../bundle.ts';
import { type GoogleCredentials, loadCredentials } from '../google/credentials.ts';
import {
  type ApiCall,
  apiUrl,
  callApi,
  DEFAULT_TIMING,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type Timing,
  toGoogleError,
} from '../google/google-api.ts';
import { AccessTokens } from '../google/oauth.ts';
import { CHUNK_UNIT, DEFAULT_CHUNK_BYTES, uploadResumable } from '../google/upload.ts';
import { assertNotDryRun, exposureProblem } from '../privacy.ts';
import { safeHttpUrl } from '../text.ts';
import { BUNDLE_CONTAINS } from '../types.ts';
import { DRIVE, DRIVE_FILE_SCOPE } from './provider.ts';
import { buildDriveDescription, buildFileName } from './text.ts';

export const FOLDER_NAME = 'MergeStory';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,webViewLink';
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** Google accounts that belong to no organization, so a "protected" link has nobody to share with. */
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export interface DrivePublisherOptions {
  /** Where the Google services are. Only tests change this. */
  endpoints?: Partial<GoogleEndpoints>;
  timing?: Partial<Timing>;
  /** Upload chunk size in bytes; a multiple of 256 KiB. */
  chunkBytes?: number;
}

interface DriveFile {
  id: string;
  webViewLink: string;
}

/** Everything the steps of one publish share. */
interface Run {
  ctx: RunContext;
  tokens: AccessTokens;
  host: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A file or folder as Google sent it, or null when it lacks a usable id or link. */
function toDriveFile(value: unknown): DriveFile | null {
  const item = record(value);
  const id = typeof item.id === 'string' && FILE_ID.test(item.id) ? item.id : null;
  const webViewLink = safeHttpUrl(item.webViewLink);
  return id && webViewLink ? { id, webViewLink } : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Only "public" can reach people outside the organization, so only it meets the private-repository rule. */
function privacyProblem(config: Config, repoIsPrivate: boolean | null): MergeStoryError | null {
  return exposureProblem(config, config.publish.visibility === 'public', repoIsPrivate, {
    isPrivate: 'This repository is private, so a Google Drive link that anyone can open is blocked.',
    unknown:
      'MergeStory cannot tell whether this repository is private, so a Google Drive link that anyone can open is blocked.',
    hint:
      'Use --visibility protected (people in your organization) or private (only you), or set ' +
      'publish.allowPublicForPrivateRepos to true if anyone with the link may watch the video.',
  });
}

/** The organization part of an e-mail address, or null when there is none. */
export function domainOf(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  const domain =
    at > 0
      ? email
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : '';
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** true for a domain that can be shared with: a Google Workspace organization, not a personal account. */
export function isWorkspaceDomain(domain: string): boolean {
  return !CONSUMER_DOMAINS.has(domain);
}

export class DrivePublisher implements Publisher {
  readonly id = 'drive';
  private readonly config: Config;
  private readonly endpoints: GoogleEndpoints;
  private readonly timing: Timing;
  private readonly chunkBytes: number;

  constructor(config: Config, options: DrivePublisherOptions = {}) {
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

  /** The privacy rule first, then the sign-in, as the upload meets them. */
  async check(ctx: PublishCheckContext, repoIsPrivate: boolean | null): Promise<MergeStoryError | null> {
    const blocked = privacyProblem(this.config, repoIsPrivate);
    if (blocked) return blocked;
    try {
      await loadCredentials(ctx, DRIVE);
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
    const requested = this.config.publish.visibility;
    assertNotDryRun(ctx);
    // Checked first, before any network activity: the privacy rule, then the sign-in, as check() does.
    const blocked = privacyProblem(this.config, bundle.repoIsPrivate);
    if (blocked) throw blocked;
    const credentials = await loadCredentials(ctx, DRIVE);
    const meta = bundle.meta;
    if (!meta) {
      throw new MergeStoryError(
        'PUBLISH_FAILED',
        'The bundle has no title and description for Google Drive.',
        {
          hint: 'Publish with `mergestory generate` or `mergestory publish`, which fill them in.',
        },
      );
    }
    const files = await classifyBundle(bundle);
    assertNotAborted(ctx.signal);
    // Sign in before reading the video, so a bad sign-in fails fast.
    const run = await this.signIn(ctx, credentials);

    // Known before the upload, so a personal account never uploads a video it cannot share as asked.
    const domain = requested === 'protected' ? await this.requireDomain(run) : null;
    const folder = await this.step(run, 'Finding the MergeStory folder in Google Drive', () =>
      this.folder(run),
    );
    const file = await this.step(run, 'Uploading the video to Google Drive', () =>
      this.upload(run, files.video.file.path, files.video.sizeBytes, folder.id, meta),
    );
    const visibility = requested === 'private' ? 'private' : await this.share(run, file.id, domain);
    return {
      provider: 'drive',
      watchUrl: file.webViewLink,
      videoUrl: file.webViewLink,
      posterUrl: null,
      captionsUrl: null,
      expiresAt: null,
      visibility,
      location: folder.webViewLink,
    };
  }

  /** The organization domain of the signed-in account, for `mergestory doctor --online`. Never the e-mail address. */
  async accountDomain(ctx: RunContext): Promise<string | null> {
    const run = await this.signIn(ctx, await loadCredentials(ctx, DRIVE));
    return this.step(run, 'Reading the Google account', () => this.domain(run));
  }

  private async signIn(ctx: RunContext, credentials: GoogleCredentials): Promise<Run> {
    const tokens = new AccessTokens(
      credentials,
      { endpoints: this.endpoints, provider: DRIVE, signal: ctx.signal, timing: this.timing },
      ctx,
    );
    await tokens.get();
    if (tokens.scopes && !tokens.scopes.includes(DRIVE_FILE_SCOPE)) {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        'The saved Google Drive sign-in is not allowed to upload files.',
        {
          hint: 'Run `mergestory setup drive` again and allow the permission it asks for (drive.file).',
        },
      );
    }
    return { ctx, tokens, host: new URL(this.endpoints.apiBase).hostname };
  }

  /** Run a step and explain a failure in Google Drive's words. */
  private async step<T>(run: Run, action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toGoogleError(err, action, run.ctx, DRIVE);
    }
  }

  /** One API call, recorded as egress first. Returns the answer's body. */
  private async call(
    run: Run,
    purpose: string,
    call: ApiCall,
    contains: EgressContent[] = [],
  ): Promise<string> {
    run.ctx.egress.record(
      run.host,
      purpose,
      call.body === undefined ? 0 : Buffer.byteLength(call.body),
      contains,
    );
    const answer = await callApi(call, { tokens: run.tokens, signal: run.ctx.signal, timing: this.timing });
    return answer.text;
  }

  private async requireDomain(run: Run): Promise<string> {
    const domain = await this.step(run, 'Reading the Google account', () => this.domain(run));
    if (domain && isWorkspaceDomain(domain)) return domain;
    throw new MergeStoryError(
      'CONFIG_INVALID',
      domain
        ? 'Protected links need a Google Workspace account.'
        : 'Google did not say which organization the signed-in account belongs to.',
      { hint: 'Use --visibility private, or public for public code.' },
    );
  }

  /** Ask Google which account is signed in (about.get), and keep only the part after the @. */
  private async domain(run: Run): Promise<string | null> {
    const text = await this.call(run, 'account domain', {
      url: apiUrl(this.endpoints.apiBase, '/drive/v3/about', { fields: 'user(emailAddress)' }),
      method: 'GET',
    });
    return domainOf(record(record(parseJson(text)).user).emailAddress);
  }

  /**
   * The MergeStory folder: one this app made before in the user's own Drive, or a new one. A folder
   * someone else owns, or one that is shared, is never used: files inside a folder take on its
   * sharing, so a private video would not stay private.
   */
  private async folder(run: Run): Promise<DriveFile> {
    const text = await this.call(run, 'folder lookup', {
      url: apiUrl(this.endpoints.apiBase, '/drive/v3/files', {
        // FOLDER_NAME holds no quote or backslash, so it needs no escaping.
        q: `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners and 'root' in parents`,
        spaces: 'drive',
        fields: `files(${FILE_FIELDS},shared)`,
      }),
      method: 'GET',
    });
    const found = record(parseJson(text)).files;
    for (const item of Array.isArray(found) ? found : []) {
      const folder = record(item).shared === false ? toDriveFile(item) : null;
      if (folder) return folder;
    }
    // shortcut: two first uploads at the same moment can each make a folder; later runs use the first one found.
    const created = await this.call(run, 'folder creation', {
      url: apiUrl(this.endpoints.apiBase, '/drive/v3/files', { fields: FILE_FIELDS }),
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    const folder = toDriveFile(parseJson(created));
    if (!folder) {
      throw new MergeStoryError('PUBLISH_FAILED', 'Google Drive did not return the new MergeStory folder.', {
        hint: 'Try again in a few minutes.',
      });
    }
    return folder;
  }

  private async upload(
    run: Run,
    path: string,
    sizeBytes: number,
    folderId: string,
    meta: NonNullable<PublishBundle['meta']>,
  ): Promise<DriveFile> {
    const { ctx, host } = run;
    const metadata = {
      name: buildFileName(meta),
      parents: [folderId],
      description: buildDriveDescription(meta),
      mimeType: 'video/mp4',
    };
    ctx.logger.info('Uploading the video to Google Drive', { bytes: sizeBytes });
    ctx.egress.record(host, 'video details', Buffer.byteLength(JSON.stringify(metadata)), ['pr-metadata']);
    const outcome = await uploadResumable({
      label: DRIVE.label,
      startUrl: apiUrl(this.endpoints.apiBase, '/upload/drive/v3/files', {
        uploadType: 'resumable',
        fields: FILE_FIELDS,
      }),
      metadata,
      filePath: path,
      sizeBytes,
      contentType: 'video/mp4',
      chunkBytes: this.chunkBytes,
      tokens: run.tokens,
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
        ctx.logger.warn('The Google Drive upload was interrupted, trying again', {
          attempt: failures,
          reason,
        }),
    });
    const file = toDriveFile(outcome.json);
    if (!file) {
      throw new MergeStoryError(
        'PUBLISH_FAILED',
        'Google Drive accepted the upload but did not return its link.',
        {
          hint: `Look in the ${FOLDER_NAME} folder of your Google Drive: the video may be there.`,
        },
      );
    }
    return file;
  }

  /**
   * Share the file as asked: the organization (domain) or anyone with the link, never findable in search.
   * sendNotificationEmail is left out: Google accepts it only for people and groups. A failure leaves the
   * file private and becomes a warning, because the video is already safely in the user's Drive.
   */
  private async share(
    run: Run,
    fileId: string,
    domain: string | null,
  ): Promise<'protected' | 'public' | 'private'> {
    const permission = domain
      ? { type: 'domain', role: 'reader', domain, allowFileDiscovery: false }
      : { type: 'anyone', role: 'reader', allowFileDiscovery: false };
    try {
      await this.call(run, 'sharing', {
        url: apiUrl(this.endpoints.apiBase, `/drive/v3/files/${fileId}/permissions`, { fields: 'id' }),
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(permission),
      });
      return domain ? 'protected' : 'public';
    } catch (err) {
      const failure = toGoogleError(err, 'Sharing the video', run.ctx, DRIVE);
      if (failure.code === 'ABORTED') throw failure;
      run.ctx.progress({
        stage: 'publish',
        status: 'warn',
        message:
          `The video is in the ${FOLDER_NAME} folder of your Google Drive, but it could not be shared, so only you can open it: ` +
          `${describeProblem(failure)} You can share it yourself in Google Drive.`,
      });
      return 'private';
    }
  }
}

/** Returns the publisher for provider "drive". */
export function createDrivePublisher(config: Config, options: DrivePublisherOptions = {}): Publisher {
  return new DrivePublisher(config, options);
}

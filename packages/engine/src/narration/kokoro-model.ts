/**
 * The Kokoro speech model files: where they live, how they are downloaded and how they are
 * checked. Files come from one pinned Hugging Face commit and each one must match a known
 * SHA-256 digest before it is used. A file that is missing or damaged is downloaded again; a
 * download that does not match is refused.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MergeStoryError } from '../core/errors.ts';
import { randomToken } from '../core/ids.ts';
import { fetchWithRetry } from '../core/retry.ts';

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** Hugging Face commit that the model files are pinned to. */
export const KOKORO_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_MODEL_HOST = 'huggingface.co';

export type KokoroDtype = 'fp32' | 'q8';

export interface ModelFile {
  /** Path inside the model repository. */
  path: string;
  bytes: number;
  sha256: string;
}

const COMMON_FILES: ModelFile[] = [
  {
    path: 'config.json',
    bytes: 44,
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  },
  {
    path: 'tokenizer.json',
    bytes: 3497,
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 113,
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  },
];

const ONNX_FILES: Record<KokoroDtype, ModelFile> = {
  fp32: {
    path: 'onnx/model.onnx',
    bytes: 325_532_232,
    sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
  },
  q8: {
    path: 'onnx/model_quantized.onnx',
    bytes: 92_361_116,
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
  },
};

/** Files needed for one precision. */
export function kokoroModelFiles(dtype: KokoroDtype): ModelFile[] {
  return [...COMMON_FILES, ONNX_FILES[dtype]];
}

/** Size of the download for one precision, in megabytes (rounded). */
export function kokoroDownloadMb(dtype: KokoroDtype): number {
  return Math.round(ONNX_FILES[dtype].bytes / 1_000_000);
}

/**
 * Precision to use. fp32 is two to three times faster on Apple Silicon; q8 is a much smaller
 * download elsewhere. MERGESTORY_KOKORO_DTYPE overrides ("fp32" or "q8").
 */
export function kokoroDtype(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): KokoroDtype {
  const requested = env.MERGESTORY_KOKORO_DTYPE?.trim().toLowerCase();
  if (requested) {
    if (requested === 'fp32' || requested === 'q8') return requested;
    throw new MergeStoryError(
      'CONFIG_INVALID',
      `MERGESTORY_KOKORO_DTYPE must be "fp32" or "q8", not "${requested.slice(0, 20)}".`,
      {
        hint: 'fp32 is faster and needs a 326 MB download; q8 needs 92 MB.',
      },
    );
  }
  return platform === 'darwin' && arch === 'arm64' ? 'fp32' : 'q8';
}

/** Folder inside the models folder where transformers.js looks for this model. */
export function kokoroModelDir(modelsRoot: string): string {
  return join(modelsRoot, ...KOKORO_MODEL_ID.split('/'));
}

/** Cheap check for status displays: every file exists with the expected size (no hashing). */
export async function isKokoroModelCached(modelsRoot: string, dtype: KokoroDtype): Promise<boolean> {
  for (const file of kokoroModelFiles(dtype)) {
    try {
      const info = await stat(join(kokoroModelDir(modelsRoot), file.path));
      if (info.size !== file.bytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function matchesExpected(path: string, file: ModelFile): Promise<boolean> {
  try {
    if ((await stat(path)).size !== file.bytes) return false;
    return (await sha256OfFile(path)) === file.sha256;
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
}

export interface EnsureModelOptions {
  modelsRoot: string;
  /** Files to check, usually kokoroModelFiles(dtype). */
  files: ModelFile[];
  /** Base URL of the pinned model revision; defaults to the pinned Hugging Face commit. */
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  onDownloadStart?: (file: ModelFile) => void;
  /** Retry settings for the HTTP request (tests use short delays). */
  retry?: { attempts?: number; minDelayMs?: number; maxDelayMs?: number };
}

function checksumError(file: ModelFile): MergeStoryError {
  return new MergeStoryError(
    'TTS_FAILED',
    `The downloaded Kokoro model file ${file.path} does not match its expected checksum, so it was not used.`,
    {
      hint: 'Run again. If it keeps failing, the download source may be blocked or altered; use another speech provider.',
    },
  );
}

async function downloadVerified(file: ModelFile, target: string, options: EnsureModelOptions): Promise<void> {
  const base =
    options.baseUrl ?? `https://${KOKORO_MODEL_HOST}/${KOKORO_MODEL_ID}/resolve/${KOKORO_MODEL_REVISION}`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.${randomToken(4)}.part`;
  try {
    const response = await fetchWithRetry(
      `${base}/${file.path}`,
      {},
      { signal: options.signal, timeoutMs: 30 * 60_000, ...options.retry },
    );
    if (!response.body) {
      throw new MergeStoryError('TTS_FAILED', 'The model download returned no data.', {
        hint: 'Check the network connection and run again.',
      });
    }
    const hash = createHash('sha256');
    const total = Number(response.headers.get('content-length')) || file.bytes;
    let loaded = 0;
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          loaded += chunk.length;
          options.onProgress?.({ file: file.path, loaded, total });
          yield chunk;
        }
      },
      createWriteStream(partial, { mode: 0o600 }),
      options.signal ? { signal: options.signal } : {},
    );
    if (loaded !== file.bytes || hash.digest('hex') !== file.sha256) throw checksumError(file);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Make sure every model file is present and matches its digest. Existing files are hashed
 * (a few hundred milliseconds), so a damaged file is never loaded.
 *
 * Safe when several processes download at once: each one writes its own temporary file, checks
 * its hash and renames it over the target in one step. The target is never deleted first, so a
 * file that another process has just finished is never removed while it is being loaded.
 */
export async function ensureModelFiles(options: EnsureModelOptions): Promise<void> {
  for (const file of options.files) {
    const target = join(kokoroModelDir(options.modelsRoot), file.path);
    if (await matchesExpected(target, file)) continue;
    options.onDownloadStart?.(file);
    try {
      await downloadVerified(file, target, options);
    } catch (err) {
      if (err instanceof MergeStoryError || options.signal?.aborted) throw err;
      throw new MergeStoryError(
        'TTS_FAILED',
        `The Kokoro voice model could not be downloaded: ${(err as Error).message}`,
        {
          hint: `The first run needs access to ${KOKORO_MODEL_HOST}. Check the network, or use another speech provider with --tts.`,
          cause: err,
        },
      );
    }
  }
}

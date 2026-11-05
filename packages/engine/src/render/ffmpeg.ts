/**
 * FFmpeg helpers: encoder arguments, segment encoders fed over a pipe, concatenation with the
 * audio mux, and probing.
 *
 * All commands run without a shell and with argument arrays. Paths passed to FFmpeg are always
 * absolute, so they can never be read as options.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { MergeStoryError } from '../core/errors.ts';
import { runCommand } from '../core/process.ts';

/**
 * Chrome writes JPEG frames as full-range BT.601 YCbCr. The video is limited-range BT.709, so the
 * frames go through RGB (exact in every FFmpeg version) and are then tagged. Without this the
 * output keeps the JPEG's full range, and players that ignore the range flag show washed colours.
 */
export const COLOR_FILTER = [
  'scale=in_range=full:in_color_matrix=bt601:flags=accurate_rnd+full_chroma_int',
  'format=rgb24',
  'scale=out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int',
  'format=yuv420p',
  'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
].join(',');

export interface SegmentEncodeOptions {
  fps: number;
  crf: number;
  x264Preset: string;
  /** Keyframe interval in frames. Every segment starts with a keyframe. */
  gop: number;
  /** Fixed, so the same plan encodes to the same bytes on any machine. */
  threads: number;
  outPath: string;
}

/** Arguments that turn a stream of JPEG frames on stdin into one H.264 segment. */
export function segmentEncodeArgs(o: SegmentEncodeOptions): string[] {
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', 'mjpeg', '-i', '-'],
    ...['-vf', COLOR_FILTER],
    ...['-c:v', 'libx264', '-preset', o.x264Preset, '-crf', String(o.crf)],
    ...['-pix_fmt', 'yuv420p', '-profile:v', 'high'],
    ...['-g', String(o.gop), '-keyint_min', String(o.gop), '-sc_threshold', '0'],
    ...['-threads', String(o.threads)],
    ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
    ...['-an', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact'],
    o.outPath,
  ];
}

export interface MuxOptions {
  /** Concat list written by writeConcatList. */
  listPath: string;
  /** Mixed narration track (WAV), or null for a silent video. */
  audioPath: string | null;
  outPath: string;
  /** Length of the video. The audio is padded or cut to exactly this length. */
  durationSec: number;
}

/**
 * Arguments that join the segments without re-encoding and add the audio as AAC. Metadata is
 * stripped, including the encoder's own settings string, and the index is moved to the front so
 * the video starts playing before it has fully downloaded.
 */
export function muxArgs(o: MuxOptions): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', o.listPath];
  if (o.audioPath) args.push('-i', o.audioPath);
  args.push('-map', '0:v:0');
  if (o.audioPath) args.push('-map', '1:a:0');
  // SEI NAL units carry only the encoder's version and settings text.
  args.push('-c:v', 'copy', '-bsf:v', 'filter_units=remove_types=6');
  if (o.audioPath) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-af', 'apad', '-t', o.durationSec.toFixed(6));
  }
  args.push(
    ...['-movflags', '+faststart', '-map_metadata', '-1'],
    ...['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'],
    o.outPath,
  );
  return args;
}

/** Text of a concat demuxer list. Single quotes in paths are escaped. */
export function concatListText(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return paths
    .map((path) => {
      if (/[\r\n]/.test(path)) {
        throw new MergeStoryError('RENDER_FAILED', 'A temporary file path contains a line break.', {
          hint: 'Use an output folder whose path has no line breaks.',
        });
      }
      const normal = platform === 'win32' ? path.replace(/\\/g, '/') : path;
      return `file '${normal.replace(/'/g, `'\\''`)}'`;
    })
    .join('\n')
    .concat('\n');
}

/** Joining the segments takes seconds to minutes; this only stops FFmpeg when it hangs. */
const MUX_TIMEOUT_MS = 30 * 60_000;

export async function concatAndMux(
  ffmpegPath: string,
  options: MuxOptions,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runCommand(ffmpegPath, muxArgs(options), {
      signal,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: MUX_TIMEOUT_MS,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new MergeStoryError('RENDER_FAILED', 'FFmpeg could not assemble the video.', {
      hint: 'Check that FFmpeg 4.4 or newer with libx264 is installed. Run "mergestory doctor".',
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Duration of a media file in seconds. */
export async function probeDuration(
  ffprobePath: string,
  file: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runCommand(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      '-i',
      file,
    ],
    { signal },
  );
  const seconds = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new MergeStoryError('RENDER_FAILED', 'The rendered video has no readable duration.');
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Segment encoder
// ---------------------------------------------------------------------------

/** An FFmpeg process that encodes JPEG frames written to it. */
export class SegmentEncoder {
  private readonly child: ChildProcess;
  private stderr = '';
  private failure: Error | null = null;
  private closed = false;
  private readonly done: Promise<void>;

  private constructor(child: ChildProcess, done: Promise<void>) {
    this.child = child;
    this.done = done;
  }

  /** Start ffmpeg with the given arguments. Frames go to its stdin. */
  static start(ffmpegPath: string, args: string[]): SegmentEncoder {
    const child = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let self: SegmentEncoder | null = null;
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        const error =
          err.code === 'ENOENT'
            ? new MergeStoryError('FFMPEG_NOT_FOUND', 'ffmpeg could not be started.', {
                hint: 'Install FFmpeg or set MERGESTORY_FFMPEG_PATH.',
                cause: err,
              })
            : new MergeStoryError('RENDER_FAILED', 'ffmpeg could not be started.', { cause: err });
        if (self) self.failure = error;
        reject(error);
      });
      child.on('close', (code) => {
        if (self) self.closed = true;
        if (code === 0) {
          resolve();
          return;
        }
        const tail = (self?.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
        const error = new MergeStoryError(
          'RENDER_FAILED',
          `ffmpeg stopped while encoding (exit code ${code}): ${tail}`,
          {
            hint: 'Check that FFmpeg 4.4 or newer with libx264 is installed. Run "mergestory doctor".',
          },
        );
        if (self) self.failure = error;
        reject(error);
      });
    });
    done.catch(() => undefined); // callers observe the failure through write() and finish()
    self = new SegmentEncoder(child, done);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (self && self.stderr.length < 8192) self.stderr += chunk.toString('utf8');
    });
    child.stdin?.on('error', () => undefined); // a broken pipe is reported by the close handler
    return self;
  }

  /** Write one JPEG frame, waiting when the pipe is full. */
  async write(frame: Buffer): Promise<void> {
    const stdin = this.child.stdin;
    if (this.failure) throw this.failure;
    if (!stdin || this.closed || stdin.destroyed || !stdin.writable) {
      throw new MergeStoryError('RENDER_FAILED', 'ffmpeg stopped before all frames were written.');
    }
    if (stdin.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stdin.off('drain', onDrain);
        this.child.off('close', onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(
          this.failure ??
            new MergeStoryError('RENDER_FAILED', 'ffmpeg stopped before all frames were written.'),
        );
      };
      stdin.once('drain', onDrain);
      this.child.once('close', onClose);
    });
  }

  /** Close the input and wait for ffmpeg to finish. Rejects when ffmpeg fails. */
  finish(): Promise<void> {
    if (!this.closed && this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
    return this.done;
  }

  /** Stop ffmpeg now. */
  kill(): void {
    if (!this.closed) this.child.kill('SIGKILL');
  }
}

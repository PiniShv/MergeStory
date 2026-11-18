/**
 * Frames of a recording. FFmpeg cuts the part of the clip that a scene shows into JPEG files, so the
 * render never has to decode a video: it only picks one image for each moment.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Config } from '../core/config.ts';
import { abortedError, MergeStoryError } from '../core/errors.ts';
import { DECODER_ARGS, INPUT_WHITELIST_ARGS, shownName } from '../core/media-probe.ts';
import { runCommand } from '../core/process.ts';
import { frameDirFor, RECORDING_BOX, RECORDING_FPS } from '../core/recording-frames.ts';
import type { FrameSet } from '../core/render-plan.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs, RecordingInput } from '../core/types.ts';
import { detectImage } from './image.ts';

const EXTRACT_TIMEOUT_MS = 120_000;

/** What the extraction made: enough for the plan to name the frames. */
export type ExtractedFrames = Pick<FrameSet, 'dir' | 'count' | 'width' | 'height'>;

export interface FrameRequest {
  recording: RecordingInput;
  /** The part of the clip, in seconds of the clip (already checked to lie inside it). */
  trim: { start: number; end: number };
  zoom: { x: number; y: number; w: number; h: number } | null;
  /** The frames are scaled down to fit this box, never up. */
  box: { width: number; height: number };
  /** Absolute folder for the frames. It is emptied first. */
  outDir: string;
}

const even = (n: number): number => Math.max(2, 2 * Math.floor(n / 2));

/** The crop (whole frame when there is no zoom) and the size after scaling down to the box, both with even sides. */
export function frameGeometry(
  source: { width: number; height: number },
  zoom: FrameRequest['zoom'],
  box: FrameRequest['box'],
): { crop: { x: number; y: number; w: number; h: number }; width: number; height: number } {
  const w = zoom ? Math.min(source.width, even(source.width * zoom.w)) : source.width;
  const h = zoom ? Math.min(source.height, even(source.height * zoom.h)) : source.height;
  const x = zoom ? Math.min(source.width - w, Math.round(source.width * zoom.x)) : 0;
  const y = zoom ? Math.min(source.height - h, Math.round(source.height * zoom.y)) : 0;
  const scale = Math.min(1, box.width / w, box.height / h);
  return { crop: { x, y, w, h }, width: even(w * scale), height: even(h * scale) };
}

/** Cut the frames of one use of a recording. Throws USAGE, naming the recording, when it cannot be decoded. */
export async function extractFrames(
  ffmpeg: string,
  request: FrameRequest,
  signal?: AbortSignal,
): Promise<{ count: number; width: number; height: number }> {
  const { recording, trim, zoom, outDir } = request;
  const geometry = frameGeometry(recording, zoom, request.box);
  const { crop } = geometry;
  const refuse = (reason: string, cause?: unknown): MergeStoryError =>
    new MergeStoryError(
      'USAGE',
      `Recording ${recording.id} (${shownName(recording.path)}) could not be decoded: ${reason}.`,
      { hint: 'Record it again, or leave it out of the video.', cause },
    );
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  // FFmpeg reads a number such as 1e-7 as an error, so every time is written with three decimals.
  const seconds = (value: number): string => value.toFixed(3);
  const filter = [
    // The rate comes first. A screen recording has no frames while nothing moves, and this step fills
    // those gaps (and a late start) with the picture that was on screen, so the cut that follows
    // shows the right moment. The last picture is held to the end of the part.
    `fps=${RECORDING_FPS}:start_time=0`,
    `tpad=stop_mode=clone:stop_duration=${seconds(trim.end)}`,
    `trim=start=${seconds(trim.start)}:end=${seconds(trim.end)}`,
    'setpts=PTS-STARTPTS',
    ...(zoom ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []),
    // A JPEG is read as BT.601 with the full range. Without these two, the colours of a BT.709 recording shift.
    `scale=${geometry.width}:${geometry.height}:out_color_matrix=bt601:out_range=pc`,
  ].join(',');
  const result = await runCommand(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...INPUT_WHITELIST_ARGS,
      ...DECODER_ARGS,
      '-i',
      recording.path,
      // The video track that the probe checked, whichever track the file marks as its default.
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      filter,
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      '3',
      '-start_number',
      '1',
      // FFmpeg reads "%" anywhere in this path as part of the pattern.
      join(outDir.replaceAll('%', '%%'), 'f-%05d.jpg'),
    ],
    // FFmpeg decodes the clip from its start to the end of the part, so a later part gets more time.
    {
      timeoutMs: EXTRACT_TIMEOUT_MS + Math.ceil(trim.end) * 1000,
      allowFailure: true,
      signal,
      maxOutputBytes: 1024 * 1024,
    },
  ).catch((err: unknown) => {
    if (signal?.aborted) throw abortedError(err);
    if (err instanceof Error && err.name === 'TimedOutError') throw refuse('it took too long', err);
    throw refuse('FFmpeg stopped', err);
  });
  if (result.code !== 0) throw refuse('FFmpeg reported an error');
  const count = (await readdir(outDir)).filter((name) => /^f-\d{5}\.jpg$/.test(name)).length;
  if (count === 0) throw refuse('the part to show has no picture');
  const first = detectImage(await readFile(join(outDir, 'f-00001.jpg')));
  if (!first) throw refuse('its pictures could not be read');
  return { count, width: first.width, height: first.height };
}

/**
 * Cut the frames of every recording that the storyboard shows, into `recording-frames/s-<number>[.side]`
 * in the run folder, where the number is the scene's place in the storyboard. Returns them by folder
 * name. A scene's own use honours its trim and zoom; a panel shows the clip from its start, at most
 * `inputs.maxClipSeconds` of it.
 */
export async function extractStoryboardFrames(
  storyboard: Storyboard,
  inputs: ContextInputs,
  config: Config,
  runDir: string,
  signal: AbortSignal,
): Promise<Map<string, ExtractedFrames>> {
  const uses: { dir: string; request: Omit<FrameRequest, 'outDir'> }[] = [];
  const recordingFor = (id: string): RecordingInput => {
    const recording = inputs.recordings.find((r) => r.id === id);
    if (!recording) throw new MergeStoryError('INTERNAL', `The recording ${id} is not part of this run.`);
    return recording;
  };
  const maxClip = config.inputs.maxClipSeconds;
  for (const [index, scene] of storyboard.scenes.entries()) {
    const { visual } = scene;
    if (visual.type === 'recording') {
      const recording = recordingFor(visual.recordingId);
      uses.push({
        dir: frameDirFor(index + 1, null),
        request: {
          recording,
          trim: visual.trim ?? { start: 0, end: Math.min(recording.durationSec, maxClip) },
          zoom: visual.zoom,
          box: RECORDING_BOX.scene,
        },
      });
    } else if (visual.type === 'before-after') {
      for (const side of ['before', 'after'] as const) {
        const panel = visual[side];
        if (panel.kind !== 'recording' || !panel.recordingId) continue;
        const recording = recordingFor(panel.recordingId);
        uses.push({
          dir: frameDirFor(index + 1, side),
          request: {
            recording,
            trim: { start: 0, end: Math.min(recording.durationSec, maxClip) },
            zoom: null,
            box: RECORDING_BOX.panel,
          },
        });
      }
    }
  }
  const frames = new Map<string, ExtractedFrames>();
  if (uses.length === 0) return frames;
  const { ffmpeg } = await resolveFfmpeg(config);
  for (const use of uses) {
    const made = await extractFrames(ffmpeg, { ...use.request, outDir: join(runDir, use.dir) }, signal);
    frames.set(use.dir, { dir: use.dir, ...made });
  }
  return frames;
}

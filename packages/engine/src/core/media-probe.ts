/**
 * Checks a screen recording that a caller supplied, by its content and never by its file name.
 * Every FFmpeg or ffprobe call that reads such a file must use the whitelists below, so a playlist,
 * a concat script or a network address inside a file can never make the tool read anything else.
 */
import { basename } from 'node:path';
import { MergeStoryError } from './errors.ts';
import { runCommand } from './process.ts';
import { MIN_CLIP_SECONDS } from './recording-frames.ts';
import { maskPrivate } from './secrets.ts';

/** The largest picture, as for screenshots. A larger one would only cost memory to decode. */
const MAX_PIXELS = 40_000_000;

/** Input options for every ffprobe and ffmpeg call that opens a caller's file. */
export const INPUT_WHITELIST_ARGS = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska'];
/**
 * Decoder options for every ffmpeg call that decodes a caller's file: only these video decoders, no
 * picture above the limit (a file can change its picture size after its header), and few threads,
 * because every decoder thread keeps tables for the largest size that the file names.
 */
export const DECODER_ARGS = [
  '-codec_whitelist',
  'h264,vp8,vp9',
  '-max_pixels',
  String(MAX_PIXELS),
  '-threads',
  '4',
];
/**
 * Decoder options for ffprobe. It opens a decoder for every track of the file, so the common sound
 * decoders are allowed too: the sound is never used, but a recording with sound must stay readable.
 */
const PROBE_DECODER_ARGS = [
  '-codec_whitelist',
  'h264,vp8,vp9,aac,mp3,mp3float,opus,vorbis',
  '-max_pixels',
  String(MAX_PIXELS),
];

export const RECORDING_CODECS = ['h264', 'vp8', 'vp9'] as const;
const PROBE_TIMEOUT_MS = 20_000;
const HINT =
  'Use an MP4 (H.264) or WebM (VP8 or VP9) recording. Its only other track may be sound in AAC, MP3, Opus or Vorbis.';

/** The name of a caller's file as messages show it. A name can hold an e-mail address, and messages go into logs. */
export function shownName(path: string): string {
  return maskPrivate(basename(path), { maskEmails: true });
}
/** The most that the list of packets may hold. A clip within the length limit is far below it. */
const MAX_PACKET_LIST_BYTES = 16 * 1024 * 1024;

export interface ProbedRecording {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
}

interface RawProbe {
  streams?: {
    codec_name?: string;
    width?: number;
    height?: number;
    side_data_list?: { rotation?: number }[];
  }[];
  format?: { duration?: string; size?: string };
}

/**
 * The length of a clip whose file does not say it: the end of its last video packet. A recording that
 * a browser wrote often has no length in its header. Null when the list of packets is too long to
 * read, which only a very long clip has.
 */
async function measuredSeconds(ffprobe: string, absolute: string): Promise<number | null> {
  const result = await runCommand(
    ffprobe,
    [
      '-v',
      'error',
      ...INPUT_WHITELIST_ARGS,
      ...PROBE_DECODER_ARGS,
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      '-i',
      absolute,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: MAX_PACKET_LIST_BYTES, allowFailure: true },
  ).catch((err: unknown) =>
    err instanceof Error && err.name === 'OutputTooLargeError' ? null : { code: 1, stdout: '' },
  );
  if (result === null) return null;
  if (result.code !== 0) return 0;
  let end = 0;
  for (const line of result.stdout.split('\n')) {
    const [start, length] = line.split(',').map(Number);
    if (start !== undefined && Number.isFinite(start) && line.trim() !== '') {
      end = Math.max(end, start + (length !== undefined && Number.isFinite(length) ? length : 0));
    }
  }
  return end;
}

/** Probe a recording. `absolute` must be an absolute path. Throws USAGE, naming the file, when it cannot be used. */
export async function probeRecording(ffprobe: string, absolute: string): Promise<ProbedRecording> {
  const name = shownName(absolute);
  const refuse = (reason: string): MergeStoryError =>
    new MergeStoryError('USAGE', `Recording ${name} cannot be used: ${reason}.`, { hint: HINT });
  const result = await runCommand(
    ffprobe,
    [
      '-v',
      'error',
      ...INPUT_WHITELIST_ARGS,
      ...PROBE_DECODER_ARGS,
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height:stream_side_data=rotation:format=duration,size',
      '-of',
      'json',
      '-i',
      absolute,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 1024 * 1024, allowFailure: true },
  ).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'TimedOutError') throw refuse('reading it took too long');
    throw err;
  });
  let raw: RawProbe | null = null;
  try {
    raw = result.code === 0 ? (JSON.parse(result.stdout) as RawProbe) : null;
  } catch {
    raw = null;
  }
  // The name is FFmpeg's own name of a decoder, never text from the file.
  const blocked = /Codec \(([\w-]+)\) not on whitelist/.exec(result.stderr)?.[1];
  if (!raw && blocked) throw refuse(`one of its tracks is ${blocked}, which is not supported`);
  if (!raw) throw refuse('it is not a readable MP4 or WebM file');
  const stream = raw.streams?.[0];
  if (!stream) throw refuse('it has no video');
  const codec = stream.codec_name ?? 'unknown';
  if (!(RECORDING_CODECS as readonly string[]).includes(codec)) {
    throw refuse(`its video codec is ${codec}, which is not supported`);
  }
  // A phone stores a picture that is turned on its side with a rotation, and FFmpeg turns it upright
  // when it decodes. The size here is the size of the upright picture.
  // shortcut: right angles only, as ffprobe prints them. Read the display matrix if another angle ever shows up.
  const rotation = Number(stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0);
  const turned = Math.abs((Math.abs(rotation) % 180) - 90) < 1;
  const width = Number((turned ? stream.height : stream.width) ?? 0);
  const height = Number((turned ? stream.width : stream.height) ?? 0);
  if (!(width > 0 && height > 0)) throw refuse('its picture has no size');
  if (width * height > MAX_PIXELS) throw refuse('its picture is larger than 40 megapixels');
  let durationSec: number | null = Number(raw.format?.duration ?? 0);
  if (!(durationSec > 0)) durationSec = await measuredSeconds(ffprobe, absolute);
  if (durationSec === null) throw refuse('it is too long');
  if (!(durationSec > 0)) throw refuse('it has no length (it may be damaged or still being recorded)');
  if (durationSec < MIN_CLIP_SECONDS) throw refuse(`it is shorter than ${MIN_CLIP_SECONDS} seconds`);
  return { codec, width, height, durationSec, sizeBytes: Number(raw.format?.size ?? 0) || 0 };
}

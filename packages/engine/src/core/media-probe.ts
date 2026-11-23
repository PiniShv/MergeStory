/**
 * Checks a screen recording that a caller supplied, by its content and never by its file name.
 * Every FFmpeg or ffprobe call that reads such a file must use the whitelists below, so a playlist,
 * a concat script or a network address inside a file can never make the tool read anything else.
 */
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { MergeStoryError } from './errors.ts';
import { runCommand } from './process.ts';
import { MIN_CLIP_SECONDS, RECORDING_FPS } from './recording-frames.ts';
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

/** What ffprobe says about the time of a clip's picture tracks and their packets, as clockProblem asks for it. */
export interface ClockFacts {
  packets?: { stream_index?: number; pts?: number; dts?: number; duration?: number; flags?: string }[];
  streams?: { index?: number; id?: string; codec_name?: string; time_base?: string }[];
  format?: { start_time?: string; format_name?: string };
}

/** One edit of the edit list of an MP4 or QuickTime track: where it starts in the track's own time, and its speed. */
export interface TrackEdit {
  mediaTime: number;
  rate: number;
}

/** What the movie box of an MP4 or QuickTime file says about its tracks (see movieFacts). */
export interface MovieFacts {
  /** The tracks whose media is a picture. */
  pictureTracks: number;
  /** A track holds something other than a picture or sound, or its handlers do not agree on what it holds. */
  otherTracks: boolean;
  /** The file is written in parts (fragments). */
  fragmented: boolean;
  /** The picture track, when there is one: its id, whether it is turned on, and its edit list (null for none). */
  trackId: number;
  enabled: boolean;
  edits: TrackEdit[] | null;
  /** How long the movie and the picture track say they are, in seconds. */
  movieSeconds: number;
  trackSeconds: number;
}

/** What the start of a Matroska or WebM file says about its tracks (see matroskaFacts). */
export interface MatroskaFacts {
  /** The track entries of type picture. */
  pictureTracks: number;
  /** A track entry has no codec: FFmpeg leaves it out, other players may not. */
  unnamed: boolean;
  /** The timing settings of the picture track. Each one moves its times in some players only. */
  timestampScale: number;
  trackOffset: number;
  codecDelay: number;
}

/** What the file itself says about its picture track, beyond what ffprobe shows (see clockProblem). */
export interface TrackFacts {
  /** MP4 and MOV: the movie box, and the earliest time of a picture as stored, before the edit list. */
  movie?: MovieFacts;
  firstStoredPts?: number;
  /** Matroska and WebM: the track list. */
  matroska?: MatroskaFacts;
}

/** The most that the movie box of a recording may hold. Its tables for a clip within the limits are far smaller. */
const MAX_MOVIE_BOX_BYTES = 64 * 1024 * 1024;
/** How much of the start of a Matroska file is read for its track list, which comes before its pictures. */
const MATROSKA_HEAD_BYTES = 4 * 1024 * 1024;
/** The subtypes of a data handler, which says where the media is and not what it holds. */
const DATA_HANDLERS = new Set(['alis', 'url ', 'rsrc', '\0\0\0\0']);

/** The boxes in the body of an MP4 box, as [type, body], in order. Throws on a box that does not fit. */
function* mp4Boxes(body: Buffer): Generator<[string, Buffer]> {
  for (let at = 0; at + 8 <= body.length; ) {
    let length = body.readUInt32BE(at);
    let header = 8;
    if (length === 1) {
      length = Number(body.readBigUInt64BE(at + 8));
      header = 16;
    } else if (length === 0) length = body.length - at;
    if (length < header || at + length > body.length) throw new Error('an MP4 box does not fit');
    yield [body.toString('latin1', at + 4, at + 8), body.subarray(at + header, at + length)];
    at += length;
  }
}

/**
 * What the movie box of an MP4 or QuickTime file says about its tracks. ffprobe does not show the edit list,
 * the lengths that the file gives itself, or how the file marks its tracks, and FFmpeg ignores some of them
 * where QuickTime and Safari follow them. Reads only the boxes on the way. Throws when the file cannot be read
 * this way, so the caller refuses the clip.
 */
export async function movieFacts(absolute: string): Promise<MovieFacts> {
  const file = await open(absolute, 'r');
  try {
    const { size } = await file.stat();
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, at);
      if (bytesRead !== length) throw new Error('the file ended inside a box');
      return buffer;
    };
    // The movie box can come before or after the media, so the boxes at the top are walked by their sizes.
    for (let at = 0; at + 8 <= size; ) {
      const head = await read(at, Math.min(16, size - at));
      let length = head.readUInt32BE(0);
      let header = 8;
      if (length === 1) {
        length = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (length === 0) length = size - at;
      if (length < header || at + length > size) throw new Error('an MP4 box does not fit');
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (length > MAX_MOVIE_BOX_BYTES) throw new Error('the movie box is too large');
        return movieFactsOf(await read(at + header, length - header));
      }
      at += length;
    }
    throw new Error('the file has no movie box');
  } finally {
    await file.close();
  }
}

/** What a movie box's body says about its tracks (see movieFacts). */
export function movieFactsOf(movie: Buffer): MovieFacts {
  const all = (body: Buffer | undefined, type: string): Buffer[] =>
    body === undefined ? [] : [...mp4Boxes(body)].filter(([t]) => t === type).map(([, b]) => b);
  // A header in version 1 has 64-bit times and lengths; "length unknown" (all ones) is not a length.
  const length = (box: Buffer, at32: number, at64: number): number => {
    const value = box[0] === 1 ? Number(box.readBigUInt64BE(at64)) : box.readUInt32BE(at32);
    return value === 0xffffffff || value >= 2 ** 53 ? Number.NaN : value;
  };
  const header = all(movie, 'mvhd')[0];
  if (header === undefined || header.length < 32) throw new Error('the movie has no header');
  const timescale = header.readUInt32BE(header[0] === 1 ? 20 : 12);
  if (!(timescale > 0)) throw new Error('the movie has no time scale');
  let pictureTracks = 0;
  let otherTracks = false;
  let picture: Buffer | undefined;
  for (const track of all(movie, 'trak')) {
    const media = all(track, 'mdia')[0];
    // FFmpeg takes what a track holds from its last handler, QuickTime from the first, so they must agree.
    const kinds = new Set(
      [...all(media, 'hdlr'), ...all(all(media, 'minf')[0], 'hdlr')]
        .filter((handler) => handler.length >= 12)
        .map((handler) => handler.toString('latin1', 8, 12))
        .filter((kind) => !DATA_HANDLERS.has(kind)),
    );
    const [kind] = kinds;
    if (kinds.size === 1 && kind === 'vide') {
      pictureTracks++;
      picture = track;
    } else if (kinds.size !== 1 || kind !== 'soun') otherTracks = true;
  }
  const facts: MovieFacts = {
    pictureTracks,
    otherTracks,
    fragmented: all(movie, 'mvex').length > 0,
    trackId: 0,
    enabled: false,
    edits: null,
    movieSeconds: length(header, 16, 24) / timescale,
    trackSeconds: Number.NaN,
  };
  if (pictureTracks !== 1 || picture === undefined) return facts;
  const trackHeader = all(picture, 'tkhd')[0];
  if (trackHeader === undefined || trackHeader.length < 36)
    throw new Error('the picture track has no header');
  const wide = trackHeader[0] === 1;
  facts.trackId = trackHeader.readUInt32BE(wide ? 20 : 12);
  facts.enabled = (trackHeader.readUIntBE(1, 3) & 1) === 1;
  facts.trackSeconds = length(trackHeader, 20, 28) / timescale;
  const lists = all(picture, 'edts').flatMap((edts) => all(edts, 'elst'));
  // FFmpeg uses the last edit list of a track and QuickTime the first, so a track with two has no one reading.
  if (lists.length > 1) throw new Error('the picture track has more than one edit list');
  const list = lists[0];
  if (list === undefined) return facts;
  const step = list[0] === 1 ? 20 : 12;
  const count = list.readUInt32BE(4);
  if (list.length < 8 + count * step) throw new Error('the edit list does not fit');
  facts.edits = Array.from({ length: count }, (_, i) => {
    const at = 8 + i * step;
    const rate = at + step - 4;
    return {
      mediaTime: step === 20 ? Number(list.readBigInt64BE(at + 8)) : list.readInt32BE(at + 4),
      rate: list.readInt16BE(rate) + list.readUInt16BE(rate + 2) / 65536,
    };
  });
  return facts;
}

/** One EBML element of a Matroska file: its id, the size of its body (null when the file leaves it open), and where the body starts. */
function ebmlElement(data: Buffer, at: number): { id: number; size: number | null; body: number } {
  const first = data[at] ?? 0;
  const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (idLength === 0 || at + idLength >= data.length) throw new Error('a Matroska element does not fit');
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + data[at + i]!;
  const start = at + idLength;
  const lead = data[start]!;
  let sizeLength = 1;
  while (sizeLength <= 8 && (lead & (0x80 >> (sizeLength - 1))) === 0) sizeLength++;
  if (sizeLength > 8 || start + sizeLength > data.length) throw new Error('a Matroska element does not fit');
  let size = lead & (0xff >> sizeLength);
  let open = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + data[start + i]!;
    open &&= data[start + i] === 0xff;
  }
  return { id, size: open ? null : size, body: start + sizeLength };
}

/** The elements in a Matroska element's body, as [id, body]. Throws on one that does not fit. */
function* ebmlChildren(body: Buffer): Generator<[number, Buffer]> {
  for (let at = 0; at < body.length; ) {
    const { id, size, body: from } = ebmlElement(body, at);
    if (size === null || from + size > body.length) throw new Error('a Matroska element does not fit');
    yield [id, body.subarray(from, from + size)];
    at = from + size;
  }
}

/** What the track list of a Matroska or WebM file says. Throws when it cannot be read, so the caller refuses the clip. */
export async function matroskaFacts(absolute: string): Promise<MatroskaFacts> {
  const file = await open(absolute, 'r');
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(MATROSKA_HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, MATROSKA_HEAD_BYTES, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  return matroskaFactsOf(head);
}

/** What the track list says, from the start of a Matroska file (see matroskaFacts). */
export function matroskaFactsOf(head: Buffer): MatroskaFacts {
  const header = ebmlElement(head, 0);
  if (header.id !== 0x1a45dfa3 || header.size === null) throw new Error('not a Matroska file');
  const segment = ebmlElement(head, header.body + header.size);
  if (segment.id !== 0x18538067) throw new Error('not a Matroska file');
  const end = segment.size === null ? head.length : Math.min(head.length, segment.body + segment.size);
  // The track list comes before the first cluster of pictures; a recorder leaves only clusters open.
  for (let at = segment.body; at < end; ) {
    const element = ebmlElement(head, at);
    if (element.id === 0x1f43b675) break;
    if (element.size === null || element.body + element.size > head.length) {
      throw new Error('the track list is not near the start of the file');
    }
    if (element.id === 0x1654ae6b) {
      const number = (value: Buffer | undefined, fallback: number, signed = false): number => {
        if (value === undefined || value.length === 0) return fallback;
        if (value.length > 8) throw new Error('a Matroska number does not fit');
        const n = BigInt(`0x${value.toString('hex')}`);
        const bits = BigInt(value.length * 8);
        return Number(signed && n >> (bits - 1n) === 1n ? n - (1n << bits) : n);
      };
      const facts: MatroskaFacts = {
        pictureTracks: 0,
        unnamed: false,
        timestampScale: 1,
        trackOffset: 0,
        codecDelay: 0,
      };
      for (const [id, entry] of ebmlChildren(head.subarray(element.body, element.body + element.size))) {
        if (id !== 0xae) continue;
        const fields = new Map(ebmlChildren(entry));
        if (!fields.has(0x86)) facts.unnamed = true;
        // A track of type 1 holds pictures.
        if (number(fields.get(0x83), 0) !== 1) continue;
        facts.pictureTracks++;
        const scale = fields.get(0x23314f);
        facts.timestampScale =
          scale === undefined || scale.length === 0
            ? 1
            : scale.length === 4
              ? scale.readFloatBE(0)
              : scale.length === 8
                ? scale.readDoubleBE(0)
                : Number.NaN;
        facts.trackOffset = number(fields.get(0x537f), 0, true);
        facts.codecDelay = number(fields.get(0x56aa), 0);
      }
      return facts;
    }
    at = element.body + element.size;
  }
  throw new Error('the track list is not near the start of the file');
}

/**
 * Why a player and the cut frames would not agree on when the pictures of this clip show, or null when they
 * agree. A region can be hidden for a part of a clip only when they agree. A player shows a picture at its
 * time in the file; the cut runs on a clock that starts at the file's start, repeats the first and last
 * pictures before and after them, and uses FFmpeg's reading of the file. So the clip is allowed only in a
 * plain form that the players read the same way: one picture track that starts at 0 with a full picture, a
 * file that starts at 0, and a picture that lasts to the clip's end. Anything that FFmpeg reads in another way
 * than QuickTime and Safari is refused: in MP4 and MOV, other tracks, a file in parts, lengths that the file
 * gives itself shorter than its pictures, an edit list that is not one edit at normal speed from the first
 * picture or that leaves a picture out, and times that jump; in Matroska, tracks with no codec, timing
 * settings on the picture track, and times that go back. This is a check of the file layouts that recorders
 * write: a file built by hand to fool players can still show other pictures in another player.
 */
export async function clockProblem(
  ffprobe: string,
  absolute: string,
  durationSec: number,
): Promise<string | null> {
  const unread = 'the times of its pictures could not be read';
  const probe = (args: string[]) =>
    runCommand(
      ffprobe,
      ['-v', 'error', ...INPUT_WHITELIST_ARGS, ...PROBE_DECODER_ARGS, ...args, '-i', absolute],
      { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: MAX_PACKET_LIST_BYTES, allowFailure: true },
    ).catch((err: unknown) => {
      if (err instanceof Error && (err.name === 'OutputTooLargeError' || err.name === 'TimedOutError'))
        return null;
      throw err;
    });
  const result = await probe([
    ...['-select_streams', 'v', '-of', 'json', '-show_entries'],
    'packet=stream_index,pts,dts,duration,flags:stream=index,id,codec_name,time_base:format=start_time,format_name',
  ]);
  if (result === null || result.code !== 0) return unread;
  try {
    const facts = JSON.parse(result.stdout) as ClockFacts;
    const formats = facts.format?.format_name?.split(',') ?? [];
    const track: TrackFacts = {};
    if (formats.includes('mov') && (facts.streams?.length ?? 0) === 1) {
      track.movie = await movieFacts(absolute);
      // The times of the pictures as the file stores them, before FFmpeg applies the edit list.
      const stored = await probe([
        ...['-ignore_editlist', '1', '-select_streams', 'v:0', '-of', 'csv=p=0'],
        ...['-show_entries', 'packet=pts'],
      ]);
      if (stored === null || stored.code !== 0) return unread;
      const times = stored.stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => Number(line.trim().replace(/,$/, '')));
      if (times.length === 0 || times.some((t) => !Number.isInteger(t))) return unread;
      track.firstStoredPts = times.reduce((a, b) => Math.min(a, b));
    }
    if (formats.includes('matroska') && (facts.streams?.length ?? 0) === 1) {
      track.matroska = await matroskaFacts(absolute);
    }
    return clockProblemOf(facts, durationSec, track);
  } catch {
    return unread;
  }
}

/**
 * The checks of clockProblem on what ffprobe said and on what the file says about its tracks, apart so that a
 * test can give them anything.
 */
export function clockProblemOf(facts: ClockFacts, durationSec: number, track: TrackFacts): string | null {
  const unread = 'the times of its pictures could not be read';
  const seconds = (value: number): string => `${value.toFixed(3)} s`;
  const start = Number(facts.format?.start_time);
  if (!Number.isFinite(start)) return unread;
  if (start !== 0) return `the file starts at ${seconds(start)}, not at 0`;
  // A second picture track (a camera, a cover picture) may be the one that a player shows.
  const streams = facts.streams ?? [];
  if (streams.length !== 1) return streams.length === 0 ? unread : `it has ${streams.length} picture tracks`;
  const stream = streams[0]!;
  const [ticks = 0, perSecond = 0] = (stream.time_base ?? '').split('/').map(Number);
  const packets = (facts.packets ?? []).filter(
    (p) => p.stream_index === undefined || p.stream_index === stream.index,
  );
  if (!(ticks > 0 && perSecond > 0) || packets.length === 0) return unread;
  if (packets.some((p) => !Number.isInteger(p.pts))) return unread;
  const formats = facts.format?.format_name?.split(',') ?? [];
  const mov = formats.includes('mov');
  const matroska = formats.includes('matroska');
  // FFmpeg and Chrome drop a picture that an edit starts inside of, and move every later picture to fill its
  // place; QuickTime and Safari show the rest of it. A picture left out (flag D) shows such a cut.
  if (mov && packets.some((p) => p.flags?.includes('D'))) return 'its edit list leaves out pictures';
  const time = (value: number): number => (value * ticks) / perSecond;
  let first = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const p of packets) {
    if (p.flags?.includes('D')) continue;
    first = Math.min(first, p.pts!);
    end = Math.max(end, p.pts! + (p.duration ?? 0));
  }
  if (!Number.isFinite(first)) return unread;
  // FFmpeg drops the pictures before the first full one (a keyframe) and the cut repeats that one back to 0,
  // while Safari shows nothing until it. So the first picture, in the order of the file, must be full and first.
  if (!packets[0]!.flags?.includes('K') || packets[0]!.pts !== first)
    return 'it does not start with a full picture';
  if (first !== 0) return `its picture starts at ${seconds(time(first))}, not at 0`;
  if (time(end) < durationSec - 1 / RECORDING_FPS) {
    return `its picture ends at ${seconds(time(end))}, before the clip ends at ${seconds(durationSec)}`;
  }
  if (mov) {
    const movie = track.movie;
    if (movie === undefined || track.firstStoredPts === undefined) return unread;
    // Parts can carry their own times, which FFmpeg and QuickTime read in different ways.
    if (movie.fragmented) return 'it is an MP4 written in parts';
    if (movie.otherTracks) return 'it has tracks other than its picture and its sound';
    if (movie.pictureTracks !== 1) return `it has ${movie.pictureTracks} picture tracks`;
    if (movie.trackId !== Number.parseInt(stream.id ?? '', 16)) return unread;
    if (!movie.enabled) return 'its picture track is turned off';
    // QuickTime and Safari end the clip where the file says it ends; FFmpeg plays every picture.
    const says = Math.min(movie.movieSeconds, movie.trackSeconds);
    if (!Number.isFinite(says)) return unread;
    if (says < durationSec - 1 / RECORDING_FPS) {
      return `the file says it ends at ${seconds(says)}, before its last picture`;
    }
    // FFmpeg ignores the speed of an edit and joins several edits, where QuickTime and Safari follow them. And
    // an edit that starts before the first picture makes FFmpeg move every picture to 0, where they keep the gap.
    const edits = movie.edits;
    if (edits !== null && (edits.length !== 1 || edits[0]!.rate !== 1 || edits[0]!.mediaTime < 0)) {
      return 'its edit list is not one edit at normal speed';
    }
    if ((edits?.[0]?.mediaTime ?? 0) !== track.firstStoredPts) {
      return 'its edit list does not start at its first picture';
    }
    // Only here is a decode time needed: a Matroska file does not give one for every picture.
    if (packets.some((p) => !Number.isInteger(p.dts))) return unread;
    for (let i = 1; i < packets.length; i++) {
      const before = packets[i - 1]!;
      if (packets[i]!.dts !== before.dts! + (before.duration ?? 0)) return 'the times of its pictures jump';
    }
  }
  if (matroska) {
    const tracks = track.matroska;
    if (tracks === undefined) return unread;
    if (tracks.unnamed) return 'it has a track with no codec, which players treat in different ways';
    if (tracks.pictureTracks !== 1) return `it has ${tracks.pictureTracks} picture tracks`;
    if (tracks.timestampScale !== 1 || tracks.trackOffset !== 0 || tracks.codecDelay !== 0) {
      return 'its picture track has timing settings that players read in different ways';
    }
    // A time that goes back or repeats is read in different ways too. VP8 and VP9 have no reordered pictures.
    const ordered = stream.codec_name === 'vp8' || stream.codec_name === 'vp9';
    const seen = new Set<number>();
    for (const [i, p] of packets.entries()) {
      if (seen.has(p.pts!) || (ordered && i > 0 && p.pts! <= packets[i - 1]!.pts!)) {
        return 'the times of its pictures go back or repeat';
      }
      seen.add(p.pts!);
    }
  }
  return null;
}

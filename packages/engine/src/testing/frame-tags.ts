/**
 * Clips whose every picture carries its own number, for tests that check which picture of a recording a
 * cut frame shows. A test judges a frame by the times its clip was made with, never by the product's own
 * rules for time.
 *
 * The number is drawn as 16 black or white cells along the top edge of the picture as a player shows it.
 * Cells 0 to 11 hold the bits of the number (cell 0 is the lowest), cell 12 is always white and cell 13
 * always black, cell 14 is white when the number has an odd count of 1 bits, and cell 15 is the opposite
 * of cell 14. The reader looks at the middle of each cell and reads no number when a cell is not clearly
 * black or white or a check cell is wrong, so a blurred or smudged tag does not read as another number.
 * A dark cover over the tag would read as black cells, so a test keeps its hidden regions off the tag.
 */
import { join } from 'node:path';
import { runCommand } from '../core/process.ts';

const BITS = 12;

/** An FFmpeg filter chain that draws the number of each picture that enters it (FFmpeg's `n`) as its tag. */
export function tagFilter(): string {
  const cell = (i: number) =>
    `x=floor(iw*${i}/16):y=0:w=floor(iw*${i + 1}/16)-floor(iw*${i}/16):h=floor(iw/16)`;
  const bit = (b: number) => `mod(floor(n/${2 ** b}),2)`;
  const parity = `mod(${Array.from({ length: BITS }, (_, b) => bit(b)).join('+')},2)`;
  return [
    'drawbox=x=0:y=0:w=iw:h=floor(iw/16):color=black:t=fill',
    ...Array.from({ length: BITS }, (_, b) => `drawbox=${cell(b)}:color=white:t=fill:enable='${bit(b)}'`),
    `drawbox=${cell(12)}:color=white:t=fill`,
    `drawbox=${cell(14)}:color=white:t=fill:enable='${parity}'`,
    `drawbox=${cell(15)}:color=white:t=fill:enable='1-${parity}'`,
  ].join(',');
}

/** The number in the tag of an 8-bit grey picture, or null when the tag cannot be read. */
export function readTag(grey: Uint8Array, width: number): number | null {
  const middle = (from: number, to: number): [number, number] => {
    const start = Math.round(from + (to - from) / 4);
    return [start, Math.max(start + 1, Math.round(from + ((to - from) * 3) / 4))];
  };
  const [y0, y1] = middle(0, width / 16);
  const bits: number[] = [];
  for (let i = 0; i < 16; i++) {
    const [x0, x1] = middle((width * i) / 16, (width * (i + 1)) / 16);
    let sum = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += grey[y * width + x]!;
    const mean = sum / ((y1 - y0) * (x1 - x0));
    if (mean > 64 && mean < 192) return null;
    bits.push(mean >= 128 ? 1 : 0);
  }
  const number = bits.slice(0, BITS).reduce((sum, bit, b) => sum + bit * 2 ** b, 0);
  const odd = bits.slice(0, BITS).reduce((sum, bit) => sum + bit, 0) % 2;
  return bits[12] === 1 && bits[13] === 0 && bits[14] === odd && bits[15] === 1 - odd ? number : null;
}

export interface TaggedShape {
  /** The file name. Its extension picks the container: .mp4, .mov, .webm or .mkv. */
  name: string;
  codec: 'h264' | 'vp8' | 'vp9';
  /** The size of the picture as a player shows it. */
  width: number;
  height: number;
  /** Pictures per second, as FFmpeg reads a rate: 30 or '30000/1001'. */
  rate: number | string;
  seconds: number;
  /** For a clip whose pictures come and go, like a screen where little moves: the numbers kept, as ranges. */
  keep?: [number, number][];
  /** The file stores the picture turned and tells a player to turn it back by this many degrees. */
  rotate?: 90 | 180 | 270;
}

/** When each picture of a shape starts to show in a player, in order. A picture shows until the next one. */
export function pictureTimes(shape: TaggedShape): { n: number; t: number }[] {
  const [perSecond = 0, per = 1] = String(shape.rate).split('/').map(Number);
  const count = Math.ceil((shape.seconds * perSecond) / per - 1e-9);
  const kept = (n: number) => !shape.keep || shape.keep.some(([first, last]) => n >= first && n <= last);
  return Array.from({ length: count }, (_, n) => ({ n, t: (n * per) / perSecond })).filter(({ n }) =>
    kept(n),
  );
}

/**
 * The numbers of every picture that a player shows at some time from `from` to `to`, both included. A
 * picture that ends exactly at `from` is not one of them: at that moment the player shows the next one.
 */
export function shownBetween(shape: TaggedShape, from: number, to: number): number[] {
  const times = pictureTimes(shape);
  // A tiny slack for sums of fractions such as 5/24, so a picture that starts exactly at `to` counts.
  const slack = 1e-6;
  return times
    .filter(({ t }, i) => t <= to + slack && (times[i + 1]?.t ?? Number.POSITIVE_INFINITY) > from + slack)
    .map(({ n }) => n);
}

const ENCODERS: Record<TaggedShape['codec'], string[]> = {
  h264: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
  vp8: ['-c:v', 'libvpx', '-b:v', '1M', '-pix_fmt', 'yuv420p'],
  vp9: ['-c:v', 'libvpx-vp9', '-b:v', '1M', '-pix_fmt', 'yuv420p', '-deadline', 'realtime', '-cpu-used', '8'],
};
const TURNS: Record<NonNullable<TaggedShape['rotate']>, string> = {
  90: 'transpose=1',
  180: 'hflip,vflip',
  270: 'transpose=2',
};

/** Make the clip of a shape in a folder. Returns its path, or null when this FFmpeg cannot make it. */
export async function makeTaggedClip(
  ffmpeg: string,
  dir: string,
  shape: TaggedShape,
): Promise<string | null> {
  const run = async (args: string[]) =>
    (await runCommand(ffmpeg, ['-v', 'error', '-y', ...args], { allowFailure: true, timeoutMs: 60_000 }))
      .code === 0;
  const file = join(dir, shape.name);
  // A turned clip is drawn upright with its tag, turned for storage, then marked to be turned back on play.
  const stored = shape.rotate ? join(dir, `stored-${shape.name}`) : file;
  const filters = [
    tagFilter(),
    ...(shape.keep ? [`select='${shape.keep.map(([a, b]) => `between(n,${a},${b})`).join('+')}'`] : []),
    ...(shape.rotate ? [TURNS[shape.rotate]] : []),
  ];
  const source = `testsrc2=size=${shape.width}x${shape.height}:rate=${shape.rate}:duration=${shape.seconds}`;
  const made = await run([
    ...['-f', 'lavfi', '-i', source, '-vf', filters.join(',')],
    // Each picture keeps the time it was drawn at, also where pictures were left out.
    ...['-fps_mode', 'passthrough', ...ENCODERS[shape.codec], stored],
  ]);
  if (!made || !shape.rotate) return made ? file : null;
  return (await run(['-display_rotation:v', String(shape.rotate), '-i', stored, '-c', 'copy', file]))
    ? file
    : null;
}

/**
 * The time of every picture of a file as FFmpeg decodes it, with the file's edit list: the time a player
 * shows it at. A test compares these with `pictureTimes`, so a clip that FFmpeg wrote differently cannot
 * pass as the shape it was meant to be.
 */
export async function fileTimes(ffprobe: string, file: string): Promise<number[]> {
  const { stdout } = await runCommand(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { timeoutMs: 60_000 },
  );
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => Number.parseFloat(line));
}

/** The frames of a cut folder (f-00001.jpg, f-00002.jpg, ...) as 8-bit grey pictures, in order. */
export async function readCut(
  ffmpeg: string,
  dir: string,
  size: { width: number; height: number },
): Promise<Uint8Array[]> {
  const { stdoutBuffer } = await runCommand(
    ffmpeg,
    [
      '-v',
      'error',
      '-start_number',
      '1',
      '-i',
      join(dir, 'f-%05d.jpg'),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 * 1024 },
  );
  const bytes = size.width * size.height;
  return Array.from({ length: Math.floor(stdoutBuffer.length / bytes) }, (_, i) =>
    stdoutBuffer.subarray(i * bytes, (i + 1) * bytes),
  );
}

/** A box of a grey picture, in pixels. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest distance of a pixel in the box from the nearest of the given greys: 0 when every pixel is one of them. */
export function farthestFrom(
  grey: Uint8Array,
  width: number,
  box: PixelBox,
  greys: readonly number[],
): number {
  let worst = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const value = grey[y * width + x]!;
      worst = Math.max(worst, Math.min(...greys.map((g) => Math.abs(value - g))));
    }
  return worst;
}

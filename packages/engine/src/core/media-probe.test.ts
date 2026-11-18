import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../testing/context.ts';
import { makeClip } from '../testing/media.ts';
import { makePng } from '../testing/png.ts';
import { resolveFfmpeg } from './binaries.ts';
import { DECODE_WHITELIST_ARGS, INPUT_WHITELIST_ARGS, probeRecording } from './media-probe.ts';
import { runCommand } from './process.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

describe('whitelists', () => {
  it('name the containers and codecs that a recording may use', () => {
    expect(INPUT_WHITELIST_ARGS).toEqual([
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska',
    ]);
    expect(DECODE_WHITELIST_ARGS).toEqual(['-codec_whitelist', 'h264,vp8,vp9']);
  });
});

describe.skipIf(tools === null)('probeRecording', () => {
  let dir: string;
  const at = (name: string): string => join(dir, name);
  const refused = (name: string) =>
    expect(probeRecording(tools!.ffprobe, at(name))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining(name),
      hint: expect.stringContaining('MP4 (H.264) or WebM'),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-probe-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an H.264 MP4 and reads its size and length', async () => {
    expect(await makeClip(tools!.ffmpeg, at('a.mp4'), { seconds: 2, size: '320x240' })).toBe(true);
    const probed = await probeRecording(tools!.ffprobe, at('a.mp4'));
    expect(probed).toMatchObject({ codec: 'h264', width: 320, height: 240 });
    expect(probed.durationSec).toBeGreaterThan(1.5);
    expect(probed.sizeBytes).toBeGreaterThan(0);
  });

  it('accepts a VP9 WebM', async () => {
    if (!(await makeClip(tools!.ffmpeg, at('a.webm'), { codec: 'vp9' }))) return;
    expect(await probeRecording(tools!.ffprobe, at('a.webm'))).toMatchObject({ codec: 'vp9' });
  });

  it('refuses a playlist, a concat script and a PNG that are named .mp4', async () => {
    await writeFile(at('list.mp4'), '#EXTM3U\n#EXTINF:1,\nhttp://example.invalid/x.ts\n');
    await writeFile(at('concat.mp4'), "ffconcat version 1.0\nfile '/etc/hosts'\n");
    await writeFile(at('image.mp4'), makePng(8, 8, [1, 2, 3]));
    await refused('list.mp4');
    await refused('concat.mp4');
    await refused('image.mp4');
  });

  it('refuses a file that is not there', async () => {
    await refused('missing.mp4');
  });

  it('refuses a file with sound only', async () => {
    expect(await makeClip(tools!.ffmpeg, at('sound.mp4'), { audioOnly: true })).toBe(true);
    await expect(probeRecording(tools!.ffprobe, at('sound.mp4'))).rejects.toMatchObject({
      message: expect.stringContaining('no video'),
    });
  });

  it('refuses HEVC video', async () => {
    if (!(await makeClip(tools!.ffmpeg, at('h265.mp4'), { codec: 'hevc' }))) return;
    await expect(probeRecording(tools!.ffprobe, at('h265.mp4'))).rejects.toMatchObject({
      message: expect.stringContaining('hevc'),
    });
  });

  it('measures a WebM that does not say how long it is, as a recording from a browser often does not', async () => {
    // Written to a pipe, FFmpeg cannot go back and put the length into the header.
    const piped = await runCommand(
      tools!.ffmpeg,
      [
        ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12'],
        ...['-c:v', 'libvpx', '-f', 'webm', 'pipe:1'],
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    if (piped.code !== 0) return;
    await writeFile(at('browser.webm'), piped.stdoutBuffer);
    const probed = await probeRecording(tools!.ffprobe, at('browser.webm'));
    expect(probed).toMatchObject({ codec: 'vp8', width: 320, height: 240 });
    expect(probed.durationSec).toBeGreaterThan(1.8);
    expect(probed.durationSec).toBeLessThan(2.2);
  });
});

/** An ffprobe that answers what a test tells it to, to reach answers that a real file rarely gives. */
describe.skipIf(process.platform === 'win32')('probeRecording, with answers that are hard to make', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-probe-fake-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A program that prints `header` when it is asked for the streams and `packets` when asked for the packets. */
  async function fakeProbe(name: string, header: object, packets: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(join(dir, `${name}.json`), JSON.stringify(header));
    await writeFile(join(dir, `${name}.csv`), packets);
    await writeFile(
      path,
      `#!/bin/sh\ncase "$*" in *packet=*) cat '${path}.csv' ;; *) cat '${path}.json' ;; esac\n`,
      { mode: 0o755 },
    );
    return path;
  }
  const video = (width: number, height: number) => ({
    streams: [{ codec_name: 'h264', width, height }],
    format: {},
  });

  it('takes the end of the last packet as the length, whatever the order of the packets', async () => {
    const probe = await fakeProbe(
      'unordered',
      video(640, 360),
      '0.000000,0.040000\n1.960000,0.040000\n0.040000,N/A\n\n',
    );
    expect((await probeRecording(probe, '/clips/a.mp4')).durationSec).toBeCloseTo(2, 5);
  });

  it('refuses a clip with no packets, and a picture of more than 40 megapixels', async () => {
    await expect(
      probeRecording(await fakeProbe('empty', video(640, 360), ''), '/clips/a.mp4'),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('no length'),
    });
    const huge = await fakeProbe(
      'huge',
      { streams: [{ codec_name: 'vp9', width: 8000, height: 6000 }], format: { duration: '3' } },
      '',
    );
    await expect(probeRecording(huge, '/clips/a.webm')).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('40 megapixels'),
    });
  });
});

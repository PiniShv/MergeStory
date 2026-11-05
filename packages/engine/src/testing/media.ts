/**
 * Probing a media file in full (streams, colour tags, container tags), for the tests of the render
 * module. The product only needs the duration of a file, which `probeDuration` gives.
 */
import { MergeStoryError } from '../core/errors.ts';
import { runCommand } from '../core/process.ts';

export interface ProbedStream {
  type: string;
  codec: string;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  sampleRate: number | null;
  channels: number | null;
  frameRate: string | null;
}

export interface ProbedMedia {
  durationSec: number;
  sizeBytes: number;
  streams: ProbedStream[];
  /** Container-level tags (empty when metadata was stripped). */
  tags: Record<string, string>;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  r_frame_rate?: string;
}

interface RawProbe {
  streams?: RawStream[];
  format?: { duration?: string; size?: string; tags?: Record<string, string> };
}

/** Probe a media file with ffprobe. */
export async function probeMedia(
  ffprobePath: string,
  file: string,
  signal?: AbortSignal,
): Promise<ProbedMedia> {
  const result = await runCommand(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
    { signal, maxOutputBytes: 4 * 1024 * 1024 },
  );
  let raw: RawProbe;
  try {
    raw = JSON.parse(result.stdout) as RawProbe;
  } catch (err) {
    throw new MergeStoryError('RENDER_FAILED', 'ffprobe returned output that could not be read.', {
      cause: err,
    });
  }
  return {
    durationSec: Number(raw.format?.duration ?? 0) || 0,
    sizeBytes: Number(raw.format?.size ?? 0) || 0,
    tags: raw.format?.tags ?? {},
    streams: (raw.streams ?? []).map((s) => ({
      type: s.codec_type ?? '',
      codec: s.codec_name ?? '',
      width: s.width ?? null,
      height: s.height ?? null,
      pixFmt: s.pix_fmt ?? null,
      colorRange: s.color_range ?? null,
      colorSpace: s.color_space ?? null,
      colorTransfer: s.color_transfer ?? null,
      colorPrimaries: s.color_primaries ?? null,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
      channels: s.channels ?? null,
      frameRate: s.r_frame_rate ?? null,
    })),
  };
}

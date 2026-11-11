/** Locate ffmpeg and ffprobe. Order: config path, environment, PATH, common install locations. */
import type { Config } from './config.ts';
import { MergeStoryError } from './errors.ts';
import { isExecutable, which } from './process.ts';

const COMMON_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];

async function find(name: 'ffmpeg' | 'ffprobe', configured: string | null): Promise<string | null> {
  if (configured) return (await isExecutable(configured)) ? configured : null;
  const onPath = await which(name);
  if (onPath) return onPath;
  for (const dir of COMMON_DIRS) {
    const candidate = `${dir}/${name}`;
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

let cached: { key: string; value: FfmpegPaths } | null = null;

export async function resolveFfmpeg(config: Pick<Config, 'render'>): Promise<FfmpegPaths> {
  const key = `${config.render.ffmpegPath ?? ''}|${config.render.ffprobePath ?? ''}`;
  if (cached?.key === key) return cached.value;
  const ffmpeg = await find('ffmpeg', config.render.ffmpegPath);
  const ffprobe = await find('ffprobe', config.render.ffprobePath);
  if (!ffmpeg || !ffprobe) {
    throw new MergeStoryError('FFMPEG_NOT_FOUND', `${!ffmpeg ? 'ffmpeg' : 'ffprobe'} was not found.`, {
      hint:
        'Install FFmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt-get install ffmpeg; Windows: winget install --id Gyan.FFmpeg -e) ' +
        'or set MERGESTORY_FFMPEG_PATH and MERGESTORY_FFPROBE_PATH.',
    });
  }
  cached = { key, value: { ffmpeg, ffprobe } };
  return cached.value;
}

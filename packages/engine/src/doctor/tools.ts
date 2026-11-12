/** Checks of the programs a video needs: Node.js, git, FFmpeg with its H.264 encoder, and a browser. */
import { isMergeStoryError } from '../core/errors.ts';
import { SHORT_FRAME_HINT } from '../render/browser.ts';
import { check, firstLine } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

const MIN_NODE: [number, number] = [22, 12];

function parseNode(version: string): [number, number] {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return [major, minor];
}

export function checkNode({ deps }: DoctorContext): DoctorCheck {
  const [major, minor] = parseNode(deps.nodeVersion);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  const need = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  return ok
    ? check('node', 'Node.js', 'pass', `v${deps.nodeVersion} (needs ${need} or newer)`)
    : check(
        'node',
        'Node.js',
        'fail',
        `v${deps.nodeVersion} is too old (needs ${need} or newer)`,
        `Install Node.js ${MIN_NODE[0]} or newer from https://nodejs.org`,
      );
}

export async function checkGit({ deps }: DoctorContext): Promise<DoctorCheck> {
  const result = await deps.run('git', ['--version']);
  if (result.code === 0) return check('git', 'git', 'pass', firstLine(result.stdout) || 'found');
  return check(
    'git',
    'git',
    'fail',
    'git was not found',
    'Install git (macOS: xcode-select --install or brew install git; Debian/Ubuntu: sudo apt-get install git).',
  );
}

export async function checkFfmpeg({ config, deps }: DoctorContext): Promise<DoctorCheck[]> {
  let paths: { ffmpeg: string; ffprobe: string };
  try {
    paths = await deps.resolveFfmpeg(config);
  } catch (err) {
    const hint = isMergeStoryError(err) ? err.hint : undefined;
    return [
      check(
        'ffmpeg',
        'ffmpeg and ffprobe',
        'fail',
        err instanceof Error ? err.message : 'not found',
        hint ?? 'Install FFmpeg, or set MERGESTORY_FFMPEG_PATH and MERGESTORY_FFPROBE_PATH.',
      ),
      check(
        'libx264',
        'libx264 encoder',
        'fail',
        'cannot be checked without ffmpeg',
        'Install FFmpeg first.',
      ),
    ];
  }
  const version = await deps.run(paths.ffmpeg, ['-version']);
  const checks = [
    check(
      'ffmpeg',
      'ffmpeg and ffprobe',
      'pass',
      `${firstLine(version.stdout) || 'ffmpeg found'}, ffprobe found`,
    ),
  ];
  const encoders = await deps.run(paths.ffmpeg, ['-hide_banner', '-encoders']);
  checks.push(
    /\blibx264\b/.test(encoders.stdout)
      ? check('libx264', 'libx264 encoder', 'pass', 'available (H.264 MP4 output)')
      : check(
          'libx264',
          'libx264 encoder',
          'fail',
          'this ffmpeg has no libx264 encoder',
          'Install an FFmpeg build with libx264 (macOS: brew install ffmpeg; most Linux packages include it).',
        ),
  );
  return checks;
}

export async function checkBrowser({ config, deps }: DoctorContext): Promise<DoctorCheck> {
  let found: { path: string; source: string };
  try {
    found = await deps.resolveBrowser(config);
  } catch (err) {
    const hint = isMergeStoryError(err) ? err.hint : undefined;
    return check(
      'browser',
      'Browser for rendering',
      'fail',
      err instanceof Error ? err.message : 'not found',
      hint ?? 'Install Chrome or Chromium, or set MERGESTORY_BROWSER_PATH.',
    );
  }
  const version = await deps.run(found.path, ['--version']);
  const shown = version.code === 0 ? firstLine(version.stdout) : 'version unknown';
  const where = `${shown || 'found'} (${found.source}) at ${found.path}`;
  let frame: { width: number; height: number } | null;
  try {
    frame = await deps.captureTestFrame(found.path);
  } catch (err) {
    const hint = isMergeStoryError(err) ? err.hint : undefined;
    return check(
      'browser',
      'Browser for rendering',
      'fail',
      `${where}, but it did not start: ${err instanceof Error ? err.message : String(err)}`,
      hint ?? 'Install Chrome or Chromium, or set MERGESTORY_BROWSER_PATH.',
    );
  }
  if (frame?.width !== 1280 || frame.height !== 720) {
    const got = frame ? `${frame.width}x${frame.height}` : 'an unreadable';
    return check(
      'browser',
      'Browser for rendering',
      'fail',
      `${where}, but it drew ${got} frame for 1280x720`,
      SHORT_FRAME_HINT,
    );
  }
  return check('browser', 'Browser for rendering', 'pass', where);
}

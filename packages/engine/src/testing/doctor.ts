/**
 * Helpers for the doctor tests: a healthy machine to start from, and a short way to run the
 * checks with some of it changed. Not part of the public API.
 */
import { type Config, type ConfigInput, resolveConfig } from '../core/config.ts';
import { type DoctorReport, runDoctor } from '../doctor/index.ts';
import type { DoctorCheck, DoctorDeps } from '../doctor/types.ts';
import type { AccessProbeResult } from '../publish/access-probe.ts';

export const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

export const PROTECTED_PROBE: AccessProbeResult = {
  verdict: 'protected',
  reason: 'cloudflare-access',
  detail: 'redirected to the Cloudflare Access sign-in page',
  status: 302,
  host: 'videos.example.com',
};

/** A machine where everything is in place and nothing is configured, so no check reaches the network or a real file. */
export function healthyDeps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    nodeVersion: '24.14.0',
    platform: 'darwin',
    env: {},
    which: async (command) =>
      ({ say: '/usr/bin/say', gh: '/usr/local/bin/gh' })[command as 'say' | 'gh'] ?? null,
    run: async (command, args) => {
      if (command === 'git') return ok('git version 2.50.1\n');
      if (args.includes('-encoders'))
        return ok(' V....D libx264              H.264 / AVC\n V....D libx265  HEVC\n');
      if (args[0] === '-version') return ok('ffmpeg version 7.1.2 Copyright (c) 2000-2026\nbuilt with clang');
      if (args[0] === '--version') return ok('Chromium 130.0.6723.58\n');
      return { code: -1, stdout: '', stderr: 'unexpected' };
    },
    resolveFfmpeg: async () => ({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' }),
    resolveBrowser: async () => ({ path: '/usr/bin/chromium', source: 'system' }),
    kokoroStatus: async () => ({ installed: false, version: null, modelCached: false }),
    freeBytes: async () => 50 * 1024 ** 3,
    existingAncestor: async (path) => path,
    isWritable: async () => true,
    // Nothing here touches the network or the real credentials file.
    headBucket: async () => ({ kind: 'ok', httpStatus: 200, code: null }),
    probeAccess: async () => PROTECTED_PROBE,
    readYouTubeLogin: async () => null,
    publisher: async () => null,
    ...overrides,
  };
}

export function configWith(input: ConfigInput = {}): Config {
  return resolveConfig({ skipFile: true, env: {}, overrides: { home: '/data/mergestory', ...input } });
}

/** The report for a healthy machine with these settings, deps and environment variables changed. */
export async function doctor(
  config: ConfigInput = {},
  deps: Partial<DoctorDeps> = {},
  env: Record<string, string> = {},
  online = false,
): Promise<DoctorReport> {
  return runDoctor({ config: configWith(config), online, deps: healthyDeps({ env, ...deps }) });
}

export function byId(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in ${checks.map((c) => c.id).join(', ')}`);
  return found;
}

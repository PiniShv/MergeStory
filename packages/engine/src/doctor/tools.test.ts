import { describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { byId, doctor, healthyDeps, ok } from '../testing/doctor.ts';

describe('runtime and tools', () => {
  it('fails on a Node.js that is too old, and passes on exactly the minimum', async () => {
    for (const [version, status] of [
      ['22.11.0', 'fail'],
      ['20.18.0', 'fail'],
      ['22.12.0', 'pass'],
      ['22.13.1', 'pass'],
      ['23.0.0', 'pass'],
    ] as const) {
      const report = await doctor({}, { nodeVersion: version });
      expect(byId(report.checks, 'node').status, version).toBe(status);
    }
    const old = await doctor({}, { nodeVersion: '18.19.0' });
    expect(old.ok).toBe(false);
    expect(byId(old.checks, 'node').fix).toContain('nodejs.org');
  });

  it('fails when git is missing', async () => {
    const report = await doctor(
      {},
      {
        run: async (command) =>
          command === 'git' ? { code: -1, stdout: '', stderr: 'Command not found: git' } : ok('x libx264'),
      },
    );
    const git = byId(report.checks, 'git');
    expect(git.status).toBe('fail');
    expect(git.fix).toContain('Install git');
    expect(report.ok).toBe(false);
  });

  it('fails when ffmpeg is missing and uses the hint of the error', async () => {
    const report = await doctor(
      {},
      {
        resolveFfmpeg: async () => {
          throw new MergeStoryError('FFMPEG_NOT_FOUND', 'ffmpeg was not found.', {
            hint: 'brew install ffmpeg',
          });
        },
      },
    );
    expect(byId(report.checks, 'ffmpeg')).toMatchObject({
      status: 'fail',
      detail: 'ffmpeg was not found.',
      fix: 'brew install ffmpeg',
    });
    expect(byId(report.checks, 'libx264').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails when ffmpeg has no libx264', async () => {
    const report = await doctor(
      {},
      {
        run: async (command, args) => {
          if (command === 'git') return ok('git version 2.50.1');
          if (args.includes('-encoders')) return ok(' V....D libx265  HEVC\n V....D mpeg4  MPEG-4\n');
          return ok('ffmpeg version 7.1');
        },
      },
    );
    expect(byId(report.checks, 'libx264')).toMatchObject({ status: 'fail' });
    expect(byId(report.checks, 'libx264').fix).toContain('libx264');
    expect(byId(report.checks, 'ffmpeg').status).toBe('pass');
  });

  it('fails when no browser is found and passes on when its version is unknown', async () => {
    const missing = await doctor(
      {},
      {
        resolveBrowser: async () => {
          throw new MergeStoryError('BROWSER_NOT_FOUND', 'No browser found.', {
            hint: 'npx playwright-core install chromium',
          });
        },
      },
    );
    expect(byId(missing.checks, 'browser')).toMatchObject({
      status: 'fail',
      fix: 'npx playwright-core install chromium',
    });

    const silent = await doctor(
      {},
      {
        run: async (command, args) => {
          if (args[0] === '--version') return { code: 1, stdout: '', stderr: 'nope' };
          return healthyDeps().run!(command, args);
        },
      },
    );
    expect(byId(silent.checks, 'browser').status).toBe('pass');
    expect(byId(silent.checks, 'browser').detail).toContain('version unknown');
  });
});

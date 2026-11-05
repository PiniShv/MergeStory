import { describe, expect, it } from 'vitest';
import { createStyle } from '../cli/style.ts';
import { byId, configWith, doctor, healthyDeps } from '../testing/doctor.ts';
import { formatDoctor } from './format.ts';
import { runDoctor } from './index.ts';

describe('runDoctor with a healthy machine', () => {
  it('passes with the free defaults', async () => {
    const report = await doctor();
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.map((c) => c.id)).toEqual([
      'node',
      'git',
      'ffmpeg',
      'libx264',
      'browser',
      'speech-local',
      'speech',
      'llm',
      'github',
      'publish',
      'home',
      'disk',
    ]);
    expect(byId(report.checks, 'node').detail).toContain('v24.14.0');
    expect(byId(report.checks, 'git').detail).toBe('git version 2.50.1');
    expect(byId(report.checks, 'ffmpeg').detail).toContain('ffmpeg version 7.1.2');
    expect(byId(report.checks, 'browser').detail).toContain('Chromium 130.0.6723.58');
    expect(byId(report.checks, 'llm').detail).toContain('Nothing is sent to a model');
    expect(byId(report.checks, 'publish').detail).toContain('Nothing is uploaded');
    for (const check of report.checks) expect(check.status, check.id).not.toBe('fail');
  });

  it('counts the results', async () => {
    const report = await doctor({}, { which: async () => null });
    expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.checks.length);
    expect(report.summary.warn).toBeGreaterThan(0);
  });
});

describe('the order of the report', () => {
  it('runs the groups side by side and lists them in a fixed order', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const standard = healthyDeps();
    const report = await doctor(
      {},
      {
        // git waits until the browser check has started: groups that ran one after the other would wait for ever.
        run: async (command, args) => {
          if (command === 'git') await gate;
          return (standard.run as NonNullable<typeof standard.run>)(command, args);
        },
        resolveBrowser: async () => {
          release();
          return { path: '/usr/bin/chromium', source: 'system' };
        },
      },
    );
    expect(report.checks.map((c) => c.id)).toEqual([
      'node',
      'git',
      'ffmpeg',
      'libx264',
      'browser',
      'speech-local',
      'speech',
      'llm',
      'github',
      'publish',
      'home',
      'disk',
    ]);
    expect(report.ok).toBe(true);
  });

  it('keeps the order when the groups finish the other way round', async () => {
    const standard = healthyDeps();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const report = await doctor(
      {},
      {
        run: async (command, args) => {
          await sleep(command === 'git' ? 40 : 0);
          return (standard.run as NonNullable<typeof standard.run>)(command, args);
        },
      },
    );
    expect(report.checks.map((c) => c.id).slice(0, 3)).toEqual(['node', 'git', 'ffmpeg']);
    expect(report.checks.at(-1)?.id).toBe('disk');
  });
});

describe('robustness', () => {
  it('turns a check that throws into a failed check and still runs the others', async () => {
    const report = await doctor(
      {},
      {
        which: async () => {
          throw new Error('PATH is unreadable');
        },
      },
    );
    const failed = report.checks.filter((c) => c.status === 'fail');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.detail).toContain('the check itself failed: PATH is unreadable');
    expect(byId(report.checks, 'node').status).toBe('pass');
    expect(byId(report.checks, 'home').status).toBe('pass');
  });

  it('reports a broken configuration first', async () => {
    const report = await runDoctor({
      config: configWith(),
      configError: { message: 'Config file is not valid JSON: x.json', hint: 'Fix the file.' },
      deps: healthyDeps(),
    });
    expect(report.checks[0]).toMatchObject({ id: 'config', status: 'fail', fix: 'Fix the file.' });
    expect(report.ok).toBe(false);
  });

  it('never puts the value of any secret into the report', async () => {
    const secrets = {
      ANTHROPIC_API_KEY: 'sk-ant-VALUE-ONE-0123456789',
      OPENAI_API_KEY: 'sk-VALUE-TWO-0123456789abcdef',
      ELEVENLABS_API_KEY: 'xi-VALUE-THREE-0123456789',
      GITHUB_TOKEN: 'ghp_VALUETHREE0123456789abcdefghijklmnop',
      MERGESTORY_S3_ACCESS_KEY_ID: 'AKIAVALUEFOUR0123456',
      MERGESTORY_S3_SECRET_ACCESS_KEY: 'VALUE-FIVE-0123456789abcdef',
    };
    const report = await doctor(
      {
        llm: { provider: 'anthropic' },
        tts: { provider: 'openai' },
        publish: { provider: 's3', s3: { bucket: 'b' } },
      },
      {},
      secrets,
    );
    const text = JSON.stringify(report) + formatDoctor(report, createStyle(false));
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    // Names are fine to show.
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) expect(text).toContain(name);
  });
});

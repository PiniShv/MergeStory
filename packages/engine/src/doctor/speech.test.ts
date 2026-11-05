import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import { byId, doctor } from '../testing/doctor.ts';
import type { DoctorDeps } from './types.ts';

describe('speech', () => {
  it('is fine without Kokoro, which the first English run installs, and says how much it downloads', async () => {
    const linux = await doctor({}, { platform: 'linux', which: async () => null });
    const local = byId(linux.checks, 'speech-local');
    expect(local.status).toBe('pass');
    expect(local.detail).toBe(
      'Kokoro: not installed yet; the first English run installs it once (about 492 MB); macOS say: not available on this system',
    );
    expect(local.fix).toBeNull();
    const mac = await doctor({}, { env: { MERGESTORY_KOKORO_DTYPE: 'fp32' } });
    expect(byId(mac.checks, 'speech-local').detail).toContain('installs it once (about 726 MB)');
    expect(byId(mac.checks, 'speech').detail).toContain('the free Kokoro voice for English');
  });

  it('warns on Windows, where Kokoro does not install itself, and names the manual install', async () => {
    const report = await doctor({}, { platform: 'win32', which: async () => null });
    const local = byId(report.checks, 'speech-local');
    expect(local.status).toBe('warn');
    expect(local.detail).toContain('cannot install itself on Windows');
    expect(local.fix).toContain('npm ci --ignore-scripts');
    expect(local.fix).toContain('mergestory-kokoro-installed.json');
    expect(byId(report.checks, 'speech').detail).toBe(
      'auto: a free local voice if there is one, otherwise captions only',
    );
    expect(report.ok).toBe(true);
  });

  it('is happy with Kokoro alone, and with macOS say alone', async () => {
    const kokoro = await doctor(
      {},
      {
        platform: 'linux',
        which: async () => null,
        kokoroStatus: async () => ({ installed: true, version: '1.2.1', modelCached: true }),
      },
    );
    expect(byId(kokoro.checks, 'speech-local').status).toBe('pass');
    expect(byId(kokoro.checks, 'speech-local').detail).toContain('installed 1.2.1, model cached');
    const say = await doctor({}, {});
    expect(byId(say.checks, 'speech-local').status).toBe('pass');
    expect(byId(say.checks, 'speech-local').detail).toContain('macOS say: available');
  });

  it('keeps going when the Kokoro status cannot be read', async () => {
    const report = await doctor(
      {},
      {
        platform: 'linux',
        which: async () => null,
        kokoroStatus: async () => {
          throw new Error('plugin folder is damaged');
        },
      },
    );
    expect(byId(report.checks, 'speech-local').detail).toContain(
      'could not be checked: plugin folder is damaged',
    );
  });

  it('checks the configured provider', async () => {
    const cases: [ConfigInput, Partial<DoctorDeps>, Record<string, string>, string, string | RegExp][] = [
      [{ tts: { provider: 'none' } }, {}, {}, 'pass', 'captions only'],
      [{ tts: { provider: 'say' } }, {}, {}, 'pass', 'say'],
      [{ tts: { provider: 'say' } }, { platform: 'linux' }, {}, 'fail', 'only available on macOS'],
      [
        { tts: { provider: 'kokoro' } },
        {},
        {},
        'pass',
        'kokoro: not installed yet; the first run installs it once',
      ],
      [{ tts: { provider: 'kokoro' } }, { platform: 'win32' }, {}, 'fail', 'not installed'],
      [{ tts: { provider: 'openai' } }, {}, {}, 'fail', 'OPENAI_API_KEY is not set'],
      [
        { tts: { provider: 'openai' } },
        {},
        { OPENAI_API_KEY: 'sk-test-0123456789abcdef' },
        'pass',
        'sent to api.openai.com',
      ],
      [{ tts: { provider: 'elevenlabs' } }, {}, {}, 'fail', 'ELEVENLABS_API_KEY is not set'],
      [
        { tts: { provider: 'elevenlabs' } },
        {},
        { ELEVENLABS_API_KEY: 'xi-test-0123456789abcdef' },
        'pass',
        'api.elevenlabs.io',
      ],
    ];
    for (const [config, deps, env, status, detail] of cases) {
      const report = await doctor(config, deps, env);
      const check = byId(report.checks, 'speech');
      expect(check.status, JSON.stringify(config)).toBe(status);
      expect(check.detail, JSON.stringify(config)).toContain(detail as string);
    }
    const installed = await doctor(
      { tts: { provider: 'kokoro' } },
      { kokoroStatus: async () => ({ installed: true, version: '1.2.1', modelCached: false }) },
    );
    expect(byId(installed.checks, 'speech').status).toBe('pass');
  });

  it('applies the rules of the provider: Kokoro speaks English only, even when it is installed', async () => {
    const installed = {
      kokoroStatus: async () => ({ installed: true, version: '1.2.1', modelCached: true }),
    };
    const english = await doctor({ tts: { provider: 'kokoro' }, language: 'en-GB' }, installed);
    expect(byId(english.checks, 'speech').status).toBe('pass');
    const french = await doctor({ tts: { provider: 'kokoro' }, language: 'fr' }, installed);
    const check = byId(french.checks, 'speech');
    expect(check.status).toBe('fail');
    // The words of the provider, which are the words of the run.
    expect(check.detail).toBe('The Kokoro voice only speaks English.');
    expect(check.fix).toContain('The narration language is "fr"');
    expect(french.ok).toBe(false);
    // The voice itself is there, so the free local speech is not reported as missing.
    expect(byId(french.checks, 'speech-local').status).toBe('pass');
    // Not installed: installing would not help, so the language is what is reported.
    const missing = await doctor({ tts: { provider: 'kokoro' }, language: 'fr' });
    expect(byId(missing.checks, 'speech').detail).toBe('The Kokoro voice only speaks English.');
  });

  it('asks macOS say through the machine it finds: the platform and the program', async () => {
    const asked: string[] = [];
    const report = await doctor(
      { tts: { provider: 'say' } },
      {
        which: async (command) => {
          asked.push(command);
          return command === 'say' ? '/usr/bin/say' : null;
        },
      },
    );
    expect(byId(report.checks, 'speech').detail).toBe('say: available');
    expect(asked).toContain('say');
    asked.length = 0;
    await doctor(
      { tts: { provider: 'say' } },
      {
        platform: 'linux',
        which: async (command) => {
          asked.push(command);
          return null;
        },
      },
    );
    // Not on macOS: the program is not even looked for.
    expect(asked).not.toContain('say');
    const missing = await doctor({ tts: { provider: 'say' } }, { which: async () => null });
    expect(byId(missing.checks, 'speech')).toMatchObject({
      status: 'fail',
      detail: 'say selected but it is only available on macOS',
    });
  });
});

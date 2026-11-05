import { readdir, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { RunOptions, RunResult } from '../core/process.ts';
import { makeTestContext } from '../testing/narration.ts';
import { createSayProvider, findSayVoice, parseSayVoices, pickDefaultSayVoice } from './say.ts';
import { decodeWavToMono, encodeWavPcm16 } from './wav.ts';

const LISTING = `Albert              en_US    # Hello! My name is Albert.
Daniel              en_GB    # Hello, my name is Daniel. I am a British-English voice.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
Samantha            en_US    # Hello, my name is Samantha. I am an American-English voice.
Karen               en_AU    # Hello, my name is Karen.
Anna                de_DE    # Hallo, ich heisse Anna.
Amélie              fr_CA    # Bonjour, je m'appelle Amélie.
`;

interface Call {
  command: string;
  args: string[];
  options: RunOptions | undefined;
}

function fakeRunner(options: { listing?: string; listingFails?: boolean; sayFails?: boolean } = {}) {
  const calls: Call[] = [];
  const run = vi.fn(async (command: string, args: string[], runOptions?: RunOptions): Promise<RunResult> => {
    calls.push({ command, args, options: runOptions });
    const empty = { code: 0, stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) };
    if (args[0] === '-v' && args[1] === '?') {
      if (options.listingFails) throw new Error('boom');
      const stdout = options.listing ?? LISTING;
      return { ...empty, stdout, stdoutBuffer: Buffer.from(stdout) };
    }
    if (options.sayFails)
      throw new MergeStoryError('INTERNAL', 'say exited with code 1: Opening output file failed');
    const out = args[args.indexOf('-o') + 1] as string;
    await writeFile(out, encodeWavPcm16(new Int16Array(24_000).fill(1000), 24_000));
    return empty;
  });
  return { run, calls };
}

describe('parseSayVoices', () => {
  it('reads names (with spaces and brackets) and locales', () => {
    const voices = parseSayVoices(LISTING);
    expect(voices).toContainEqual({ name: 'Samantha', locale: 'en_US' });
    expect(voices).toContainEqual({ name: 'Eddy (English (US))', locale: 'en_US' });
    expect(voices).toContainEqual({ name: 'Anna', locale: 'de_DE' });
    expect(voices).toHaveLength(7);
  });

  it('ignores lines that are not voices', () => {
    expect(parseSayVoices('\nnot a voice line\n')).toEqual([]);
  });
});

describe('findSayVoice', () => {
  const voices = parseSayVoices(LISTING);

  it('matches names without regard to case, and short names against long ones', () => {
    expect(findSayVoice(voices, 'samantha')?.name).toBe('Samantha');
    expect(findSayVoice(voices, 'Eddy')?.name).toBe('Eddy (English (US))');
    expect(findSayVoice(voices, 'Eddy (English (US))')?.name).toBe('Eddy (English (US))');
    expect(findSayVoice(voices, ' DANIEL ')?.name).toBe('Daniel');
  });

  it('returns null for an unknown voice', () => {
    expect(findSayVoice(voices, 'Nobody')).toBeNull();
  });
});

describe('pickDefaultSayVoice', () => {
  it('prefers Samantha for English on a plain system', () => {
    expect(pickDefaultSayVoice(parseSayVoices(LISTING), 'en')).toBe('Samantha');
  });

  it('prefers a downloaded Premium voice, then an Enhanced one', () => {
    const enhanced = parseSayVoices(`${LISTING}Zoe (Enhanced)       en_US    # Hello, my name is Zoe.\n`);
    expect(pickDefaultSayVoice(enhanced, 'en-US')).toBe('Zoe (Enhanced)');
    const premium = parseSayVoices(
      `${LISTING}Zoe (Enhanced) en_US # x\nAva (Premium)  en_US   # Hello, I am Ava.\n`,
    );
    expect(pickDefaultSayVoice(premium, 'en')).toBe('Ava (Premium)');
  });

  it('falls back to the other known voices, then to the system default', () => {
    expect(pickDefaultSayVoice(parseSayVoices('Daniel   en_GB   # hi\nAlbert  en_US  # hi\n'), 'en')).toBe(
      'Daniel',
    );
    expect(pickDefaultSayVoice(parseSayVoices('Albert  en_US  # hi\nBells  en_US  # hi\n'), 'en')).toBeNull();
  });

  it('uses the first voice of the right language for other languages', () => {
    expect(pickDefaultSayVoice(parseSayVoices(LISTING), 'de')).toBe('Anna');
    expect(pickDefaultSayVoice(parseSayVoices(LISTING), 'fr-CA')).toBe('Amélie');
    expect(pickDefaultSayVoice(parseSayVoices(LISTING), 'ja')).toBeNull();
  });
});

describe('say provider', () => {
  it('is available only on macOS with the binary present, and says what to do instead', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const yes = createSayProvider({ platform: 'darwin', isExecutable: async () => true });
    const noBinary = createSayProvider({ platform: 'darwin', isExecutable: async () => false });
    const linux = createSayProvider({ platform: 'linux', isExecutable: async () => true });
    expect(await yes.unavailable(ctx)).toBeNull();
    for (const provider of [noBinary, linux]) {
      const problem = await provider.unavailable(ctx);
      expect(problem).toMatchObject({
        code: 'TTS_FAILED',
        message: 'The macOS "say" voice is only available on macOS.',
      });
      expect(problem?.hint).toContain('mergestory setup kokoro');
    }
    await cleanup();
  });

  it('builds the command with the WAV format flags, the voice and the rate, and passes text on stdin', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner();
    const provider = createSayProvider({ run, sayPath: '/usr/bin/say' });
    const result = await provider.synthesize(
      { text: '-- Hello [[slnc 500]] world', voice: 'Samantha', language: 'en', speed: 1 },
      ctx,
    );
    const call = calls.find((c) => c.args.includes('-o'));
    expect(call?.command).toBe('/usr/bin/say');
    const args = call?.args ?? [];
    expect(args.slice(0, 4)).toEqual(['-v', 'Samantha', '-r', '185']);
    expect(args).toContain('--file-format=WAVE');
    expect(args).toContain('--data-format=LEI16@24000');
    expect(args.slice(-2)).toEqual(['-f', '-']);
    expect(args[args.indexOf('-o') + 1]).toContain(ctx.runDir);
    // The text is never an argument, and embedded commands are neutralised.
    expect(args.join(' ')).not.toContain('Hello');
    expect(call?.options?.input).toBe('-- Hello [ [slnc 500]] world');
    expect(result.format).toBe('wav');
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.characters).toBe('-- Hello [[slnc 500]] world'.length);
    expect(decodeWavToMono(result.audio).samples.length).toBe(24_000);
    await cleanup();
  });

  it('turns speed into words per minute within a safe range', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner();
    const provider = createSayProvider({ run });
    const rateFor = async (speed: number): Promise<string> => {
      calls.length = 0;
      await provider.synthesize({ text: 'Hi.', voice: 'Samantha', language: 'en', speed }, ctx);
      const args = calls.find((c) => c.args.includes('-o'))?.args ?? [];
      return args[args.indexOf('-r') + 1] as string;
    };
    expect(await rateFor(1)).toBe('185');
    expect(await rateFor(1.2)).toBe('222');
    expect(await rateFor(0.5)).toBe('93');
    expect(await rateFor(2)).toBe('370');
    await cleanup();
  });

  it('picks a default voice for the language when none is requested', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner();
    const provider = createSayProvider({ run });
    await provider.synthesize({ text: 'Hi.', voice: null, language: 'en', speed: 1 }, ctx);
    const args = calls.find((c) => c.args.includes('-o'))?.args ?? [];
    expect(args.slice(0, 2)).toEqual(['-v', 'Samantha']);
    await cleanup();
  });

  it('omits -v when no suitable voice exists, so the system default is used', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner({ listing: 'Albert  en_US  # hi\n' });
    const provider = createSayProvider({ run });
    await provider.synthesize({ text: 'Hi.', voice: null, language: 'en', speed: 1 }, ctx);
    const args = calls.find((c) => c.args.includes('-o'))?.args ?? [];
    expect(args).not.toContain('-v');
    await cleanup();
  });

  it('does not read another language with the English system voice', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner();
    const provider = createSayProvider({ run });
    const error = await provider
      .synthesize({ text: 'Konnichiwa.', voice: null, language: 'ja', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect((error as MergeStoryError).code).toBe('TTS_FAILED');
    expect((error as MergeStoryError).message).toContain('"ja"');
    expect(calls.some((c) => c.args.includes('-o'))).toBe(false);
    await cleanup();
  });

  it('refuses a voice that is not installed instead of silently using another one', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run, calls } = fakeRunner();
    const provider = createSayProvider({ run });
    const error = await provider
      .synthesize({ text: 'Hi.', voice: 'Nobody', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect((error as MergeStoryError).code).toBe('TTS_FAILED');
    expect((error as MergeStoryError).hint).toContain("say -v '?'");
    expect(calls.some((c) => c.args.includes('-o'))).toBe(false);
    await cleanup();
  });

  it('rejects voice names that could be read as options when the voice list is unavailable', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run } = fakeRunner({ listingFails: true });
    const provider = createSayProvider({ run });
    const error = await provider
      .synthesize({ text: 'Hi.', voice: '-o', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect((error as MergeStoryError).code).toBe('CONFIG_INVALID');
    await cleanup();
  });

  it('reports the voice that will really be used, and has no model', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run } = fakeRunner();
    const provider = createSayProvider({ run });
    expect(await provider.voice(ctx)).toBe('Samantha');
    expect(provider.model(ctx)).toBeNull();
    const configured = await makeTestContext({ config: { tts: { voice: 'eddy' } } });
    expect(await createSayProvider({ run }).voice(configured.ctx)).toBe('Eddy (English (US))');
    // A name that no installed voice has stays as written, and the request then says it is missing.
    const unknown = await makeTestContext({ config: { tts: { voice: 'Nobody' } } });
    expect(await createSayProvider({ run }).voice(unknown.ctx)).toBe('Nobody');
    const german = await makeTestContext({ config: { language: 'de' } });
    expect(await createSayProvider({ run }).voice(german.ctx)).toBe('Anna');
    await Promise.all([configured.cleanup(), unknown.cleanup(), german.cleanup(), cleanup()]);
  });

  it('turns a failing say command into a TTS_FAILED error with a hint, and removes its temporary folder', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { run } = fakeRunner({ sayFails: true });
    const provider = createSayProvider({ run });
    const error = await provider
      .synthesize({ text: 'Hi.', voice: 'Samantha', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect((error as MergeStoryError).code).toBe('TTS_FAILED');
    expect((error as MergeStoryError).hint).toBeTruthy();
    expect((await readdir(ctx.runDir)).filter((name) => name.startsWith('.say-'))).toEqual([]);
    await cleanup();
  });

  it('is free, and sends nothing anywhere', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(createSayProvider().estimateCostUsd(5000, ctx)).toBe(0);
    expect(await createSayProvider().plannedEgress(ctx, 5000)).toEqual([]);
    await cleanup();
  });
});

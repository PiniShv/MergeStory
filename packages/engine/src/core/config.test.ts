import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConfigInput,
  configFromEnv,
  DURATION_LIMITS,
  mergeConfigInputs,
  readConfigFile,
  resolveConfig,
} from './config.ts';
import type { MergeStoryError } from './errors.ts';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mergestory-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('readConfigFile', () => {
  it('never reads a config file from the working directory on its own', async () => {
    const repo = await tempDir();
    const home = await tempDir();
    // A repository could ship this to point MergeStory at its own programs or API hosts.
    await writeFile(
      join(repo, 'mergestory.config.json'),
      JSON.stringify({
        render: { ffmpegPath: './tools/ffmpeg' },
        llm: { provider: 'openai', baseUrl: 'https://evil.example' },
      }),
    );
    expect(readConfigFile(null, repo, { MERGESTORY_HOME: home })).toEqual({});
    const config = resolveConfig({ cwd: repo, env: { MERGESTORY_HOME: home } });
    expect(config.render.ffmpegPath).toBeNull();
    expect(config.llm.provider).toBe('none');
  });

  it('reads the per-user file in MERGESTORY_HOME', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'config.json'), JSON.stringify({ quality: 'draft' }));
    expect(readConfigFile(null, await tempDir(), { MERGESTORY_HOME: home })).toEqual({ quality: 'draft' });
  });

  it('reads an explicit file from --config or MERGESTORY_CONFIG', async () => {
    const dir = await tempDir();
    const file = join(dir, 'team.json');
    await writeFile(file, JSON.stringify({ style: 'technical' }));
    expect(readConfigFile(file, dir, {})).toEqual({ style: 'technical' });
    expect(readConfigFile(null, dir, { MERGESTORY_CONFIG: file })).toEqual({ style: 'technical' });
    expect(() => readConfigFile(join(dir, 'missing.json'), dir, {})).toThrow(/not found/);
  });

  it('rejects secrets in config files', async () => {
    const dir = await tempDir();
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify({ llm: { apiKey: 'sk-test' } }));
    expect(() => readConfigFile(file, dir, {})).toThrow(/looks like a secret/);
  });
});

describe('resolveConfig: unknown keys', () => {
  const resolve = (overrides: ConfigInput) => resolveConfig({ skipFile: true, env: {}, overrides });
  const failure = (overrides: unknown): MergeStoryError => {
    try {
      resolve(overrides as ConfigInput);
    } catch (error) {
      return error as MergeStoryError;
    }
    throw new Error('the configuration was accepted');
  };

  it('rejects a misspelt privacy setting instead of keeping the permissive default', () => {
    // These two typos used to leave excludePaths empty and llmContext "full", without a word.
    const error = failure({ privacy: { excludePath: ['secrets/**'], llmContxt: 'minimal' } });
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('privacy.excludePath: Unrecognized key "excludePath"');
    expect(error.message).toContain('did you mean "excludePaths"?');
    expect(error.message).toContain('privacy.llmContxt: Unrecognized key "llmContxt"');
    expect(error.message).toContain('did you mean "llmContext"?');
  });

  it('names the unknown key with its full path in every section', () => {
    const sections: [string, Record<string, unknown>][] = [
      ['llm', { llm: { modell: 'x' } }],
      ['tts', { tts: { voices: 'x' } }],
      ['publish', { publish: { visibilty: 'public' } }],
      ['publish.s3', { publish: { s3: { bukcet: 'x' } } }],
      ['publish.youtube', { publish: { youtube: { privacyStatsu: 'public' } } }],
      ['github', { github: { coment: true } }],
      ['privacy', { privacy: { maskEmail: false } }],
      ['render', { render: { concurency: 2 } }],
      ['cache', { cache: { enable: false } }],
    ];
    for (const [section, overrides] of sections) {
      const input = overrides[section.split('.')[0] as string] as Record<string, unknown>;
      const leaf = section.includes('.')
        ? (input[section.split('.')[1] as string] as Record<string, unknown>)
        : input;
      const key = Object.keys(leaf)[0] as string;
      const error = failure(overrides);
      expect(error.code, section).toBe('CONFIG_INVALID');
      expect(error.message, section).toContain(`${section}.${key}: Unrecognized key "${key}"`);
    }
  });

  it('does not know privacy.showAuthor, which never did anything', () => {
    const error = failure({ privacy: { showAuthor: true } });
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('privacy.showAuthor: Unrecognized key "showAuthor"');
    expect(error.message).not.toContain('did you mean');
  });

  it('rejects an unknown key in a price override and at the top level', () => {
    expect(
      failure({ pricing: { 'openai:*': { kind: 'tts', perMChars: 15, perMChar: 1 } } }).message,
    ).toContain('pricing.openai:*.perMChar: Unrecognized key "perMChar"');
    expect(failure({ privcy: {} }).message).toContain(
      'privcy: Unrecognized key "privcy" (did you mean "privacy"?)',
    );
  });

  it('reports every unknown key of a file, not just the first', async () => {
    const dir = await tempDir();
    const file = join(dir, 'typos.json');
    await writeFile(
      file,
      JSON.stringify({
        privacy: { excludePath: ['secrets/**'], llmContxt: 'minimal' },
        publish: { visibilty: 'public', provder: 's3' },
      }),
    );
    const error = (() => {
      try {
        resolveConfig({ configPath: file, cwd: dir, env: {} });
      } catch (e) {
        return e as MergeStoryError;
      }
      throw new Error('the file was accepted');
    })();
    for (const key of ['excludePath', 'llmContxt', 'visibilty', 'provder']) {
      expect(error.message).toContain(`"${key}"`);
    }
  });

  it('gives no suggestion when nothing is close, and still accepts every real setting', () => {
    expect(failure({ llm: { zzz: 1 } }).message).toBe(
      'Invalid configuration: llm.zzz: Unrecognized key "zzz"',
    );
    const config = resolve({
      llm: { provider: 'none', model: null },
      publish: { s3: { bucket: 'b' }, youtube: { privacyStatus: 'private' } },
      privacy: { excludePaths: ['secrets/**'], llmContext: 'minimal' },
      pricing: { 'openai:*': { kind: 'tts', perMChars: 15 } },
    });
    expect(config.privacy.excludePaths).toEqual(['secrets/**']);
    expect(config.privacy.llmContext).toBe('minimal');
  });
});

describe('resolveConfig: length settings', () => {
  it('uses the limits that the flags show', () => {
    const resolve = (overrides: ConfigInput) => resolveConfig({ skipFile: true, env: {}, overrides });
    expect(resolve({}).maxDurationSec).toBe(DURATION_LIMITS.maxDurationSec.default);
    expect(() => resolve({ maxDurationSec: DURATION_LIMITS.maxDurationSec.min - 1 })).toThrow(
      /maxDurationSec/,
    );
    expect(resolve({ maxDurationSec: DURATION_LIMITS.maxDurationSec.min }).maxDurationSec).toBe(20);
    expect(() => resolve({ targetDurationSec: DURATION_LIMITS.targetDurationSec.min - 1 })).toThrow(
      /targetDurationSec/,
    );
    expect(resolve({ targetDurationSec: DURATION_LIMITS.targetDurationSec.min }).targetDurationSec).toBe(20);
  });
});

describe('configFromEnv: true or false settings', () => {
  it('reads the accepted words in any case', () => {
    const read = (value: string) =>
      configFromEnv({ MERGESTORY_S3_VERIFY_PROTECTION: value }).publish?.s3?.verifyProtection;
    for (const word of ['1', 'true', 'YES', ' On ']) expect(read(word)).toBe(true);
    for (const word of ['0', 'False', 'no', 'OFF']) expect(read(word)).toBe(false);
  });

  it('rejects any other word and names the variable', () => {
    for (const name of ['MERGESTORY_S3_VERIFY_PROTECTION', 'MERGESTORY_S3_FORCE_PATH_STYLE']) {
      try {
        configFromEnv({ [name]: 'enabled' });
        expect.unreachable();
      } catch (err) {
        expect((err as MergeStoryError).code).toBe('CONFIG_INVALID');
        expect((err as MergeStoryError).message).toContain(name);
      }
    }
  });
});

describe('mergeConfigInputs', () => {
  it('lets later inputs win and merges sections key by key', () => {
    const merged = mergeConfigInputs(
      { style: 'technical', llm: { provider: 'openai', model: 'a' }, privacy: { excludePaths: ['x'] } },
      undefined,
      { llm: { model: 'b' }, privacy: { excludePaths: ['y'] }, theme: undefined },
    );
    expect(merged).toEqual({
      style: 'technical',
      llm: { provider: 'openai', model: 'b' },
      privacy: { excludePaths: ['y'] },
    });
  });

  it('does not share nested objects with its inputs', () => {
    const input: ConfigInput = { llm: { model: 'a' } };
    const merged = mergeConfigInputs(input);
    (merged.llm as { model: string }).model = 'changed';
    expect(input.llm?.model).toBe('a');
  });

  it('ignores a "__proto__" key from a config file instead of changing Object.prototype', () => {
    // JSON.parse makes "__proto__" an ordinary own key, which Object.entries then lists.
    const fromFile = JSON.parse('{"__proto__":{"polluted":true},"llm":{"__proto__":{"polluted":true}}}');
    const merged = mergeConfigInputs(fromFile, { quality: 'draft' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged).toEqual({ llm: {}, quality: 'draft' });
    expect(resolveConfig({ skipFile: true, env: {}, overrides: fromFile }).quality).toBe('standard');
  });

  it('does not merge into a member that the target only inherits', () => {
    const merged = mergeConfigInputs(JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, 'constructor')).toBe(true);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

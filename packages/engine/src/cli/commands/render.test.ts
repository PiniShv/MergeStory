import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../core/config.ts';
import { dir, fakePlan, fakeResult, generateMock, lastGenerateOptions, run } from '../../testing/cli.ts';
import { localOnlyOverrides } from './render.ts';

vi.mock('../../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

/** An environment and a config file that ask for every remote or paid setting. */
const REMOTE_ENV = {
  MERGESTORY_LLM_PROVIDER: 'anthropic',
  MERGESTORY_PUBLISH_PROVIDER: 's3',
  MERGESTORY_TTS_PROVIDER: 'openai',
  MERGESTORY_CONFIG: 'remote.json',
};
const REMOTE_FILE = {
  github: { comment: true, updateDescription: true },
  publish: { provider: 's3', localDir: '/elsewhere' },
  render: { musicPath: '/music.mp3' },
  outDir: '/elsewhere/runs',
};

/** The settings a run would use: the options render passed on, resolved the way the pipeline does. */
function settingsOfLastRun(env: Record<string, string>) {
  return resolveConfig({ overrides: lastGenerateOptions().config, env, cwd: dir });
}

describe('render', () => {
  it('stays on this machine whatever the environment and the config file say', async () => {
    await writeFile(join(dir, 'remote.json'), JSON.stringify(REMOTE_FILE));
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run(['render', 'acme/app#1', '--style', 'product'], REMOTE_ENV);
    expect(code).toBe(0);
    const config = settingsOfLastRun({ ...REMOTE_ENV, MERGESTORY_HOME: join(dir, 'home') });
    expect(config.llm.provider).toBe('none');
    expect(config.tts.provider).toBe('auto');
    expect(config.publish.provider).toBe('local');
    expect(config.publish.localDir).toBeNull();
    expect(config.github.comment).toBe(false);
    expect(config.github.updateDescription).toBe(false);
    expect(config.render.musicPath).toBeNull();
    expect(config.outDir).toBeNull();
    expect(config.style).toBe('product');
    expect(lastGenerateOptions().configPath).toBeUndefined();
  });

  it('keeps a local voice that was asked for', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['render', '--tts', 'say', '--voice', 'Samantha']);
    expect(lastGenerateOptions().config?.tts).toEqual({ provider: 'say', voice: 'Samantha' });
  });

  it('never passes on a remote voice', () => {
    expect(localOnlyOverrides({ tts: 'openai' }).tts).toEqual({ provider: 'auto' });
    expect(localOnlyOverrides({}).tts).toEqual({ provider: 'auto' });
  });

  it('refuses a paid voice', async () => {
    const { code, stderr } = await run(['render', '--tts', 'openai']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['--llm', 'anthropic'],
    ['--model', 'm'],
    ['--llm-base-url', 'http://localhost:1/v1'],
    ['--publish', 's3'],
    ['--visibility', 'public'],
    ['--comment'],
    ['--update-description'],
    ['--budget', '1'],
    ['--async'],
    ['--out', 'out'],
    ['--music', 'music.mp3'],
  ])('refuses %s', async (...words) => {
    const { code, stderr } = await run(['render', ...words]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown option');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('shows the plan with --dry-run', async () => {
    generateMock.mockResolvedValue(fakePlan());
    const { code, stdout } = await run(['render', '--dry-run', '--json']);
    expect(code).toBe(0);
    expect(lastGenerateOptions().dryRun).toBe(true);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(fakePlan())));
  });

  it('reads the storyboard and prints the same result as generate', async () => {
    await writeFile(join(dir, 'sb.json'), JSON.stringify({ title: 'x' }));
    generateMock.mockResolvedValue(fakeResult());
    const rendered = await run(['render', 'acme/app#1', '--storyboard', 'sb.json', '--json']);
    expect(lastGenerateOptions().storyboard).toEqual({ title: 'x' });
    const generated = await run(['generate', 'acme/app#1', '--storyboard', 'sb.json', '--json']);
    expect(rendered.code).toBe(generated.code);
    expect(JSON.parse(rendered.stdout)).toEqual(JSON.parse(generated.stdout));
  });
});

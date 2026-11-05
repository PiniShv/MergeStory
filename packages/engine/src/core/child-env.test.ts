import { describe, expect, it } from 'vitest';
import { ghEnvironment, gitEnvironment } from './child-env.ts';

const source: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-1',
  OPENAI_API_KEY: 'sk-1',
  GITHUB_TOKEN: 'ghp_1',
  GH_TOKEN: 'ghp_2',
  AWS_SECRET_ACCESS_KEY: 'aws-1',
  MY_COMPANY_SERVICE_PASSWORD: 'pw',
  SOME_PRIVATE_KEY_FILE: '/key',
  GH_HOST: 'ghe.example.com',
  GH_ENTERPRISE_TOKEN: 'ghp_3',
  GIT_DIR: '/elsewhere/.git',
  GIT_WORK_TREE: '/elsewhere',
  GIT_EXTERNAL_DIFF: 'evil',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'A Person',
};

describe('gitEnvironment', () => {
  const env = gitEnvironment(source);

  it('keeps what git needs', () => {
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/someone');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  it('drops credentials, known or not', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'MY_COMPANY_SERVICE_PASSWORD',
      'SOME_PRIVATE_KEY_FILE',
      'GH_ENTERPRISE_TOKEN',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('removes variables that would redirect git, and switches off prompts and optional locks', () => {
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LC_ALL).toBe('C');
  });

  it('does not change the environment it was given', () => {
    expect(source.GIT_DIR).toBe('/elsewhere/.git');
    expect(source.ANTHROPIC_API_KEY).toBe('sk-ant-1');
  });
});

describe('ghEnvironment', () => {
  const env = ghEnvironment(source);

  it('keeps gh settings, but no credential at all (gh would print a token variable for any host)', () => {
    expect(env.GH_HOST).toBe('ghe.example.com');
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.MY_COMPANY_SERVICE_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('turns off prompts and colour', () => {
    expect(env.GH_PROMPT_DISABLED).toBe('1');
    expect(env.NO_COLOR).toBe('1');
  });
});

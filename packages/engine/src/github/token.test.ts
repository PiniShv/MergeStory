import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testContext } from '../testing/context.ts';
import { parsePullRequestUrl } from './pr-url.ts';
import { envTokenAllowed, originOf, resolveToken } from './token.ts';

describe('envTokenAllowed', () => {
  it('allows api.github.com and the configured host only', () => {
    const github = parsePullRequestUrl('https://github.com/acme/widgets/pull/7');
    expect(envTokenAllowed(github, 'https://api.github.com')).toBe(true);
    const enterprise = parsePullRequestUrl('https://git.example.com/acme/widgets/pull/7');
    expect(envTokenAllowed(enterprise, 'https://api.github.com')).toBe(false);
    expect(envTokenAllowed(enterprise, 'https://git.example.com/api/v3')).toBe(true);
  });

  it('reads the origin of a URL, or null', () => {
    expect(originOf('https://a.example/x/y')).toBe('https://a.example');
    expect(originOf('not a url')).toBeNull();
  });
});

describe('resolveToken', () => {
  const home = process.cwd();
  let dir = '';
  afterEach(async () => {
    process.chdir(home);
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('never starts a gh that only a PATH entry without a full path supplies', async () => {
    // A bare-name start would find bin/gh below the current folder and hand its output on as the token.
    dir = await mkdtemp(join(tmpdir(), 'mergestory-gh-'));
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'gh'), '#!/bin/sh\necho not-a-real-token\n', { mode: 0o755 });
    process.chdir(dir);
    vi.stubEnv('PATH', 'bin');
    const ref = parsePullRequestUrl('https://github.com/acme/widgets/pull/7');
    expect(await resolveToken(ref, testContext().ctx, 'gh')).toEqual({ token: null, refusedEnv: false });
  });
});

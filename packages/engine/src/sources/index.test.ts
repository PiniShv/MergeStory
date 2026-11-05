import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMergeStoryError } from '../core/errors.ts';
import { createSourceProvider, detectSourceInput } from './index.ts';

const cwd = resolve(tmpdir(), 'mergestory-detect-cwd-that-does-not-exist');

describe('detectSourceInput', () => {
  it('defaults to the current directory', () => {
    for (const arg of [undefined, null, '', '  ']) {
      expect(detectSourceInput(arg, { cwd })).toEqual({
        kind: 'local',
        repoPath: cwd,
        base: null,
        head: null,
      });
    }
  });

  it('turns a path into an absolute local source and passes base and head through', () => {
    expect(detectSourceInput('some/dir', { cwd, base: 'main', head: 'feature' })).toEqual({
      kind: 'local',
      repoPath: join(cwd, 'some/dir'),
      base: 'main',
      head: 'feature',
    });
    expect(detectSourceInput('/abs/repo', { cwd, base: '  ', head: '' })).toEqual({
      kind: 'local',
      repoPath: '/abs/repo',
      base: null,
      head: null,
    });
    expect(detectSourceInput('.', { cwd }).kind).toBe('local');
  });

  it.each([
    ['https://github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets/pull/42'],
    [
      'https://github.com/acme/widgets/pull/42/files?w=1#diff',
      'https://github.com/acme/widgets/pull/42/files?w=1#diff',
    ],
    ['  https://github.com/acme/widgets/pull/42  ', 'https://github.com/acme/widgets/pull/42'],
    ['github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets/pull/42'],
    ['acme/widgets#42', 'https://github.com/acme/widgets/pull/42'],
    ['https://ghe.example.com/team/app/pull/7', 'https://ghe.example.com/team/app/pull/7'],
    ['ghe.example.com/team/app/pull/7', 'https://ghe.example.com/team/app/pull/7'],
  ])('recognises the pull request %s', (arg, url) => {
    expect(detectSourceInput(arg, { cwd })).toEqual({ kind: 'github', url });
  });

  it('prefers a path that exists on disk over pull request shorthand', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mergestory-detect-'));
    try {
      await mkdir(join(dir, 'acme', 'widgets#42'), { recursive: true });
      expect(detectSourceInput('acme/widgets#42', { cwd: dir })).toEqual({
        kind: 'local',
        repoPath: join(dir, 'acme', 'widgets#42'),
        base: null,
        head: null,
      });
      // The same text with no such directory is a pull request.
      expect(detectSourceInput('acme/widgets#42', { cwd }).kind).toBe('github');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails early, with SOURCE_INVALID, for a URL that is not a pull request', () => {
    for (const arg of [
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets/issues/1',
      'http://github.com/acme/widgets/pull/1',
      'ssh://git@github.com/acme/widgets.git',
    ]) {
      try {
        detectSourceInput(arg, { cwd });
        expect.unreachable(arg);
      } catch (error) {
        expect(isMergeStoryError(error), arg).toBe(true);
        if (isMergeStoryError(error)) expect(error.code).toBe('SOURCE_INVALID');
      }
    }
  });

  it('refuses base and head for a pull request', () => {
    for (const options of [{ base: 'main' }, { head: 'x' }]) {
      try {
        detectSourceInput('acme/widgets#1', { cwd, ...options });
        expect.unreachable('should throw');
      } catch (error) {
        expect(isMergeStoryError(error)).toBe(true);
        if (isMergeStoryError(error)) {
          expect(error.code).toBe('USAGE');
          expect(error.hint).toBeTruthy();
        }
      }
    }
  });
});

describe('createSourceProvider', () => {
  it('picks the source for the input kind', () => {
    expect(createSourceProvider({ kind: 'github', url: 'https://github.com/a/b/pull/1' }).id).toBe('github');
    expect(createSourceProvider({ kind: 'local', repoPath: '.', base: null, head: null }).id).toBe('local');
  });
});

describe('detectSourceInput limits', () => {
  it('rejects absurdly long arguments before matching them', () => {
    try {
      detectSourceInput(`${'a.'.repeat(50_000)}x`, { cwd });
      expect.unreachable('should throw');
    } catch (error) {
      expect(isMergeStoryError(error)).toBe(true);
      if (isMergeStoryError(error)) expect(error.code).toBe('SOURCE_INVALID');
    }
  });
});

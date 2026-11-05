import { describe, expect, it } from 'vitest';
import { basename, dirname, extname, isInside, joinPosix, normalizePosix } from './posix.ts';

describe('dirname and basename', () => {
  it('split a repository path at its last "/"', () => {
    expect(dirname('src/http/retry.ts')).toBe('src/http');
    expect(basename('src/http/retry.ts')).toBe('retry.ts');
    expect(dirname('README.md')).toBe('');
    expect(basename('README.md')).toBe('README.md');
    expect(dirname('/etc')).toBe('');
    expect(basename('src/dir/')).toBe('');
    expect(basename('')).toBe('');
  });
});

describe('extname', () => {
  it('is the lower-case extension with its dot', () => {
    expect(extname('src/App.TSX')).toBe('.tsx');
    expect(extname('archive.tar.gz')).toBe('.gz');
    expect(extname('dir.d/file')).toBe('');
  });

  it('is empty for no extension and for dotfiles', () => {
    expect(extname('Makefile')).toBe('');
    expect(extname('.gitignore')).toBe('');
    expect(extname('src/.env')).toBe('');
    expect(extname('.eslintrc.json')).toBe('.json');
  });
});

describe('normalizePosix', () => {
  it('resolves "." and ".." and drops empty parts', () => {
    expect(normalizePosix('a/./b/../c')).toBe('a/c');
    expect(normalizePosix('./a//b/')).toBe('a/b');
    expect(normalizePosix('a/..')).toBe('');
  });

  it('is null for a path that leaves the root', () => {
    expect(normalizePosix('../a')).toBeNull();
    expect(normalizePosix('a/../../b')).toBeNull();
  });
});

describe('joinPosix', () => {
  it('joins with "/" and skips empty parts', () => {
    expect(joinPosix('a', '', 'b/c')).toBe('a/b/c');
    expect(joinPosix('', 'a')).toBe('a');
    expect(joinPosix()).toBe('');
  });
});

describe('isInside', () => {
  it('knows what is inside a directory', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true);
    expect(isInside('/a/b', '/a/b/..hidden')).toBe(true);
    expect(isInside('/', '/a')).toBe(true);
  });

  it('refuses a sibling that starts with the same letters, a parent, and a way out', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
    expect(isInside('/a/b', '/x')).toBe(false);
  });
});

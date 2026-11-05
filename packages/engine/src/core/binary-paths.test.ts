import { describe, expect, it } from 'vitest';
import { isLikelyBinaryPath } from './binary-paths.ts';

describe('isLikelyBinaryPath', () => {
  it('flags well-known binary extensions only', () => {
    expect(isLikelyBinaryPath('assets/logo.PNG')).toBe(true);
    expect(isLikelyBinaryPath('x/archive.tar.gz')).toBe(true);
    expect(isLikelyBinaryPath('lib/native.so')).toBe(true);
    expect(isLikelyBinaryPath('src/a.ts')).toBe(false);
    expect(isLikelyBinaryPath('README')).toBe(false);
    expect(isLikelyBinaryPath('.png')).toBe(false);
  });

  it('looks at the file name, not at the folders', () => {
    expect(isLikelyBinaryPath('images.png/readme')).toBe(false);
    expect(isLikelyBinaryPath('images.png/readme.md')).toBe(false);
    expect(isLikelyBinaryPath('a.b/c.JPG')).toBe(true);
  });
});

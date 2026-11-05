import { describe, expect, it } from 'vitest';
import { cacheControlFor, contentTypeFor } from './content-types.ts';

describe('contentTypeFor', () => {
  it.each([
    ['video.mp4', 'video/mp4'],
    ['poster.jpg', 'image/jpeg'],
    ['poster.jpeg', 'image/jpeg'],
    ['poster.png', 'image/png'],
    ['captions.vtt', 'text/vtt; charset=utf-8'],
    ['index.html', 'text/html; charset=utf-8'],
    ['VIDEO.MP4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['notes.bin', 'application/octet-stream'],
    ['no-extension', 'application/octet-stream'],
  ])('maps %s to %s', (name, type) => {
    expect(contentTypeFor(name)).toBe(type);
  });
});

describe('cacheControlFor', () => {
  it('caches media for a year, because every upload has a new key', () => {
    expect(cacheControlFor('video.mp4', 'public')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('poster.jpg', 'public')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('captions.vtt', 'public')).toBe('public, max-age=31536000, immutable');
  });

  it('keeps private media out of shared caches', () => {
    expect(cacheControlFor('video.mp4', 'private')).toBe('private, max-age=31536000, immutable');
  });

  it('revalidates the watch page of a private upload, because it embeds signed links', () => {
    expect(cacheControlFor('index.html', 'private')).toBe('private, no-cache');
  });

  it('caches the watch page of a public upload like any other file', () => {
    expect(cacheControlFor('index.html', 'public')).toBe('public, max-age=31536000, immutable');
  });

  it('defaults to private', () => {
    expect(cacheControlFor('index.html')).toBe('private, no-cache');
  });

  describe('protected links', () => {
    it('keeps media out of shared caches, because the files sit behind a sign-in', () => {
      for (const name of ['video.mp4', 'poster.jpg', 'captions.vtt']) {
        expect(cacheControlFor(name, 'protected'), name).toBe('private, max-age=31536000, immutable');
      }
    });

    it('revalidates the watch page every time, so the access proxy sees each visit', () => {
      expect(cacheControlFor('index.html', 'protected')).toBe('private, no-cache');
    });

    it('never allows a shared cache to keep a file', () => {
      for (const name of ['video.mp4', 'poster.png', 'captions.vtt', 'index.html', 'notes.bin']) {
        const header = cacheControlFor(name, 'protected');
        expect(header, name).toContain('private');
        expect(header, name).not.toContain('public');
      }
    });
  });

  it('only lets public files into shared caches', () => {
    for (const visibility of ['private', 'protected'] as const) {
      expect(cacheControlFor('video.mp4', visibility)).not.toContain('public');
    }
    expect(cacheControlFor('video.mp4', 'public')).toContain('public');
  });
});

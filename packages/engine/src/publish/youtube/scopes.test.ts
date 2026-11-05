import { describe, expect, it } from 'vitest';
import {
  describeScope,
  hasScopes,
  parseScopes,
  requiredScopes,
  SCOPES,
  scopeAllows,
  shortScope,
} from './scopes.ts';

describe('requiredScopes', () => {
  it('asks only for youtube.upload when captions and playlists are off', () => {
    expect(requiredScopes({ uploadCaptions: false, playlistId: null })).toEqual([SCOPES.upload]);
  });

  it('asks only for youtube.force-ssl when captions are on', () => {
    expect(requiredScopes({ uploadCaptions: true, playlistId: null })).toEqual([SCOPES.forceSsl]);
  });

  it('asks only for youtube.force-ssl when a playlist is set', () => {
    expect(requiredScopes({ uploadCaptions: false, playlistId: 'PLabcdefghijkl' })).toEqual([
      SCOPES.forceSsl,
    ]);
  });
});

describe('scopeAllows', () => {
  it('lets youtube.upload upload and set thumbnails, but not add captions or playlist items', () => {
    const granted = [SCOPES.upload];
    expect(scopeAllows(granted, 'videos.insert')).toBe(true);
    expect(scopeAllows(granted, 'thumbnails.set')).toBe(true);
    expect(scopeAllows(granted, 'captions.insert')).toBe(false);
    expect(scopeAllows(granted, 'playlistItems.insert')).toBe(false);
  });

  it('lets youtube.force-ssl do everything', () => {
    for (const operation of [
      'videos.insert',
      'thumbnails.set',
      'captions.insert',
      'playlistItems.insert',
    ] as const) {
      expect(scopeAllows([SCOPES.forceSsl], operation)).toBe(true);
    }
  });

  it('does not let the plain youtube scope add captions', () => {
    expect(scopeAllows([SCOPES.manage], 'captions.insert')).toBe(false);
    expect(scopeAllows([SCOPES.manage], 'playlistItems.insert')).toBe(true);
  });

  it('gives unknown scopes the benefit of the doubt', () => {
    expect(scopeAllows(null, 'captions.insert')).toBe(true);
  });
});

describe('scope helpers', () => {
  it('splits a scope string and treats an empty one as unknown', () => {
    expect(parseScopes(`${SCOPES.upload}  ${SCOPES.forceSsl}`)).toEqual([SCOPES.upload, SCOPES.forceSsl]);
    expect(parseScopes('')).toBeNull();
    expect(parseScopes(null)).toBeNull();
  });

  it('shortens a scope for messages', () => {
    expect(shortScope(SCOPES.upload)).toBe('youtube.upload');
    expect(shortScope('openid')).toBe('openid');
  });

  it('checks that every required scope was granted', () => {
    expect(hasScopes([SCOPES.upload, 'openid'], [SCOPES.upload])).toBe(true);
    expect(hasScopes(['openid'], [SCOPES.upload])).toBe(false);
  });

  it('explains the two scopes in plain words', () => {
    expect(describeScope(SCOPES.upload)).toContain('Manage your YouTube videos');
    expect(describeScope(SCOPES.forceSsl)).toContain('never deletes');
  });
});

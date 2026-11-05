import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import {
  buildDescriptionSection,
  buildPrComment,
  buildWatchPage,
  COMMENT_MARKER,
  createPublisher,
  DESCRIPTION_END,
  DESCRIPTION_START,
  LocalPublisher,
  S3Publisher,
} from './index.ts';

function configFor(provider: string) {
  return resolveConfig({ skipFile: true, env: {}, overrides: { publish: { provider: provider as 'none' } } });
}

describe('createPublisher', () => {
  it('returns nothing for provider "none"', () => {
    expect(createPublisher(configFor('none'))).toBeNull();
  });

  it('creates the local publisher by default', () => {
    const config = resolveConfig({ skipFile: true, env: {} });
    const publisher = createPublisher(config);
    expect(publisher).toBeInstanceOf(LocalPublisher);
    expect(publisher?.id).toBe('local');
  });

  it('creates the S3 publisher', () => {
    const publisher = createPublisher(configFor('s3'));
    expect(publisher).toBeInstanceOf(S3Publisher);
    expect(publisher?.id).toBe('s3');
  });

  it('refuses an unknown provider', () => {
    const config = configFor('local');
    (config.publish as { provider: string }).provider = 'ftp';
    expect(() => createPublisher(config)).toThrow(MergeStoryError);
  });
});

describe('exports', () => {
  it('keeps the markers that other modules look for', () => {
    expect(COMMENT_MARKER).toBe('<!-- mergestory:comment -->');
    expect(DESCRIPTION_START).toBe('<!-- mergestory:start -->');
    expect(DESCRIPTION_END).toBe('<!-- mergestory:end -->');
  });

  it('exposes the builders', () => {
    for (const fn of [buildWatchPage, buildPrComment, buildDescriptionSection]) {
      expect(typeof fn).toBe('function');
    }
  });
});

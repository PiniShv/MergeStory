import { describe, expect, it } from 'vitest';
import {
  LLM_PROVIDERS,
  PUBLISH_PROVIDERS,
  QUALITIES,
  STYLES,
  TTS_PROVIDERS,
  VISIBILITIES,
} from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { toApiError } from './http.ts';
import { parseCreateJob } from './schema.ts';

const PR = 'https://github.com/acme/app/pull/1';

describe('parseCreateJob', () => {
  it('accepts every value that the engine accepts, except the ones that are left out on purpose', () => {
    const accepted = (options: unknown) => parseCreateJob({ source: PR, options }).ok;
    for (const style of STYLES) expect(accepted({ style }), style).toBe(true);
    for (const quality of QUALITIES) expect(accepted({ quality }), quality).toBe(true);
    for (const theme of ['midnight', 'paper', 'high-contrast', 'terminal', 'dark', 'light', 'my-brand']) {
      expect(accepted({ theme }), theme).toBe(true);
    }
    // A caller of the API names a theme; it never points at a folder on the server.
    for (const theme of ['/etc/themes/x', '../x', './x', 'C:\\themes\\x', '']) {
      expect(accepted({ theme }), theme).toBe(false);
    }
    for (const provider of LLM_PROVIDERS) expect(accepted({ llm: { provider } }), provider).toBe(true);
    for (const provider of TTS_PROVIDERS) expect(accepted({ tts: { provider } }), provider).toBe(true);
    for (const provider of PUBLISH_PROVIDERS.filter((p) => p !== 'youtube' && p !== 'drive')) {
      expect(accepted({ publish: { provider } }), provider).toBe(true);
    }
    for (const visibility of VISIBILITIES.filter((v) => v !== 'protected')) {
      expect(accepted({ publish: { visibility } }), visibility).toBe(true);
    }
    expect(accepted({ publish: { provider: 'youtube' } })).toBe(false);
    expect(accepted({ publish: { provider: 'drive' } })).toBe(false);
    expect(accepted({ publish: { visibility: 'protected' } })).toBe(false);
  });

  it('returns the job options, with the source still as written', () => {
    const parsed = parseCreateJob({
      source: PR,
      context: { task: 'Add retries', tests: [{ command: 'npm test', passed: true, summary: 'ok' }] },
      options: { quality: 'draft' },
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        source: PR,
        context: {
          task: 'Add retries',
          tests: [{ command: 'npm test', passed: true, summary: 'ok', source: 'agent' }],
        },
        config: { quality: 'draft' },
      },
    });
  });

  it('refuses a test result whose "passed" is not a boolean, and a value outside the engine ranges', () => {
    const tests = [{ command: 'npm test', passed: 'false', summary: '3 failed' }];
    expect(parseCreateJob({ source: PR, context: { tests } }).ok).toBe(false);
    const range = parseCreateJob({ source: PR, options: { maxDurationSec: 5 } });
    expect(range.ok).toBe(false);
    if (!range.ok) expect(range.issues[0]?.path).toBe('options.maxDurationSec');
  });
});

describe('toApiError', () => {
  it("maps the engine errors that are the caller's doing", () => {
    const usage = toApiError(new MergeStoryError('USAGE', 'Bad input.', { hint: 'Fix it.' }));
    expect(usage).toMatchObject({ status: 400, code: 'USAGE', message: 'Bad input.', hint: 'Fix it.' });
    expect(toApiError(new MergeStoryError('SOURCE_INVALID', 'No.'))).toMatchObject({
      status: 400,
      code: 'SOURCE_INVALID',
    });
    expect(toApiError(new MergeStoryError('USAGE', 'No.'), 'SOURCE_INVALID')).toMatchObject({
      status: 400,
      code: 'SOURCE_INVALID',
    });
    expect(toApiError(new MergeStoryError('JOB_NOT_FOUND', 'secret path /x'))).toMatchObject({
      status: 404,
      code: 'JOB_NOT_FOUND',
      message: 'No such job.',
    });
  });

  it('leaves every other error to be an internal error', () => {
    expect(toApiError(new MergeStoryError('PUBLISH_FAILED', 'x'))).toBeNull();
    expect(toApiError(new Error('x'))).toBeNull();
  });
});

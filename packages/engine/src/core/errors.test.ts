import { describe, expect, it } from 'vitest';
import {
  abortedError,
  assertNotAborted,
  CommandNotFoundError,
  describeProblem,
  MergeStoryError,
  OutputTooLargeError,
  TimedOutError,
  toMergeStoryError,
} from './errors.ts';

describe('abortedError', () => {
  it('is the ABORTED error with the standard message, and keeps what stopped the run', () => {
    const plain = abortedError();
    expect(plain).toBeInstanceOf(MergeStoryError);
    expect(plain).toMatchObject({ code: 'ABORTED', message: 'The run was cancelled.', exitCode: 130 });
    expect('cause' in plain).toBe(false);

    const reason = new DOMException('stop', 'AbortError');
    expect(abortedError(reason).cause).toBe(reason);
  });
});

describe('assertNotAborted', () => {
  it('does nothing while the run goes on and throws ABORTED once it is cancelled', () => {
    const controller = new AbortController();
    expect(() => assertNotAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => assertNotAborted(controller.signal)).toThrow(MergeStoryError);
    try {
      assertNotAborted(controller.signal);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ABORTED', message: 'The run was cancelled.' });
    }
  });
});

describe('describeProblem', () => {
  it('puts the hint after the message, and is the message alone without one', () => {
    expect(describeProblem(new MergeStoryError('CONFIG_INVALID', 'No bucket.', { hint: 'Set one.' }))).toBe(
      'No bucket. Set one.',
    );
    expect(describeProblem(new MergeStoryError('CONFIG_INVALID', 'No bucket.'))).toBe('No bucket.');
  });
});

describe('toMergeStoryError', () => {
  it('turns an AbortError into ABORTED and keeps it as the cause', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const error = toMergeStoryError(abort);
    expect(error).toMatchObject({ code: 'ABORTED', message: 'The run was cancelled.' });
    expect(error.cause).toBe(abort);
  });

  it('keeps a MergeStoryError and wraps anything else with the fallback code', () => {
    const own = new MergeStoryError('USAGE', 'x');
    expect(toMergeStoryError(own)).toBe(own);
    expect(toMergeStoryError(new Error('boom'), 'LLM_FAILED')).toMatchObject({
      code: 'LLM_FAILED',
      message: 'boom',
    });
    expect(toMergeStoryError('text')).toMatchObject({ code: 'INTERNAL', message: 'text' });
  });
});

describe('typed process and network errors', () => {
  it('are INTERNAL errors that callers can tell apart without reading the message', () => {
    const timeout = new TimedOutError('git timed out after 5 ms', { retryable: true });
    const missing = new CommandNotFoundError('ffmpeg');
    const large = new OutputTooLargeError('git', 1000);
    for (const error of [timeout, missing, large]) {
      expect(error).toBeInstanceOf(MergeStoryError);
      expect(error.code).toBe('INTERNAL');
    }
    expect(timeout.retryable).toBe(true);
    expect(missing.message).toBe('Command not found: ffmpeg');
    expect(large.message).toBe('git produced more than 1000 bytes of output');
    expect([timeout.name, missing.name, large.name]).toEqual([
      'TimedOutError',
      'CommandNotFoundError',
      'OutputTooLargeError',
    ]);
    expect(missing).not.toBeInstanceOf(TimedOutError);
    expect(large).not.toBeInstanceOf(CommandNotFoundError);
  });
});

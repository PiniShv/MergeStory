import { describe, expect, it } from 'vitest';
import { lineRangeText, MAX_LOG_RANGE_LINES, resolveLogId } from './log-id.ts';

const counts = new Map([
  ['L1', 412],
  ['L2', 3],
]);

describe('resolveLogId', () => {
  it('reads a whole log, a range and one line', () => {
    expect(resolveLogId('L1', counts)).toEqual({
      log: 'L1',
      start: 1,
      end: 412,
    });
    expect(resolveLogId('L1.120-140', counts)).toEqual({
      log: 'L1',
      start: 120,
      end: 140,
    });
    expect(resolveLogId('L2.3', counts)).toEqual({
      log: 'L2',
      start: 3,
      end: 3,
    });
  });

  it('accepts a range only inside the log, in order, and of at most 200 lines', () => {
    expect(resolveLogId('L1.1-412', counts)).toBeNull();
    expect(resolveLogId('L1.200-399', counts)).not.toBeNull();
    expect(resolveLogId('L1.200-400', counts)).toBeNull();
    expect(MAX_LOG_RANGE_LINES).toBe(200);
    expect(resolveLogId('L1.5-4', counts)).toBeNull();
    expect(resolveLogId('L1.413', counts)).toBeNull();
    expect(resolveLogId('L2.2-4', counts)).toBeNull();
    expect(resolveLogId('L1.412', counts)).not.toBeNull();
  });

  it('refuses a log that was not supplied and anything that is not a whole number', () => {
    for (const id of [
      'L3',
      'L3.1',
      'L1.0',
      'L1.01',
      'L1.1.5',
      'L1.1-',
      'L1.-5',
      'L1.a-b',
      'L1.1-2-3',
      'l1',
      'L0',
      'L01',
      'L1 ',
      ' L1',
      'L1.1e2',
      '',
    ]) {
      expect(resolveLogId(id, counts), id).toBeNull();
    }
  });
});

describe('lineRangeText', () => {
  it('says "line" for one line and "lines 120 to 140" for a range', () => {
    expect(lineRangeText(7, 7)).toBe('line 7');
    expect(lineRangeText(120, 140)).toBe('lines 120 to 140');
  });
});

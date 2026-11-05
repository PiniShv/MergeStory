import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';

function capture(
  format: 'pretty' | 'json',
  color = false,
): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', format, color, write: (line) => lines.push(line) });
  return { lines, log };
}

// A commit subject that tries to set the clipboard, move the cursor, and reverse the text after it.
const hostile = 'Add retry \u001b]52;c;aGVsbG8=\u0007logic\u001b[2A\r\u202eevil\u009b';

describe('pretty logs', () => {
  it('print untrusted messages and fields without their control characters', () => {
    const { lines, log } = capture('pretty');
    log.warn(hostile, { subject: hostile, count: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('warn: Add retry ]52;c;aGVsbG8=logic[2Aevil');
    expect(lines[0]).not.toMatch(/(?![\t\n])\p{Cc}|\u202e/u);
  });

  it('keep their own colors', () => {
    const { lines, log } = capture('pretty', true);
    log.error(hostile);
    expect(lines[0]?.startsWith('\u001b[31merror: Add retry ]52')).toBe(true);
    expect(lines[0]?.endsWith('\u001b[0m')).toBe(true);
    expect(lines[0]).not.toContain('\u001b]');
  });

  it('leave JSON logs to JSON escaping', () => {
    const { lines, log } = capture('json');
    log.info(hostile);
    expect(JSON.parse(lines[0] ?? '{}').msg).toBe(hostile);
  });
});

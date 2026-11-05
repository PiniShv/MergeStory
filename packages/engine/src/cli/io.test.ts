import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIo, safeOutput } from './io.ts';
import { createStyle } from './style.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeOutput', () => {
  it('keeps the colors of the CLI and drops every other control character', () => {
    const style = createStyle(true);
    const text = `${style.green('Analysis ready')}: Add retry \u001b]52;c;aGVsbG8=\u0007logic\u001b[2J\r\u009b\n\tdone`;
    expect(safeOutput(text)).toBe(
      '\u001b[32mAnalysis ready\u001b[39m: Add retry ]52;c;aGVsbG8=logic[2J\n\tdone',
    );
  });
});

describe('createIo', () => {
  it('writes to the terminal through safeOutput', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const io = createIo();
    io.stdout('title \u001b]0;fake\u0007\n');
    io.stderr('error \u001b[1A\u001b[31mred\u001b[39m\n');
    expect(stdout).toHaveBeenCalledWith('title ]0;fake\n');
    expect(stderr).toHaveBeenCalledWith('error [1A\u001b[31mred\u001b[39m\n');
  });
});

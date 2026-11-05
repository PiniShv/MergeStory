import { describe, expect, it } from 'vitest';
import type { TerminalLine } from './terminal.ts';
import { compressSchedule, outputMarker, planTerminal, scheduleTerminal, typedChars } from './terminal.ts';

const lines: TerminalLine[] = [
  { kind: 'command', text: 'npm test -- retry', beat: 0 },
  { kind: 'output', text: 'a', beat: 0 },
  { kind: 'output', text: 'b', beat: 0 },
  { kind: 'comment', text: 'note', beat: 1 },
  { kind: 'command', text: 'ls', beat: 1 },
];

/** The lines with the times their beats start, as the runtime context provides them. */
const timed = <T extends { beat: number }>(list: readonly T[], beatTime: (beat: number) => number) =>
  list.map((line) => ({ ...line, start: beatTime(line.beat) }));

describe('scheduleTerminal', () => {
  const beatTime = (beat: number) => beat * 2;

  it('types a command, then shows its output line by line', () => {
    const t = scheduleTerminal(timed(lines, beatTime));
    expect(t[0]?.start).toBe(0);
    expect(t[0]?.typeSec).toBeCloseTo(17 / 30, 5);
    expect(t[1]?.start).toBeGreaterThan(t[0]?.end ?? 99);
    expect(t[2]?.start).toBeGreaterThan(t[1]?.start ?? 99);
  });

  it('never starts a line before the previous one and honours later beats', () => {
    const t = scheduleTerminal(timed(lines, beatTime), { minStart: 0.5 });
    expect(t[0]?.start).toBe(0.5);
    for (let i = 1; i < t.length; i++) expect(t[i]?.start).toBeGreaterThanOrEqual(t[i - 1]?.start ?? 0);
    expect(t[3]?.start).toBeGreaterThanOrEqual(2);
  });

  it('speeds up very long commands', () => {
    const [t] = scheduleTerminal(
      timed([{ kind: 'command' as const, text: 'x'.repeat(240), beat: 0 }], beatTime),
    );
    expect(t?.typeSec).toBeLessThanOrEqual(2.4 + 1e-9);
  });
});

describe('typedChars', () => {
  const [command, output] = scheduleTerminal(timed(lines, (b) => b * 2));

  it('reveals a command at a steady rate and then holds the full text', () => {
    expect(typedChars(command!, 17, -1)).toBe(0);
    expect(typedChars(command!, 17, 0)).toBe(0);
    expect(typedChars(command!, 17, 0.2)).toBe(6);
    expect(typedChars(command!, 17, 5)).toBe(17);
  });

  it('shows other lines whole once they have started', () => {
    expect(typedChars(output!, 5, (output?.start ?? 0) - 0.01)).toBe(0);
    expect(typedChars(output!, 5, (output?.start ?? 0) + 0.01)).toBe(5);
  });
});

describe('compressSchedule', () => {
  it('leaves a schedule that already fits alone', () => {
    const t = scheduleTerminal(timed(lines, (b) => b * 2));
    expect(compressSchedule(t, 100)).toEqual(t);
  });

  it('squeezes a long schedule under the deadline and keeps the order', () => {
    const t = scheduleTerminal(timed(lines, (b) => b * 4));
    const last = t.reduce((m, x) => Math.max(m, x.end), 0);
    const squeezed = compressSchedule(t, last / 2);
    expect(Math.max(...squeezed.map((x) => x.end))).toBeLessThanOrEqual(last / 2 + 1e-9);
    for (let i = 1; i < squeezed.length; i++)
      expect(squeezed[i]?.start).toBeGreaterThanOrEqual(squeezed[i - 1]?.start ?? 0);
    expect(squeezed[0]?.rate).toBeGreaterThan(t[0]?.rate ?? 0);
  });
});

describe('outputMarker', () => {
  it('finds pass, fail and warning markers and keeps the indent', () => {
    expect(outputMarker(' ✓ works (3 ms)')).toEqual({
      lead: ' ',
      marker: '✓',
      tone: 'ok',
      rest: ' works (3 ms)',
    });
    expect(outputMarker('FAIL src/a.test.ts')?.tone).toBe('fail');
    expect(outputMarker('  WARN  deprecated')?.tone).toBe('warn');
    expect(outputMarker('Error: boom')?.tone).toBe('fail');
  });

  it('ignores ordinary lines', () => {
    expect(outputMarker('compiled 12 modules')).toBeNull();
    expect(outputMarker('PASSING is not a marker')).toBeNull();
  });
});

describe('planTerminal', () => {
  it('fits the window inside the limit and grows with the content', () => {
    const few = planTerminal({ lineCount: 4, maxHeight: 720 });
    const many = planTerminal({ lineCount: 14, maxHeight: 720 });
    expect(few.height).toBeLessThanOrEqual(720);
    expect(many.height).toBeGreaterThan(few.height);
    expect(many.fontSize).toBeGreaterThanOrEqual(22);
  });

  it('reports how many rows fit when there are too many', () => {
    const plan = planTerminal({ lineCount: 80, maxHeight: 720 });
    expect(plan.height).toBeLessThanOrEqual(720);
    expect(plan.capacity).toBeLessThan(80);
    expect(plan.capacity * plan.lineHeight).toBeLessThanOrEqual(720);
  });
});

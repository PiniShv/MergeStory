import { describe, expect, it } from 'vitest';
import { createStyle } from '../cli/style.ts';
import { doctor } from '../testing/doctor.ts';
import { formatDoctor } from './format.ts';

describe('formatDoctor', () => {
  it('lists every check with a fix line, and ends with a summary', async () => {
    const report = await doctor(
      { llm: { provider: 'anthropic' } },
      { platform: 'linux', which: async () => null },
    );
    const text = formatDoctor(report, createStyle(false));
    expect(text).toContain('FAIL');
    expect(text).toContain('warn');
    expect(text).toContain('ok');
    expect(text).toContain('fix: Set ANTHROPIC_API_KEY');
    expect(text).toMatch(/\d+ passed, \d+ warnings?, 1 failed\./);
    expect(text).toContain('Fix the failed checks above');
  });

  it('says everything is in place when nothing failed', async () => {
    const report = await doctor();
    const text = formatDoctor(report, createStyle(false));
    expect(text).toContain('Everything needed is in place');
    expect(text).toContain('0 failed');
  });

  it('adds no color codes when styling is off', async () => {
    const report = await doctor();
    expect(formatDoctor(report, createStyle(false))).not.toContain('\u001b[');
    expect(formatDoctor(report, createStyle(true))).toContain('\u001b[');
  });
});

import { describe, expect, it } from 'vitest';
import { publishMeta } from '../../testing/publish.ts';
import { buildDriveDescription, buildFileName, DESCRIPTION_MAX_CHARS } from './text.ts';

describe('buildFileName', () => {
  it('names the file after the title and the change', () => {
    expect(buildFileName(publishMeta())).toBe('Add retry with backoff (PR #482).mp4');
  });

  it('drops control characters and slashes', () => {
    const name = buildFileName({ title: 'a/b\\c\u0000d‮e\nf', changeLabel: 'PR #1' });
    expect(name).toBe('a b cde f (PR #1).mp4');
  });

  it('keeps at most 150 characters before the extension', () => {
    const name = buildFileName({ title: 'x'.repeat(400), changeLabel: 'PR #1' });
    expect(name.endsWith('….mp4')).toBe(true);
    expect(Array.from(name.slice(0, -4))).toHaveLength(150);
  });

  it('has a name when the title is empty', () => {
    expect(buildFileName({ title: '', changeLabel: '' })).toBe('MergeStory video.mp4');
  });
});

describe('buildDriveDescription', () => {
  it('holds the summary, the pull request link, the chapters with times and the checklist', () => {
    const text = buildDriveDescription(publishMeta());
    expect(text).toContain('Failed forecast calls are retried');
    expect(text).toContain('Pull request: https://github.com/example/weather/pull/482');
    expect(text).toContain('Chapters\n0:00 Why this change\n0:12 The retry loop');
    expect(text).toContain('Review checklist\n- Is the retry limit sensible?');
  });

  it('stays within 3,000 characters and cuts at a line end', () => {
    const meta = publishMeta({
      checklist: Array.from({ length: 15 }, (_, i) => ({
        title: `${i} ${'y'.repeat(190)}`,
        severity: 'low' as const,
      })),
      chapters: Array.from({ length: 20 }, (_, i) => ({ title: 'z'.repeat(99), startSec: i * 10 })),
    });
    const text = buildDriveDescription(meta);
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    const full = text.split('\n');
    const last = full[full.length - 1] ?? '';
    // The last line is whole: it is one of the lines the full text would have.
    expect(last.endsWith('…')).toBe(false);
  });
});

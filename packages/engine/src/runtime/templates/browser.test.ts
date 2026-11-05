import { describe, expect, it } from 'vitest';
import { displayUrl, parseTable, scrollOffsetAt, scrollTimeline } from './browser.ts';

describe('displayUrl', () => {
  it('shows a path as app/<path>', () => {
    expect(displayUrl('/settings/cities')).toBe('app/settings/cities');
    expect(displayUrl('settings/cities/')).toBe('app/settings/cities');
    expect(displayUrl('/')).toBe('app');
    expect(displayUrl('')).toBe('app');
  });

  it('never shows a host, query or fragment', () => {
    expect(displayUrl('https://admin.example.com/settings?token=abc#top')).toBe('app/settings');
    expect(displayUrl('http://localhost:3000/a/b')).toBe('app/a/b');
    expect(displayUrl('example.com/forecast')).toBe('app/forecast');
    expect(displayUrl('https://example.com')).toBe('app');
  });

  it('shortens very long paths', () => {
    const out = displayUrl(`/${'segment/'.repeat(20)}end`);
    expect(Array.from(out).length).toBeLessThanOrEqual(56);
    expect(out.startsWith('app/')).toBe(true);
    expect(out.endsWith('end')).toBe(true);
  });
});

describe('parseTable', () => {
  it('splits rows on pipes and treats the first row as the header', () => {
    const t = parseTable('', ['Date | Temperature', 'Oct 1 | 18', 'Sep 1']);
    expect(t.header).toEqual(['Date', 'Temperature']);
    expect(t.rows).toEqual([
      ['Oct 1', '18'],
      ['Sep 1', ''],
    ]);
  });

  it('falls back to one column with the text as its header', () => {
    expect(parseTable('Cities', ['a', 'b'])).toEqual({ header: ['Cities'], rows: [['a'], ['b']] });
    expect(parseTable('', ['a']).header).toBeNull();
  });
});

describe('page scrolling', () => {
  const blocks = [
    { start: 1, bottom: 200 },
    { start: 3, bottom: 600 },
    { start: 2, bottom: 420 },
    { start: 5, bottom: 900 },
  ];

  it('scrolls each block into view, in the order the blocks appear', () => {
    const timeline = scrollTimeline(blocks, 580, 28);
    expect(timeline.map((s) => s.start)).toEqual([1, 2, 3, 5]);
    expect(timeline.map((s) => s.need)).toEqual([0, 0, 48, 348]);
  });

  it('never scrolls back up', () => {
    const timeline = scrollTimeline(
      [
        { start: 1, bottom: 900 },
        { start: 2, bottom: 300 },
      ],
      580,
      28,
    );
    expect(timeline[1]?.need).toBe(timeline[0]?.need);
  });

  it('eases to the newest target and then rests', () => {
    const timeline = scrollTimeline(blocks, 580, 28);
    expect(scrollOffsetAt(timeline, 0)).toBe(0);
    expect(scrollOffsetAt(timeline, 3)).toBe(0);
    const mid = scrollOffsetAt(timeline, 3.35);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(48);
    expect(scrollOffsetAt(timeline, 4.5)).toBe(48);
    expect(scrollOffsetAt(timeline, 9)).toBe(348);
    expect(scrollOffsetAt([], 4)).toBe(0);
  });
});

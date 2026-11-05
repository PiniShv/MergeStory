import { describe, expect, it } from 'vitest';
import { DIAGRAM_AREA, EDGE_WRAP, fitScale, fontsForScale } from './diagram-metrics.ts';

describe('fontsForScale', () => {
  it('keeps the design sizes at full size and when the diagram grows', () => {
    expect(fontsForScale(1)).toEqual({ label: 30, detail: 22, edge: 22 });
    expect(fontsForScale(1.3)).toEqual({ label: 30, detail: 22, edge: 22 });
  });

  it('raises layout fonts when the diagram shrinks, so text keeps its size on screen', () => {
    for (const scale of [0.9, 0.8, 0.65, 0.6]) {
      const fonts = fontsForScale(scale);
      expect(fonts.label * scale).toBeGreaterThanOrEqual(26 - 1e-9);
      expect(fonts.detail * scale).toBeGreaterThanOrEqual(22 - 1e-9);
      expect(fonts.edge * scale).toBeGreaterThanOrEqual(22 - 1e-9);
    }
  });
});

describe('fontsForScale on a crowded diagram', () => {
  it('stops growing the fonts below a zoom of 0.6', () => {
    expect(fontsForScale(0.3)).toEqual(fontsForScale(0.6));
  });
});

describe('edge label width', () => {
  it('wraps sooner for a left to right diagram than for a top to bottom one', () => {
    expect(EDGE_WRAP.LR).toBeLessThan(EDGE_WRAP.TB);
  });
});

describe('fitScale', () => {
  it('fits a layout into the area minus the margin and never zooms in past the largest zoom', () => {
    const { w, h, margin } = DIAGRAM_AREA;
    expect(fitScale(2 * (w - 2 * margin), 10)).toBeCloseTo(0.5, 9);
    expect(fitScale(10, 4 * (h - 2 * margin))).toBeCloseTo(0.25, 9);
    expect(fitScale(300, 200)).toBe(DIAGRAM_AREA.maxScale);
  });

  it('treats an empty layout as one pixel', () => {
    expect(fitScale(0, 0)).toBe(DIAGRAM_AREA.maxScale);
  });

  it('takes another area', () => {
    expect(fitScale(1000, 1000, { w: 520, h: 520, margin: 10, maxScale: 2 })).toBeCloseTo(0.5, 9);
  });
});

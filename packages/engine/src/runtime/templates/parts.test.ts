import { describe, expect, it } from 'vitest';
import { fitImage, isDataImage } from './parts.ts';

describe('fitImage', () => {
  it('fits without distortion', () => {
    const fit = fitImage(960, 600, 1680, 400);
    expect(fit.height).toBe(400);
    expect(fit.width).toBe(640);
  });

  it('enlarges small images only a little', () => {
    const fit = fitImage(100, 100, 1680, 720);
    expect(fit.scale).toBe(1.6);
    expect(fit.width).toBe(160);
  });

  it('survives missing dimensions', () => {
    const fit = fitImage(0, Number.NaN, 1680, 720);
    expect(fit.width).toBeGreaterThan(0);
    expect(fit.height).toBeGreaterThan(0);
    expect(fit.width).toBeLessThanOrEqual(1680);
    expect(fit.height).toBeLessThanOrEqual(720);
  });
});

describe('isDataImage', () => {
  it('accepts embedded images only', () => {
    expect(isDataImage('data:image/png;base64,AAAA')).toBe(true);
    expect(isDataImage('data:image/jpeg;base64,AAAA')).toBe(true);
    expect(isDataImage('https://example.com/a.png')).toBe(false);
    expect(isDataImage('data:text/html;base64,AAAA')).toBe(false);
    expect(isDataImage('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isDataImage('file:///etc/passwd')).toBe(false);
  });
});

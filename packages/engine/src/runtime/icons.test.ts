import { describe, expect, it } from 'vitest';
import { NodeKindSchema } from '../core/storyboard-schema.ts';
import { ICONS } from './icons.ts';

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/;

describe('icons', () => {
  it('has an icon for every node kind', () => {
    for (const kind of NodeKindSchema.options) {
      expect(Object.keys(ICONS), kind).toContain(kind);
      expect(ICONS[kind].paths.length, kind).toBeGreaterThan(0);
    }
  });

  it('stores well-formed path data', () => {
    for (const [name, def] of Object.entries(ICONS)) {
      for (const d of def.paths) {
        expect(d, `${name}: ${d}`).toMatch(PATH_DATA);
        expect(d.startsWith('M'), `${name}: ${d}`).toBe(true);
        const numbers = d.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? [];
        expect(
          numbers.every((n) => Number.isFinite(Number(n))),
          `${name}: ${d}`,
        ).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { StyleWriter } from './anim.ts';
import { grow, pop, rise, shift } from './motion.ts';

/** A stand-in for an element: records the styles written to it. */
function fakeElement() {
  const styles = new Map<string, string>();
  const el = {
    style: { setProperty: (name: string, value: string) => void styles.set(name, value) },
  } as unknown as HTMLElement;
  return { el, styles };
}

describe('rise', () => {
  it('moves and fades while entering', () => {
    const sw = new StyleWriter();
    const { el, styles } = fakeElement();
    rise(sw, el, 0.5, 20);
    expect(styles.get('opacity')).toBe('0.5');
    expect(styles.get('transform')).toBe('translate3d(0, 10px, 0)');
  });

  it('leaves no transform once settled', () => {
    const sw = new StyleWriter();
    const { el, styles } = fakeElement();
    rise(sw, el, 1, 20);
    expect(styles.get('opacity')).toBe('1');
    expect(styles.get('transform')).toBe('none');
  });

  it('caps the final opacity for dimmed items', () => {
    const sw = new StyleWriter();
    const { el, styles } = fakeElement();
    rise(sw, el, 1, 20, 0.5);
    expect(styles.get('opacity')).toBe('0.5');
  });

  it('reports a change only when something moved', () => {
    const sw = new StyleWriter();
    const { el } = fakeElement();
    rise(sw, el, 1, 20);
    expect(sw.consumeDirty()).toBe(true);
    rise(sw, el, 1, 20);
    expect(sw.consumeDirty()).toBe(false);
    rise(sw, el, 0.9, 20);
    expect(sw.consumeDirty()).toBe(true);
  });
});

describe('pop, grow and shift', () => {
  it('settle to "none"', () => {
    const sw = new StyleWriter();
    const a = fakeElement();
    const b = fakeElement();
    const c = fakeElement();
    pop(sw, a.el, 1);
    grow(sw, b.el, 'x', 1);
    shift(sw, c.el, 0);
    expect(a.styles.get('transform')).toBe('none');
    expect(b.styles.get('transform')).toBe('none');
    expect(c.styles.get('transform')).toBe('none');
  });

  it('scale along the requested axis', () => {
    const sw = new StyleWriter();
    const a = fakeElement();
    const b = fakeElement();
    grow(sw, a.el, 'x', 0.25);
    grow(sw, b.el, 'y', 0.5);
    expect(a.styles.get('transform')).toBe('scaleX(0.25)');
    expect(b.styles.get('transform')).toBe('scaleY(0.5)');
  });

  it('pop starts small and transparent', () => {
    const sw = new StyleWriter();
    const { el, styles } = fakeElement();
    pop(sw, el, 0, 0.8);
    expect(styles.get('opacity')).toBe('0');
    expect(styles.get('transform')).toBe('scale(0.8)');
  });

  it('shift offsets vertically', () => {
    const sw = new StyleWriter();
    const { el, styles } = fakeElement();
    shift(sw, el, -6);
    expect(styles.get('transform')).toBe('translate3d(0, -6px, 0)');
  });
});

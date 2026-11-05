import { describe, expect, it } from 'vitest';
import { ease, enter, lerp, progress, q, restTransform, StyleWriter } from './anim.ts';

/** A stand-in for an element: only the style writes matter here. */
function fakeElement() {
  const style = new Map<string, string>();
  const el = { style: { setProperty: (name: string, value: string) => style.set(name, value) } };
  return { el: el as unknown as HTMLElement, style };
}

describe('restTransform', () => {
  it('turns a transform that moves nothing into none', () => {
    for (const value of [
      'translate(0px, 0px)',
      'translate(0, 0)',
      'translate(0px, 0px) scale(1)',
      'translate3d(0px, 0px, 0)',
      'translate3d(0, 0, 0) scale(1)',
      'scale(1)',
      'translate(-0px, 0px)',
      'translate(0px, 0px) translate(0px, 0px)',
    ]) {
      expect(restTransform(value), value).toBe('none');
    }
  });

  it('keeps a transform that moves or scales something', () => {
    for (const value of [
      'translate(0px, 8px)',
      'translate(4px, 0px)',
      'scale(0.98)',
      'translate(0px, 0px) scale(1.04)',
      'translate(-50%, -50%) translate(0px, 6px)',
      'none',
    ]) {
      expect(restTransform(value), value).toBe(value);
    }
  });
});

describe('StyleWriter', () => {
  it('writes transforms at rest as none', () => {
    const sw = new StyleWriter();
    const { el, style } = fakeElement();
    sw.transform(el, 'translate(0px, 12px) scale(0.99)');
    expect(style.get('transform')).toBe('translate(0px, 12px) scale(0.99)');
    sw.transform(el, 'translate(0px, 0px) scale(1)');
    expect(style.get('transform')).toBe('none');
  });

  it('reports a change only when a value really changes', () => {
    const sw = new StyleWriter();
    const { el } = fakeElement();
    sw.opacity(el, 0.5);
    expect(sw.consumeDirty()).toBe(true);
    sw.opacity(el, 0.5);
    sw.transform(el, 'translate(0px, 0px)');
    expect(sw.consumeDirty()).toBe(true);
    sw.transform(el, 'scale(1)');
    expect(sw.consumeDirty()).toBe(false);
  });
});

describe('animation helpers', () => {
  it('eases between 0 and 1 and rounds float noise away', () => {
    expect(progress(5, 2, 2)).toBe(1);
    expect(progress(1, 2, 2)).toBe(0);
    expect(enter(2.5, 2, 1, ease.linear)).toBeCloseTo(0.5, 9);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(q(0.1 + 0.2, 3)).toBe(0.3);
  });
});

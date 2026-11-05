import { describe, expect, it } from 'vitest';
import { lifelineX, planFlow } from './flow.ts';

describe('planFlow', () => {
  it('uses roomy steps for a short diagram', () => {
    const plan = planFlow(3, 5);
    expect(plan.stepGap).toBe(112);
    expect(plan.labelFont).toBe(28);
    expect(plan.cardW).toBeLessThanOrEqual(340);
    expect(plan.totalH).toBeLessThanOrEqual(704);
  });

  it('packs eight steps and five actors into the content area', () => {
    const plan = planFlow(5, 8);
    expect(plan.stepGap).toBeGreaterThanOrEqual(72);
    expect(plan.labelFont).toBeGreaterThanOrEqual(24);
    expect(plan.totalH).toBeLessThanOrEqual(704);
    expect(plan.cardW).toBeGreaterThanOrEqual(200);
  });

  it('handles an empty diagram', () => {
    const plan = planFlow(0, 0);
    expect(plan.totalH).toBeGreaterThan(0);
    expect(Number.isFinite(plan.colW)).toBe(true);
  });
});

describe('lifelineX', () => {
  it('centres each lifeline in an equal column', () => {
    expect([0, 1, 2].map((i) => lifelineX(i, 3))).toEqual([280, 840, 1400]);
    expect(lifelineX(0, 1)).toBe(840);
  });
});

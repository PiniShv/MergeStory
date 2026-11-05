import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitScale, fontsForScale, NODE_CHROME } from '../../../src/core/diagram-metrics.ts';
import type { PlannedScene, RenderPlan } from '../../../src/core/render-plan.ts';
import { MIN_CODE_FONT, planCodeView } from '../../../src/runtime/code-view.ts';
import { planCodeScene } from '../../../src/runtime/templates/code.ts';
import { longestSegment, MAX_NODE_WIDTH } from '../../../src/visuals/layout.ts';

const raw = readFileSync(new URL('./stress-sample.json', import.meta.url), 'utf8');
const plan = JSON.parse(raw) as RenderPlan;

function scenesOf<T extends PlannedScene['visual']['type']>(type: T) {
  return plan.scenes
    .filter((s) => s.visual.type === type)
    .map((s) => ({ scene: s, visual: s.visual as Extract<PlannedScene['visual'], { type: T }> }));
}

describe('stress-sample.json: a plan with hard content for every template', () => {
  it('is a 1080p plan that covers every template except the screenshot', () => {
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
    const types = new Set(plan.scenes.map((s) => s.visual.type));
    for (const type of [
      'code',
      'architecture',
      'flow',
      'terminal',
      'browser',
      'before-after',
      'checklist',
      'bullets',
      'files',
      'mission',
      'summary',
      'title',
    ]) {
      expect(types.has(type as never), type).toBe(true);
    }
  });

  it('lays scenes out with the declared overlaps and ends with the outro', () => {
    for (let i = 1; i < plan.scenes.length; i++) {
      const prev = plan.scenes[i - 1] as PlannedScene;
      const scene = plan.scenes[i] as PlannedScene;
      expect(scene.startSec).toBeCloseTo(prev.startSec + prev.durationSec - scene.transitionIn.durationSec, 6);
    }
    const last = plan.scenes[plan.scenes.length - 1] as PlannedScene;
    expect(plan.outro.startSec).toBeCloseTo(last.startSec + last.durationSec, 6);
  });

  it('points every element at an existing beat', () => {
    for (const scene of plan.scenes) {
      const beats = scene.beats.length;
      const v = scene.visual;
      const beatsOf: number[] =
        v.type === 'code'
          ? v.focus.map((f) => f.beat)
          : v.type === 'architecture'
            ? [...v.nodes, ...v.edges].map((x) => x.beat)
            : v.type === 'flow'
              ? v.steps.map((x) => x.beat)
              : v.type === 'terminal'
                ? v.lines.map((x) => x.beat)
                : v.type === 'browser'
                  ? v.blocks.map((x) => x.beat)
                  : v.type === 'checklist'
                    ? v.items.map((x) => x.beat)
                    : v.type === 'bullets'
                      ? v.items.map((x) => x.beat)
                      : v.type === 'summary'
                        ? v.points.map((x) => x.beat)
                        : v.type === 'mission'
                          ? v.points.map((x) => x.beat)
                          : [];
      for (const beat of beatsOf) expect(beat, `${scene.id}`).toBeLessThan(beats);
    }
  });

  it('carries no local paths or machine details', () => {
    expect(raw).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:\\/);
    expect(plan.meta.repoLabel).toBe('example/weather');
  });
});

describe('stress-sample.json: code is shown in full', () => {
  it('wraps the long lines of the wide snippet instead of cutting them', () => {
    const { visual } = scenesOf('code').find((c) => c.scene.id === 'code-wrap') as ReturnType<
      typeof scenesOf<'code'>
    >[number];
    const scene = planCodeScene(visual.code, { hasNotes: true, hasCaption: false });
    expect(scene.mode).toBe('wide');
    const view = planCodeView(visual.code, {
      width: 'fit',
      minWidth: 760,
      maxWidth: scene.maxWidth,
      maxHeight: scene.maxHeight,
    });
    expect(view.fontSize).toBeGreaterThanOrEqual(MIN_CODE_FONT);
    expect(view.wrapped).toBeGreaterThanOrEqual(3);
    expect(view.hidden).toBe(0);
    // Every character of every line is on some row, and no row is longer than the window allows.
    visual.code.lines.forEach((line, i) => {
      const wrap = view.wraps[i]!;
      const shown = wrap.rows.map((r) => r.tokens.map((t) => t.t).join('')).join('');
      const original = line.tokens.map((t) => t.t).join('');
      expect(shown.replace(/\s+/g, ''), `line ${i + 1}`).toBe(original.replace(/\s+/g, ''));
      for (const [k, row] of wrap.rows.entries()) {
        expect(row.length + (k > 0 ? wrap.hang : 0)).toBeLessThanOrEqual(view.cols);
      }
    });
  });

  it('fits the wide diff without wrapping when the window may use the whole width', () => {
    const { visual } = scenesOf('code').find((c) => c.scene.id === 'code-diff') as ReturnType<
      typeof scenesOf<'code'>
    >[number];
    const scene = planCodeScene(visual.code, { hasNotes: true, hasCaption: true });
    const view = planCodeView(visual.code, {
      width: 'fit',
      minWidth: 760,
      maxWidth: scene.maxWidth,
      maxHeight: scene.maxHeight,
    });
    expect(view.fontSize).toBeGreaterThanOrEqual(MIN_CODE_FONT);
    expect(view.height).toBeLessThanOrEqual(scene.maxHeight);
    expect(view.width).toBeLessThanOrEqual(1680);
  });

  it('leaves a column for the notes when a short snippet has room for it', () => {
    const { visual } = scenesOf('code').find((c) => c.scene.id === 'code-side') as ReturnType<
      typeof scenesOf<'code'>
    >[number];
    expect(planCodeScene(visual.code, { hasNotes: true, hasCaption: true }).mode).toBe('side');
  });
});

describe('stress-sample.json: diagrams are legible', () => {
  it('sizes every card for its own text and every diagram for the stage', () => {
    for (const { scene, visual } of scenesOf('architecture')) {
      const scale = fitScale(visual.width, visual.height);
      const fonts = fontsForScale(scale);
      expect(scale, scene.id).toBeGreaterThan(0.4);
      for (const n of visual.nodes) {
        expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
        expect(n.y - n.h / 2).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w / 2).toBeLessThanOrEqual(visual.width);
        expect(n.y + n.h / 2).toBeLessThanOrEqual(visual.height);
        // No word of a label or detail is wider than the card.
        // (A word wider than the widest card is the last resort: the template then shrinks its type.)
        const room = n.w - NODE_CHROME;
        const widest = MAX_NODE_WIDTH - NODE_CHROME;
        expect(room, `${scene.id} ${n.id} label`).toBeGreaterThanOrEqual(
          Math.min(widest, longestSegment(n.label, { px: fonts.label * 0.97, weight: 700, spacingEm: -0.015 })),
        );
        if (n.detail) {
          expect(room, `${scene.id} ${n.id} detail`).toBeGreaterThanOrEqual(
            Math.min(widest, longestSegment(n.detail, { px: fonts.detail * 0.97, weight: 500 })),
          );
        }
      }
    }
  });

  it('draws the dense eight-node diagram at a size where its text can be read', () => {
    const { visual } = scenesOf('architecture').find((c) => c.scene.id === 'arch-dense') as ReturnType<
      typeof scenesOf<'architecture'>
    >[number];
    const scale = fitScale(visual.width, visual.height);
    expect(scale).toBeGreaterThan(0.85);
    const fonts = fontsForScale(scale);
    expect(fonts.label * scale).toBeGreaterThanOrEqual(26 - 1e-9);
    expect(fonts.detail * scale).toBeGreaterThanOrEqual(22 - 1e-9);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlannedScene, RenderPlan } from '../../../src/core/render-plan.ts';
import { focusIndexRange } from '../../../src/runtime/code-view.ts';

const raw = readFileSync(new URL('../../../assets/preview/templates-sample.json', import.meta.url), 'utf8');
const plan = JSON.parse(raw) as RenderPlan;

function visualOf<T extends PlannedScene['visual']['type']>(type: T) {
  const scene = plan.scenes.find((s) => s.visual.type === type);
  if (!scene) throw new Error(`no ${type} scene`);
  return { scene, visual: scene.visual as Extract<PlannedScene['visual'], { type: T }> };
}

describe('templates-sample.json', () => {
  it('is a 1080p plan with one scene per template', () => {
    expect(plan.version).toBe(1);
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
    expect(plan.scenes.map((s) => s.visual.type)).toEqual([
      'code',
      'architecture',
      'flow',
      'terminal',
      'browser',
      'before-after',
      'screenshot',
    ]);
  });

  it('lays scenes out with the declared overlaps and ends with the outro', () => {
    expect(plan.scenes[0]?.startSec).toBe(0);
    for (let i = 1; i < plan.scenes.length; i++) {
      const prev = plan.scenes[i - 1] as PlannedScene;
      const scene = plan.scenes[i] as PlannedScene;
      expect(scene.startSec).toBeCloseTo(prev.startSec + prev.durationSec - scene.transitionIn.durationSec, 6);
    }
    const last = plan.scenes[plan.scenes.length - 1] as PlannedScene;
    expect(plan.outro.startSec).toBeCloseTo(last.startSec + last.durationSec, 6);
    expect(plan.durationSec).toBeCloseTo(plan.outro.startSec + plan.outro.durationSec, 6);
  });

  it('has ordered, non-overlapping beats inside each scene', () => {
    for (const scene of plan.scenes) {
      scene.beats.forEach((beat, i) => {
        expect(beat.index).toBe(i);
        expect(beat.startSec).toBeGreaterThanOrEqual(scene.startSec);
        expect(beat.startSec + beat.durationSec).toBeLessThanOrEqual(scene.startSec + scene.durationSec);
        const next = scene.beats[i + 1];
        if (next) expect(next.startSec).toBeGreaterThanOrEqual(beat.startSec + beat.durationSec);
      });
    }
  });

  it('points every element at an existing beat', () => {
    const beatsOf = (s: PlannedScene) => s.beats.length;
    const { scene: codeScene, visual: code } = visualOf('code');
    for (const f of code.focus) expect(f.beat).toBeLessThan(beatsOf(codeScene));
    const { scene: archScene, visual: arch } = visualOf('architecture');
    for (const item of [...arch.nodes, ...arch.edges]) expect(item.beat).toBeLessThan(beatsOf(archScene));
    const { scene: flowScene, visual: flow } = visualOf('flow');
    for (const step of flow.steps) expect(step.beat).toBeLessThan(beatsOf(flowScene));
    const { scene: termScene, visual: term } = visualOf('terminal');
    for (const line of term.lines) expect(line.beat).toBeLessThan(beatsOf(termScene));
    const { scene: browserScene, visual: browser } = visualOf('browser');
    for (const block of browser.blocks) expect(block.beat).toBeLessThan(beatsOf(browserScene));
  });

  it('keeps code focus ranges on real rows and token text on one line each', () => {
    const { visual } = visualOf('code');
    expect(visual.mode).toBe('diff');
    expect(visual.code.lines.length).toBe(14);
    for (const f of visual.focus) expect(focusIndexRange(visual.code, f.startLine, f.endLine)).not.toBeNull();
    for (const line of visual.code.lines) {
      expect(line.tokens.map((t) => t.t).join('')).not.toMatch(/[\r\n]/);
      expect(line.tokens.length).toBeGreaterThan(0);
    }
    expect(visual.code.lines.some((l) => l.kind === 'add')).toBe(true);
    expect(visual.code.lines.some((l) => l.kind === 'del')).toBe(true);
  });

  it('has an architecture whose nodes sit inside the layout box and whose edges join real nodes', () => {
    const { visual } = visualOf('architecture');
    const ids = new Set(visual.nodes.map((n) => n.id));
    expect(visual.nodes.length).toBeGreaterThanOrEqual(5);
    for (const n of visual.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(visual.width);
      expect(n.y - n.h / 2).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h / 2).toBeLessThanOrEqual(visual.height);
    }
    for (const e of visual.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(e.points.length).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(visual.nodes.map((n) => n.status))).toEqual(new Set(['added', 'modified', 'removed', 'unchanged']));
    expect(new Set(visual.edges.map((e) => e.status))).toEqual(new Set(['added', 'removed', 'unchanged']));
  });

  it('has a flow with three actors, five steps and every step kind used', () => {
    const { visual } = visualOf('flow');
    const ids = new Set(visual.actors.map((a) => a.id));
    expect(visual.actors.length).toBe(3);
    expect(visual.steps.length).toBe(5);
    for (const s of visual.steps) expect(ids.has(s.from) && ids.has(s.to)).toBe(true);
    expect(new Set(visual.steps.map((s) => s.kind))).toEqual(new Set(['request', 'response', 'event', 'call']));
  });

  it('embeds a real PNG whose size matches what the plan says', () => {
    const { visual } = visualOf('screenshot');
    expect(visual.image.src.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = Buffer.from(visual.image.src.split(',')[1] as string, 'base64');
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.readUInt32BE(16)).toBe(visual.image.width);
    expect(bytes.readUInt32BE(20)).toBe(visual.image.height);
    expect(bytes.length).toBeLessThan(100_000);
  });

  it('carries no local paths or machine details', () => {
    expect(raw).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:\\/);
    expect(plan.meta.repoLabel).toBe('example/weather');
  });
});

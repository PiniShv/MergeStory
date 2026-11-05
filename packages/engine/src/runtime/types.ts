/** Contract between the runtime core and scene templates. */
import type { PlannedScene, RenderPlan, ResolvedVisual } from '../core/render-plan.ts';
import type { StyleWriter } from './anim.ts';

export interface SceneContext {
  plan: RenderPlan;
  scene: PlannedScene;
  /** Shared writer: every DOM change must go through it so unchanged frames can be reused. */
  sw: StyleWriter;
  /**
   * Give each item the time it appears, in seconds since the scene started: just before the audio of
   * its narration beat begins (out-of-range beats clamp), with items on the same beat `step` seconds
   * apart so they do not all arrive at once.
   */
  withStarts<T extends { beat: number }>(items: readonly T[], step?: number): Array<T & { start: number }>;
  /** Scene length in seconds. */
  duration: number;
}

export interface SceneInstance {
  /** Root element, sized to the content area (see .ms-content in styles). */
  root: HTMLElement;
  /**
   * Apply the visual state for local time `t` (seconds since the scene started; may be
   * negative during the incoming transition). Must be a pure function of `t`.
   */
  update(t: number): void;
  /**
   * Optional: measure text once after fonts are loaded. The runtime calls it with every scene laid
   * out but hidden, so templates can fit text deterministically before the first frame.
   */
  layout?(): void;
}

export type TemplateFactory<V extends ResolvedVisual = ResolvedVisual> = (
  visual: V,
  ctx: SceneContext,
) => SceneInstance;

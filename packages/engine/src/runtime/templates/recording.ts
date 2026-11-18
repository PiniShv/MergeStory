/** A screen recording: its frames, stacked in a window, one of them showing for each moment. */
import { frameIndexAt, nearestFrame } from '../../core/recording-frames.ts';
import type { FrameSet, RecordingResolved } from '../../core/render-plan.ts';
import { css, h } from '../dom.ts';
import type { SceneContext, TemplateFactory } from '../types.ts';
import { isDataImage } from './parts.ts';
import { framedScene, missingPicture, withMarks } from './screenshot.ts';

const RECORDING_CSS = `
.ms-rec { position: relative; width: 100%; height: 100%; }
.ms-rec__img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
`;

/**
 * The frames of a set that this page got, as stacked images. They all exist when the scene is built,
 * so they are decoded before the first frame; `update(t)` only changes which one is visible.
 */
export function createFramePlayer(
  set: FrameSet,
  ctx: SceneContext,
  alt: string,
): { el: HTMLElement; update(t: number): void } {
  css('recording', RECORDING_CSS);
  const { sw } = ctx;
  const sent = ctx.plan.media?.[set.dir] ?? {};
  const indexes = Object.keys(sent)
    .map(Number)
    .filter((i) => isDataImage(sent[i] ?? ''))
    .sort((a, b) => a - b);
  if (indexes.length === 0) return { el: missingPicture(), update: () => undefined };
  const images = indexes.map((i) => h('img', { class: 'ms-rec__img', attrs: { src: sent[i] ?? '', alt } }));
  return {
    el: h('div', { class: 'ms-rec' }, ...images),
    update(t) {
      // A frame that was not sent to this page is replaced by the closest one that was.
      const shown = nearestFrame(indexes, frameIndexAt(set, t));
      indexes.forEach((index, n) => {
        const img = images[n];
        if (img) sw.visible(img, index === shown);
      });
    },
  };
}

export const recordingTemplate: TemplateFactory<RecordingResolved> = (visual, ctx) => {
  const caption = (visual.caption ?? '').trim() || null;
  const player = createFramePlayer(visual.frames, ctx, caption ?? 'Screen recording');
  return framedScene(ctx, {
    width: visual.frames.width,
    height: visual.frames.height,
    caption,
    ...withMarks(ctx, visual, player.el, (t) => player.update(t)),
  });
};

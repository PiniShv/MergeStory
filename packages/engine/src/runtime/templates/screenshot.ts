/** A screenshot framed in a neutral window (or a phone frame for tall images), fitted without distortion. */

import {
  cameraMove,
  FULL_VIEW,
  focusView,
  type PictureRect,
  scaleOf,
  viewAt,
} from '../../core/picture-view.ts';
import { beatAt } from '../../core/recording-frames.ts';
import {
  CONTENT_H,
  CONTENT_W,
  type PlannedHighlight,
  type ScreenshotResolved,
} from '../../core/render-plan.ts';
import { clamp01, enter, lerp, q } from '../anim.ts';
import { css, h } from '../dom.ts';
import { createHighlights } from '../highlights.ts';
import { icon } from '../icons.ts';
import type { SceneContext, SceneInstance, TemplateFactory } from '../types.ts';
import {
  CAPTION_RESERVE,
  CAPTION_TEXT_CSS,
  captionBlock,
  fitImage,
  isDataImage,
  WINDOW_BAR_H,
  windowFrame,
} from './parts.ts';

const DEVICE_PAD = 14;

const SCREENSHOT_CSS = `
.ms-shot__wrap { position: absolute; transform-origin: 50% 40%; }
.ms-shot__img { display: block; width: 100%; height: 100%; }
.ms-shot__missing {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  width: 100%;
  height: 100%;
  font-size: 24px;
  color: var(--text-3);
}
.ms-shot__device {
  width: 100%;
  height: 100%;
  padding: ${DEVICE_PAD}px;
  border-radius: 46px;
  background: var(--surface-2);
  box-shadow: var(--shadow-card), inset 0 0 0 2px var(--border-2);
}
.ms-shot__screen { width: 100%; height: 100%; border-radius: 32px; overflow: hidden; background: var(--surface-code); }
.ms-shot__caption {
  position: absolute;
  text-align: center;${CAPTION_TEXT_CSS}
}
`;

export interface FramedPicture {
  width: number;
  height: number;
  caption: string | null;
  /** The picture itself: an `img`, or any element that fills its parent. */
  content: HTMLElement;
  /** Extra work for every frame, through the style writer. */
  onUpdate?: (t: number) => void;
  /** Called once, when the scene is laid out with its final fonts. */
  onLayout?: () => void;
}

/** What a picture may be marked with: boxes on it, and the part that the camera zooms into. */
export interface PictureMarks {
  highlights?: PlannedHighlight[];
  focus?: PictureRect;
}

const CAMERA_CSS = `
.ms-cam-clip { position: relative; width: 100%; height: 100%; overflow: hidden; }
.ms-cam { position: relative; width: 100%; height: 100%; transform-origin: 0 0; }
`;

/**
 * Put highlights on a picture and let a camera move over it. The picture and its highlights sit in one
 * element that the window clips. Without marks the picture is returned as it is.
 */
export function withMarks(
  ctx: SceneContext,
  marks: PictureMarks,
  content: HTMLElement,
  update?: (t: number) => void,
): Pick<FramedPicture, 'content' | 'onUpdate' | 'onLayout'> {
  const layer = createHighlights(ctx, marks.highlights ?? []);
  if (!layer.el && !marks.focus) return { content, onUpdate: update };
  css('camera', CAMERA_CSS);
  const { sw } = ctx;
  const camera = h('div', { class: 'ms-cam' }, content, layer.el);
  // The window clips its whole body, the bar too: the camera needs a clip of its own.
  const clip = h('div', { class: 'ms-cam-clip' }, camera);
  const focus = marks.focus ?? null;
  const rest = focus ? focusView(focus) : FULL_VIEW;
  const move = cameraMove(ctx.duration, beatAt(ctx.scene, 0));
  return {
    content: clip,
    onLayout: () => layer.layout(rest),
    onUpdate(t) {
      update?.(t);
      const view = viewAt(focus, move, t);
      const [scale, x, y] = [q(scaleOf(view), 4), q(view.x * 100, 4), q(view.y * 100, 4)];
      // A camera that has not moved has no transform at all.
      sw.transform(
        camera,
        scale === 1 && x === 0 && y === 0 ? 'none' : `scale(${scale}) translate(${-x}%, ${-y}%)`,
      );
      layer.update(t, scale);
    },
  };
}

/** A picture in a window (or a phone frame for tall ones), fitted without distortion, with its caption and entrance. */
export function framedScene(ctx: SceneContext, picture: FramedPicture): SceneInstance {
  css('screenshot', SCREENSHOT_CSS);
  const { sw } = ctx;
  const { caption, content: img } = picture;
  const image = picture;
  const aspect = image.width > 0 && image.height > 0 ? image.height / image.width : 0.625;
  const device = aspect > 1.25;
  const chromeW = device ? 2 * DEVICE_PAD : 0;
  const chromeH = device ? 2 * DEVICE_PAD : WINDOW_BAR_H;
  const fit = fitImage(
    image.width,
    image.height,
    CONTENT_W - chromeW,
    CONTENT_H - 24 - chromeH - (caption ? CAPTION_RESERVE : 0),
  );
  const frameW = fit.width + chromeW;
  const frameH = fit.height + chromeH;
  const groupH = frameH + (caption ? CAPTION_RESERVE : 0);

  const frame = device
    ? h('div', { class: 'ms-shot__device' }, h('div', { class: 'ms-shot__screen' }, img))
    : windowFrame({
        style: { width: `${frameW}px`, height: `${frameH}px` },
        barHeight: WINDOW_BAR_H,
        body: h('div', { class: 'ms-window__body' }, img),
      });
  const top = Math.max(0, Math.round((CONTENT_H - groupH) / 2));
  const wrap = h(
    'div',
    {
      class: 'ms-shot__wrap',
      style: {
        left: `${Math.round((CONTENT_W - frameW) / 2)}px`,
        top: `${top}px`,
        width: `${frameW}px`,
        height: `${frameH}px`,
      },
    },
    frame,
  );
  const root = h('div', { class: 'ms-content ms-shot' }, wrap);

  const captionWidth = Math.min(CONTENT_W, Math.max(frameW, 900));
  const captionEl = caption
    ? captionBlock('ms-shot__caption', caption, {
        left: `${Math.round((CONTENT_W - captionWidth) / 2)}px`,
        top: `${top + frameH + 24}px`,
        width: `${captionWidth}px`,
        'max-height': '76px',
      })
    : null;
  if (captionEl) root.append(captionEl.el);

  const instance: SceneInstance = {
    root,
    layout() {
      captionEl?.fit();
      picture.onLayout?.();
    },
    update(t) {
      // One gentle zoom-in over the first 1.2 s, then the frame rests.
      const p = enter(t, 0.05, 1.2);
      sw.opacity(wrap, clamp01(p * 2.4));
      sw.transform(wrap, `scale(${q(lerp(0.94, 1, p), 4)})`);
      captionEl?.reveal(sw, t, 0.55);
      picture.onUpdate?.(t);
    },
  };
  return instance;
}

/** Shown where a picture cannot be drawn. */
export function missingPicture(): HTMLElement {
  return h(
    'div',
    { class: 'ms-shot__missing' },
    icon('image', { size: 64, stroke: 1.5 }),
    'Image unavailable',
  );
}

export const screenshotTemplate: TemplateFactory<ScreenshotResolved> = (visual, ctx) => {
  const caption = (visual.caption ?? '').trim() || null;
  const { image } = visual;
  const shown = isDataImage(image.src);
  const content = shown
    ? h('img', { class: 'ms-shot__img', attrs: { src: image.src, alt: caption ?? 'Screenshot' } })
    : missingPicture();
  // A placeholder gets no boxes and no camera, like a before-after panel.
  return framedScene(ctx, {
    width: image.width,
    height: image.height,
    caption,
    ...(shown ? withMarks(ctx, visual, content) : { content }),
  });
};

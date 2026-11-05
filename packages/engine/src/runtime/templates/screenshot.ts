/** A screenshot framed in a neutral window (or a phone frame for tall images), fitted without distortion. */
import { CONTENT_H, CONTENT_W, type ScreenshotResolved } from '../../core/render-plan.ts';
import { clamp01, enter, lerp, q } from '../anim.ts';
import { css, h } from '../dom.ts';
import { icon } from '../icons.ts';
import type { SceneInstance, TemplateFactory } from '../types.ts';
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

export const screenshotTemplate: TemplateFactory<ScreenshotResolved> = (visual, ctx) => {
  css('screenshot', SCREENSHOT_CSS);
  const { sw } = ctx;
  const caption = (visual.caption ?? '').trim() || null;
  const { image } = visual;
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

  const img = isDataImage(image.src)
    ? h('img', { class: 'ms-shot__img', attrs: { src: image.src, alt: caption ?? 'Screenshot' } })
    : h('div', { class: 'ms-shot__missing' }, icon('image', { size: 64, stroke: 1.5 }), 'Image unavailable');
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
    },
    update(t) {
      // One gentle zoom-in over the first 1.2 s, then the frame rests.
      const p = enter(t, 0.05, 1.2);
      sw.opacity(wrap, clamp01(p * 2.4));
      sw.transform(wrap, `scale(${q(lerp(0.94, 1, p), 4)})`);
      captionEl?.reveal(sw, t, 0.55);
    },
  };
  return instance;
};

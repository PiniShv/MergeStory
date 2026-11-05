/**
 * Browser runtime entry. Exposes window.__MERGESTORY__ (see MergeStoryRuntimeApi).
 *
 * The stage is laid out at 1920x1080 and scaled to the plan size. Scenes are mounted once and
 * shown or hidden by time; chrome (brand bar, captions, progress, evidence chips, badges) and the
 * end card sit above them. Every DOM write goes through one StyleWriter, which is how seek()
 * knows whether a frame differs from the previous one.
 */
import type { MergeStoryRuntimeApi, PlannedScene, RenderPlan } from '../core/render-plan.ts';
import { STAGE_HEIGHT, STAGE_WIDTH } from '../core/render-plan.ts';
import { StyleWriter } from './anim.ts';
import { type Chrome, createChrome } from './chrome.ts';
import { makeContext } from './context.ts';
import { css, h } from './dom.ts';
import { createOutro, type Outro } from './outro.ts';
import { templateFor } from './registry.ts';
import { BASE_CSS } from './styles.ts';
import {
  buildSlots,
  frameClip,
  frameTransform,
  type SceneSlot,
  sceneFrame,
  wipeEdge,
} from './transitions.ts';
import type { SceneInstance } from './types.ts';

declare global {
  interface Window {
    __MERGESTORY__: MergeStoryRuntimeApi;
  }
}

interface Mounted {
  scene: PlannedScene;
  wrapper: HTMLElement;
  instance: SceneInstance;
}

/** Font faces the runtime waits for before measuring text (families come from the base styles). */
const FONT_FACES = [
  '400 24px Inter',
  '500 24px Inter',
  '600 24px Inter',
  '700 24px Inter',
  '800 24px Inter',
  '400 24px "JetBrains Mono"',
  '500 24px "JetBrains Mono"',
  '700 24px "JetBrains Mono"',
];

const RUNTIME_CSS = String.raw`
.ms-wipe {
  position: absolute;
  left: 0;
  top: 0;
  width: 4px;
  height: 1080px;
  margin-left: -2px;
  background: linear-gradient(180deg, transparent, var(--accent-2) 30%, var(--accent) 70%, transparent);
  box-shadow: 0 0 40px 6px rgba(140, 123, 255, 0.5);
}
`;

const sw = new StyleWriter();
let plan: RenderPlan | null = null;
let mounted: Mounted[] = [];
let slots: SceneSlot[] = [];
let chrome: Chrome | null = null;
let outro: Outro | null = null;
let wipe: HTMLElement | null = null;

/** Load every font face the runtime uses; faces the page does not declare resolve at once. */
async function loadFonts(): Promise<void> {
  await Promise.all(FONT_FACES.map((face) => document.fonts.load(face, 'Aa0+−·…').catch(() => [])));
  await document.fonts.ready;
}

/**
 * Give templates one laid-out moment to measure text. Hidden scenes have no layout, so show them
 * unseen. Laying them out also makes the browser request any font file the text needs that was not
 * preloaded, so the fonts are awaited before anything measures.
 */
async function layoutScenes(): Promise<void> {
  for (const m of mounted) {
    m.wrapper.style.display = 'block';
    m.wrapper.style.visibility = 'hidden';
  }
  void document.body.offsetHeight;
  await document.fonts.ready;
  chrome?.layout();
  for (const m of mounted) m.instance.layout?.();
  for (const m of mounted) {
    m.wrapper.style.display = 'none';
    m.wrapper.style.visibility = '';
  }
}

async function load(next: RenderPlan): Promise<void> {
  plan = next;
  css('base', BASE_CSS);
  css('runtime', RUNTIME_CSS);
  document.documentElement.dataset.theme = next.theme;
  document.documentElement.style.setProperty('--stage-w', `${next.width}px`);
  document.documentElement.style.setProperty('--stage-h', `${next.height}px`);
  document.body.replaceChildren();
  const stage = h('div', { attrs: { id: 'ms-stage' } });
  stage.style.transform = `scale(${next.width / STAGE_WIDTH}, ${next.height / STAGE_HEIGHT})`;
  document.body.append(stage);

  // Fonts first: templates build their text and measure it with the final faces.
  await loadFonts();

  const hasOutro = next.outro.durationSec > 0;
  slots = buildSlots(next.scenes, hasOutro ? next.outro : null);

  mounted = next.scenes.map((scene) => {
    const instance = templateFor(scene.visual)(scene.visual, makeContext(next, scene, sw));
    const wrapper = h('div', { class: 'ms-scene', attrs: { 'data-scene': scene.id } }, instance.root);
    wrapper.style.display = 'none';
    stage.append(wrapper);
    return { scene, wrapper, instance };
  });

  wipe = h('div', { class: 'ms-wipe' });
  wipe.style.display = 'none';
  stage.append(wipe);

  outro = createOutro(next, sw);
  if (outro) stage.append(outro.root);

  chrome = createChrome(next, slots, sw, hasOutro ? next.outro.startSec : null);
  stage.append(chrome.root);

  await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined)));
  await layoutScenes();
  sw.markDirty();
}

function seek(timeSec: number): { dirty: boolean } {
  if (!plan) return { dirty: false };
  for (let i = 0; i < mounted.length; i++) {
    const m = mounted[i]!;
    const slot = slots[i]!;
    const frame = sceneFrame(slot, timeSec);
    sw.visible(m.wrapper, frame.visible);
    if (!frame.visible) continue;
    sw.opacity(m.wrapper, frame.opacity);
    sw.transform(m.wrapper, frameTransform(frame));
    sw.style(m.wrapper, 'clip-path', frameClip(frame));
    m.instance.update(timeSec - slot.start);
  }

  if (wipe) {
    const edge = wipeEdge(slots, timeSec);
    sw.visible(wipe, edge !== null);
    if (edge) {
      sw.opacity(wipe, edge.opacity);
      sw.transform(wipe, `translate3d(${Math.round(edge.x * 100) / 100}px, 0, 0)`);
    }
  }

  outro?.update(timeSec);
  chrome?.update(timeSec);
  return { dirty: sw.consumeDirty() };
}

window.__MERGESTORY__ = {
  load,
  seek,
};

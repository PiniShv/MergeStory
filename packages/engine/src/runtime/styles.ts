/**
 * MergeStory design system for the video runtime.
 *
 * Canvas: 1920 x 1080 logical pixels (scaled to the output size by the runtime).
 * Safe areas:
 *   top bar      y   0 - 120   brand, change label, chapter title (runtime core)
 *   content      x 120 - 1800, y 140 - 844   (templates render inside .ms-content; a two-line
 *                caption starts at y 860, so the content keeps 16 px clear of it)
 *   captions     y 880 - 1000  (runtime core)
 *   progress     y 1030 - 1048 (runtime core)
 *
 * Templates must use these tokens and primitives instead of raw colors, so every scene
 * looks like part of one video and the light theme works without extra code.
 */
import { CONTENT_H, CONTENT_W } from '../core/render-plan.ts';

export const BASE_CSS = String.raw`
:root {
  --stage-w: 1920px;
  --stage-h: 1080px;

  --bg-0: #05070d;
  --bg-1: #0a0f1e;
  --surface-1: rgba(20, 28, 54, 0.78);
  --surface-2: rgba(30, 41, 76, 0.86);
  --surface-code: #0a1020;
  --surface-inset: rgba(5, 8, 18, 0.55);
  --border-1: rgba(150, 165, 215, 0.14);
  --border-2: rgba(150, 165, 215, 0.28);

  --text-0: #f4f6ff;
  --text-1: #cdd5ec;
  --text-2: #8f9aba;
  --text-3: #7681a6;

  --accent: #8c7bff;
  --accent-soft: rgba(140, 123, 255, 0.16);
  --accent-2: #39d2f2;
  --accent-2-soft: rgba(57, 210, 242, 0.14);

  --add: #3ddc97;
  --add-soft: rgba(61, 220, 151, 0.14);
  --add-line: rgba(61, 220, 151, 0.11);
  --del: #ff6b81;
  --del-soft: rgba(255, 107, 129, 0.14);
  --del-line: rgba(255, 107, 129, 0.11);
  --mod: #ffc861;
  --mod-soft: rgba(255, 200, 97, 0.15);

  --sev-info: #60a5fa;
  --sev-low: #3ddc97;
  --sev-medium: #ffc861;
  --sev-high: #ff6b81;

  --radius-l: 24px;
  --radius-pill: 999px;

  --shadow-card: 0 34px 80px -24px rgba(0, 0, 0, 0.65), 0 0 0 1px var(--border-1);
  --shadow-lift: 0 20px 50px -18px rgba(0, 0, 0, 0.6);
  --glow-accent: 0 0 0 1px rgba(140, 123, 255, 0.45), 0 0 48px rgba(140, 123, 255, 0.28);

  --font-ui: 'Inter', 'Helvetica Neue', Arial, sans-serif;
  --font-code: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;

  --fs-h2: 46px;
  --fs-micro: 22px;

  --content-left: 120px;
  --content-top: 140px;
  --content-width: ${CONTENT_W}px;
  --content-height: ${CONTENT_H}px;
}

:root[data-theme='light'] {
  --bg-0: #eef1f8;
  --bg-1: #f6f7fb;
  --surface-1: rgba(255, 255, 255, 0.86);
  --surface-2: rgba(255, 255, 255, 0.96);
  --surface-code: #ffffff;
  --surface-inset: rgba(15, 23, 42, 0.04);
  --border-1: rgba(30, 41, 80, 0.12);
  --border-2: rgba(30, 41, 80, 0.22);
  --text-0: #0d1330;
  --text-1: #2b3558;
  --text-2: #5b6688;
  --text-3: #68718f;
  --accent: #6750f0;
  --accent-soft: rgba(103, 80, 240, 0.1);
  --accent-2: #0891b2;
  --accent-2-soft: rgba(8, 145, 178, 0.1);
  --add: #0f9f6e;
  --add-soft: rgba(15, 159, 110, 0.12);
  --add-line: rgba(15, 159, 110, 0.09);
  --del: #d6334f;
  --del-soft: rgba(214, 51, 79, 0.1);
  --del-line: rgba(214, 51, 79, 0.08);
  --mod: #b7791f;
  --mod-soft: rgba(183, 121, 31, 0.12);
  --shadow-card: 0 30px 70px -28px rgba(30, 41, 80, 0.35), 0 0 0 1px var(--border-1);
  --shadow-lift: 0 18px 40px -20px rgba(30, 41, 80, 0.35);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: var(--stage-w);
  height: var(--stage-h);
  overflow: hidden;
  background: var(--bg-0);
}

body {
  font-family: var(--font-ui);
  color: var(--text-0);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  font-feature-settings: 'cv11', 'ss01', 'tnum' 0;
}

#ms-stage {
  position: absolute;
  left: 0;
  top: 0;
  width: 1920px;
  height: 1080px;
  overflow: hidden;
  transform-origin: 0 0;
  background:
    radial-gradient(1200px 700px at 12% -10%, rgba(140, 123, 255, 0.18), transparent 60%),
    radial-gradient(1000px 640px at 100% 110%, rgba(57, 210, 242, 0.12), transparent 60%),
    linear-gradient(180deg, var(--bg-1), var(--bg-0));
}

:root[data-theme='light'] #ms-stage {
  background:
    radial-gradient(1200px 700px at 12% -10%, rgba(103, 80, 240, 0.1), transparent 60%),
    radial-gradient(1000px 640px at 100% 110%, rgba(8, 145, 178, 0.08), transparent 60%),
    linear-gradient(180deg, var(--bg-1), var(--bg-0));
}

/* Faint grid that gives depth without motion. */
#ms-stage::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(150, 165, 215, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(150, 165, 215, 0.045) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(ellipse at 50% 40%, #000 30%, transparent 75%);
  pointer-events: none;
}

/* A scene fills the stage; templates draw inside .ms-content. */
/* No will-change here: it would make text rasterisation depend on how a scene was first shown. */
.ms-scene {
  position: absolute;
  inset: 0;
}

.ms-content {
  position: absolute;
  left: var(--content-left);
  top: var(--content-top);
  width: var(--content-width);
  height: var(--content-height);
}

/* ---------- Primitives ---------- */

.ms-card {
  background: var(--surface-1);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(18px);
}

.ms-card--raised { background: var(--surface-2); }

.ms-kicker {
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent-2);
}

.ms-h2 { font-size: var(--fs-h2); font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }

.ms-gradient-text {
  background: linear-gradient(92deg, var(--text-0) 10%, #c9c1ff 55%, #8fe9fb 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

:root[data-theme='light'] .ms-gradient-text {
  background: linear-gradient(92deg, var(--text-0) 10%, #5a43e6 60%, #0e7490 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.ms-chip {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 50px;
  padding: 0 20px;
  border-radius: var(--radius-pill);
  background: var(--surface-inset);
  box-shadow: 0 0 0 1px var(--border-2);
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
}

.ms-status-added { --status: var(--add); --status-soft: var(--add-soft); }
.ms-status-modified { --status: var(--mod); --status-soft: var(--mod-soft); }
.ms-status-removed, .ms-status-deleted { --status: var(--del); --status-soft: var(--del-soft); }
.ms-status-unchanged { --status: var(--text-3); --status-soft: var(--surface-inset); }
.ms-status-renamed, .ms-status-copied { --status: var(--accent-2); --status-soft: var(--accent-2-soft); }

.ms-sev-info { --sev: var(--sev-info); }
.ms-sev-low { --sev: var(--sev-low); }
.ms-sev-medium { --sev: var(--sev-medium); }
.ms-sev-high { --sev: var(--sev-high); }

/* Badges that tell the viewer what kind of visual they are looking at. */
.ms-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 18px;
  border-radius: var(--radius-pill);
  font-size: 22px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  background: rgba(5, 8, 18, 0.72);
  backdrop-filter: blur(10px);
}
.ms-badge::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.ms-badge--simulated { color: #ffc861; box-shadow: 0 0 0 1px rgba(255, 200, 97, 0.45); }
.ms-badge--actual { color: #3ddc97; box-shadow: 0 0 0 1px rgba(61, 220, 151, 0.45); }
.ms-badge--masked { color: #ff6b81; box-shadow: 0 0 0 1px rgba(255, 107, 129, 0.45); }
.ms-badge--reported { color: #60a5fa; box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.45); }
:root[data-theme='light'] .ms-badge { background: rgba(255, 255, 255, 0.94); }
:root[data-theme='light'] .ms-badge--simulated { color: #8f5600; box-shadow: 0 0 0 1px rgba(143, 86, 0, 0.45); }
:root[data-theme='light'] .ms-badge--actual { color: #087a52; box-shadow: 0 0 0 1px rgba(8, 122, 82, 0.45); }
:root[data-theme='light'] .ms-badge--masked { color: #c0243e; box-shadow: 0 0 0 1px rgba(192, 36, 62, 0.45); }
:root[data-theme='light'] .ms-badge--reported { color: #1d4ed8; box-shadow: 0 0 0 1px rgba(29, 78, 216, 0.45); }

/* Window chrome shared by code, terminal and browser templates. */
.ms-window {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-l);
  background: var(--surface-code);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.ms-window__bar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 64px;
  padding: 0 24px;
  background: rgba(255, 255, 255, 0.025);
  border-bottom: 1px solid var(--border-1);
  flex: none;
}
.ms-window__lights { display: flex; gap: 10px; }
.ms-window__lights i { width: 14px; height: 14px; border-radius: 50%; background: var(--text-3); opacity: 0.55; }
.ms-window__lights i:nth-child(1) { background: #ff6b81; }
.ms-window__lights i:nth-child(2) { background: #ffc861; }
.ms-window__lights i:nth-child(3) { background: #3ddc97; }
.ms-window__body { position: relative; flex: 1; min-height: 0; }
`;

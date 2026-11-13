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
  /* Accent colours for large text: gradient headings and the brand word. */
  --accent-ink: #c9c1ff;
  --accent-2-ink: #8fe9fb;
  --brand-1: #b6acff;
  --brand-2: var(--accent-2);
  /* Soft halos and rings around accent elements. */
  --glow: var(--accent);
  --glow-2: var(--accent-2);

  --cap-bg: rgba(5, 8, 18, 0.76);
  --cap-fg: #f6f8ff;
  --cap-ring: rgba(150, 165, 215, 0.2);

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

  /* Badges and the text on status pills keep these colours in every theme. */
  --badge-bg: rgba(5, 8, 18, 0.72);
  --badge-simulated: #ffc861;
  --badge-actual: #3ddc97;
  --badge-masked: #ff6b81;
  --badge-reported: #60a5fa;
  --on-status: #071022;

  --radius-l: 24px;
  --radius-pill: 999px;

  --shadow-card: 0 34px 80px -24px rgba(0, 0, 0, 0.65), 0 0 0 1px var(--border-1);
  --shadow-lift: 0 20px 50px -18px rgba(0, 0, 0, 0.6);
  --glow-accent: 0 0 0 1px color-mix(in srgb, var(--glow) 45%, transparent), 0 0 48px color-mix(in srgb, var(--glow) 28%, transparent);

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
  --accent-ink: #5a43e6;
  --accent-2-ink: #0e7490;
  --brand-1: #5a43e6;
  --brand-2: #0e7490;
  --glow: #8c7bff;
  --glow-2: #39d2f2;
  --cap-bg: rgba(255, 255, 255, 0.92);
  --cap-fg: #0d1330;
  --cap-ring: rgba(30, 41, 80, 0.16);
  --add: #0f9f6e;
  --add-soft: rgba(15, 159, 110, 0.12);
  --add-line: rgba(15, 159, 110, 0.09);
  --del: #d6334f;
  --del-soft: rgba(214, 51, 79, 0.1);
  --del-line: rgba(214, 51, 79, 0.08);
  --mod: #b7791f;
  --mod-soft: rgba(183, 121, 31, 0.12);
  --badge-bg: rgba(255, 255, 255, 0.94);
  --badge-simulated: #8f5600;
  --badge-actual: #087a52;
  --badge-masked: #c0243e;
  --badge-reported: #1d4ed8;
  --on-status: #ffffff;
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
    radial-gradient(1200px 700px at 12% -10% in srgb, color-mix(in srgb, var(--accent) 18%, transparent), transparent 60%),
    radial-gradient(1000px 640px at 100% 110% in srgb, color-mix(in srgb, var(--accent-2) 12%, transparent), transparent 60%),
    linear-gradient(180deg, var(--bg-1), var(--bg-0));
}

:root[data-theme='light'] #ms-stage {
  background:
    radial-gradient(1200px 700px at 12% -10% in srgb, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%),
    radial-gradient(1000px 640px at 100% 110% in srgb, color-mix(in srgb, var(--accent-2) 8%, transparent), transparent 60%),
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
  background: linear-gradient(92deg, var(--text-0) 10%, var(--accent-ink) 55%, var(--accent-2-ink) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

:root[data-theme='light'] .ms-gradient-text {
  background: linear-gradient(92deg, var(--text-0) 10%, var(--accent-ink) 60%, var(--accent-2-ink) 100%);
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
  color: var(--badge);
  background: var(--badge-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--badge) 45%, transparent);
  backdrop-filter: blur(10px);
}
.ms-badge::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.ms-badge--simulated { --badge: var(--badge-simulated); }
.ms-badge--actual { --badge: var(--badge-actual); }
.ms-badge--masked { --badge: var(--badge-masked); }
.ms-badge--reported { --badge: var(--badge-reported); }

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

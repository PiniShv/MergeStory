# 2. Render with a deterministic HTML runtime and FFmpeg

Status: accepted

## Context

Videos need animated diagrams, highlighted code, simulated terminals and browsers, transitions and
captions, at 1080p, cheaply and reproducibly, under an open-source license.

Options considered:

- **Remotion**: mature React-based video rendering, but its license requires a paid company
  license for larger companies. An open-source tool that depends on it passes that cost to its users.
- **Motion Canvas / Revideo**: strong for code animation, but built around an editor, with
  headless rendering that is secondary or uncertain in maintenance.
- **Manim**: Python and LaTeX; a heavy stack for a TypeScript tool.
- **Pure Node canvas**: no browser needed, but every layout and text feature must be written by hand,
  which makes templates hard to build and to contribute to.
- **Video-generation APIs**: expensive, slow and not reproducible; they cannot show real code reliably.

## Decision

A small browser runtime (`src/runtime`) builds the whole video in HTML, CSS and SVG and exposes
`seek(t)`, a pure function of time. The renderer drives headless Chromium through Playwright,
captures JPEG frames over the DevTools Protocol in parallel pages, and encodes with FFmpeg.
Frames that did not change are reused instead of captured again.

## Consequences

- Templates are ordinary HTML and CSS, which many contributors know.
- Output is reproducible: fonts are embedded and the page has no network access.
- A Chromium browser and FFmpeg are required. Most developer machines and GitHub-hosted runners
  have Chrome; `mergestory doctor` explains how to install what is missing.
- Measured on a laptop, one page captures about 30 frames per second at 1080p; parallel pages and
  frame reuse make a 2-minute video render in about a minute.

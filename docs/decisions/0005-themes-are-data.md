# 5. Themes are data

Status: accepted

## Context

People want videos in their own colors. Themes get shared, so a theme can come from someone you do not
know. A theme that could run code could read files or send them away. A theme also must not make a
video say less than it does: a removed line must still look removed, and a simulated picture must
still say so.

## Decision

- A theme is one strict `theme.json` with `schema: 1`: colors for named design tokens of the video,
  and the name of a Shiki color scheme that ships with MergeStory. No code, no CSS, no URLs. The one
  file it may name is a logo.
- Unknown keys are errors. Values are hex, `rgb()` or `hsl()` colors only. A value with `://`, `url(`,
  `@import`, `expression`, `<` or `;` is refused.
- The built-in themes are `theme.json` files too, read by the same loader.
- The theme goes into the render plan as data. The render page, its content security policy, request
  blocking and offline mode do not change.
- A name finds a built-in theme, then `$MERGESTORY_HOME/themes/<name>`. A path comes only from the
  command line, the user's own config file or `MERGESTORY_THEME`, never from the storyboard, the pull
  request, the repository, the HTTP API or an agent command.
- Only plain files inside the theme folder are read: `theme.json` (at most 64 KB) and the logo it
  names. No symbolic or hard links, no `..`, no absolute paths.
- A logo is a still PNG or JPEG, told from its bytes, at most 256 KB and 2048x2048 pixels. It goes into
  the render plan as a `data:` image, which the content security policy of the page already allows, so
  the page still loads nothing. SVG is refused: it is a document that can hold scripts and links, not
  only a picture. An animated PNG is refused too: the browser would play it on its own clock, not the
  video's.
- The colors that carry meaning are locked: added, removed and changed lines, new connections in
  diagrams, and the badges for simulated pictures, real screenshots, masked secrets and reported
  results. The background must be opaque, and the locked change colors must stand out (2:1) from it
  along its whole gradient and from every box drawn on it. No flag turns this off.
- A contrast check refuses themes that are hard to read: text 4.5:1, muted text 3:1, captions 7:1.
  `--allow-low-contrast` turns it into a warning.

## Consequences

- The default video costs and sends nothing more than before. `midnight` and `paper` look the same as
  `dark` and `light` did, and golden stills check it.
- Themes cannot change fonts, or the text of the end card. A logo takes the place of the MergeStory
  mark and name, and the end card keeps a small "Made with MergeStory" line.
- A team sees a theme with low contrast before a video goes out, because using it needs a flag.

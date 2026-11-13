# 5. Themes are data

Status: accepted

## Context

People want videos in their own colors. Themes get shared, so a theme can come from someone you do not
know. A theme that could run code could read files or send them away. A theme also must not make a
video say less than it does: a removed line must still look removed, and a simulated picture must
still say so.

## Decision

- A theme is one strict `theme.json` with `schema: 1`: colors for named design tokens of the video,
  and the name of a Shiki color scheme that ships with MergeStory. No code, no CSS, no files, no URLs.
- Unknown keys are errors. Values are hex, `rgb()` or `hsl()` colors only. A value with `://`, `url(`,
  `@import`, `expression`, `<` or `;` is refused.
- The built-in themes are `theme.json` files too, read by the same loader.
- The theme goes into the render plan as data. The render page, its content security policy, request
  blocking and offline mode do not change.
- A name finds a built-in theme, then `$MERGESTORY_HOME/themes/<name>`. A path comes only from the
  command line or the user's own config, never from the storyboard, the pull request, the repository,
  the HTTP API or an agent command.
- Only a plain `theme.json` inside the theme folder is read: no symbolic or hard links, no `..`, no
  absolute paths, at most 64 KB.
- The colors that carry meaning are locked: added, removed and changed lines, and the badges for
  simulated pictures, real screenshots, masked secrets and reported results.
- A contrast check refuses themes that are hard to read: text 4.5:1, muted text 3:1, captions 7:1.
  `--allow-low-contrast` turns it into a warning.

## Consequences

- The default video costs and sends nothing more than before. `midnight` and `paper` look the same as
  `dark` and `light` did, and golden stills check it.
- Themes cannot change fonts, the logo or the end card. Those need files in the theme folder, which
  the folder rules above already cover.
- A team sees a theme with low contrast before a video goes out, because using it needs a flag.

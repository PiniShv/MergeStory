# Themes

A theme sets the colors of a video. MergeStory has four built-in themes, and you can make your own.
A theme is data, never code: one `theme.json` file with colors and the name of a color scheme for
code, and, if you want, your logo as a PNG or JPEG file.

## Choose a theme

| Theme | What it looks like |
|---|---|
| `midnight` | Dark blue, with violet and cyan accents. The default. |
| `paper` | Light, with the same accents in darker shades. |
| `high-contrast` | Black background, white text and bright accents. |
| `terminal` | Near-black background, green text and amber highlights. |

Pass `--theme <theme>` to `generate`, or set `theme` in your config file or `MERGESTORY_THEME`. The
old values `dark` and `light` still work: they are `midnight` and `paper`.

```bash
mergestory generate --theme terminal
```

## See a theme before you use it

```bash
mergestory theme preview terminal
```

This draws sample scenes with the theme and writes a page, `index.html`, that shows them all. It
calls no model, makes no voice and uses no network. The files go to
`~/.mergestory/previews/<theme>`, or to the folder you give with `--out`. See
[cli.md](cli.md#mergestory-theme-preview).

## Make a theme from your brand colors

Give MergeStory your main brand color, or a file with your brand colors, and it makes the theme:

```bash
mergestory theme init acme --accent "#ff7a1a"
```

```bash
mergestory theme init acme --brand brand.css --from paper
```

- `--accent` is your main brand color, and `--accent-2` an optional second one.
- `--brand` reads a file with your brand colors: CSS variables, design tokens in JSON, or a plain list.
  It reads colors written as `#hex`, `rgb()` or `hsl()`; other notations, such as `oklch()`, are
  skipped. Greys, black and white are skipped too. The accent is the first color that labels can use
  on the chosen look (3:1, see the checks below), and the second accent is the next such color with a
  clearly different hue. So a navy brand color is used on `paper` but not on `midnight`. Without a
  second color, the theme keeps the one of `--from`. `--accent` and `--accent-2` win over the file.
- `--from` is the built-in theme to start from. `midnight` (the default) makes a dark theme, `paper` a
  light one.

A brand color given with `--accent` must pass the same check: on a light theme a pale color, such as a
light yellow, fails it, and on a dark theme a deep one, such as navy, does. Give a deeper or a lighter
shade of it, or start from the other look. When the check fails, the error names the colors it tried.

MergeStory works out the other accent colors (soft backgrounds, the colors of large text and the logo
word, the glows) from your colors, the way the built-in themes relate theirs. It runs the checks, saves
`~/.mergestory/themes/<name>/theme.json` and tells you how to look at it. It never replaces a theme
unless you pass `--force`. You can change the file by hand afterwards.

## Add your logo

Pass `--logo` when you make the theme:

```bash
mergestory theme init acme --accent "#ff7a1a" --logo logo.png
```

The logo takes the place of the MergeStory mark and name in the top bar of the video, and leads the
end card. The end card keeps a small "Made with MergeStory" line.

- The logo must be a PNG or JPEG file, at most 256 KB and 2048x2048 pixels. MergeStory checks the
  bytes of the file, not its name. SVG is not supported: export your logo as PNG.
- Use a logo that shows on the background of your theme: light on a dark theme, dark on a light one. A
  PNG with a see-through background works best.
- The end card draws the logo at most 720 pixels wide and 160 pixels tall, and the top bar at most 44
  pixels tall. A logo of about 720x160 pixels, or bigger, stays sharp.
- `theme init` copies the file into the theme folder as `logo.png` or `logo.jpg` and names it in
  `theme.json`. With `--force`, pass `--logo` again to keep the logo.

In a theme you make by hand, put the file in the theme folder and name it in `theme.json`, for example
`"logo": "logo.png"`.

## Make your own theme by hand

1. Make a folder `~/.mergestory/themes/<name>`. The name has 1 to 40 characters: `a-z`, `0-9` and
   `-`.
2. Put a `theme.json` file in it. This one keeps midnight and changes the accent to orange:

   ```json
   {
     "schema": 1,
     "name": "acme",
     "extends": "midnight",
     "colors": {
       "dark": {
         "accent": "#ff7a1a",
         "accent-soft": "rgba(255, 122, 26, 0.16)",
         "accent-ink": "#ffc08f",
         "brand-1": "#ffb070"
       }
     }
   }
   ```

3. Look at it with `mergestory theme preview acme`, then use it with `mergestory generate --theme acme`.

For a light theme, put your colors under `colors.light` and extend `paper`, or leave `extends` out.

A theme folder can also be somewhere else. Give its path to `--theme` on the command line, or its full
path as `theme` in your own config file.

The built-in themes are good examples. Each one is a `theme.json` in
[packages/engine/assets/themes](../packages/engine/assets/themes), with the colors it sets.

## The format

| Key | What it holds |
|---|---|
| `schema` | Always `1`. |
| `name` | The name of the theme: 1 to 40 characters, `a-z`, `0-9` and `-`. |
| `extends` | Optional. A built-in theme to start from. Your colors replace its colors. Without `extends`, a dark theme starts from `midnight` and a light theme from `paper`. |
| `colors.dark` or `colors.light` | One of the two. The key says if the video is dark or light, and it holds the colors you change. A theme that extends a built-in theme uses the same key as that theme. |
| `code.shiki` | Optional. A Shiki color scheme for code that comes with MergeStory, for example `github-dark-default`, `monokai` or `github-light-default`. Use a dark scheme for a dark theme and a light scheme for a light theme. Without it, the theme keeps the scheme of the theme it starts from. |
| `logo` | Optional. The file name of your logo in the theme folder, for example `logo.png`: a name only, not a path. See [Add your logo](#add-your-logo). |

Any other key is an error. Every color must be written as `#rgb`, `#rrggbb`, `#rrggbbaa`,
`rgb()`, `rgba()`, `hsl()` or `hsla()`, with numbers of at most three digits before the point and four
after, and a hue from 0 to 360. Color names such as `red`, `var()`, `url()` and anything else are
refused.

## The colors a theme can set

| Color | What it colors |
|---|---|
| `bg-0`, `bg-1` | The background of the video, from bottom (`bg-0`) to top (`bg-1`). Both must be opaque. |
| `surface-1`, `surface-2` | Cards, and raised cards. |
| `surface-code` | The background of code and terminal windows. |
| `surface-inset` | Chips and small boxes inside cards. |
| `border-1`, `border-2` | Thin and strong borders. |
| `text-0`, `text-1`, `text-2` | Main text, secondary text and quiet text. |
| `text-3` | Muted text, such as line numbers. |
| `accent`, `accent-soft` | The main accent, and a see-through version for backgrounds. |
| `accent-2`, `accent-2-soft` | The second accent, used for labels, and its see-through version. |
| `accent-ink`, `accent-2-ink` | The accents in large text, such as the gradient of a heading. |
| `brand-1`, `brand-2` | The gradient of the word "Story" in the logo. |
| `glow`, `glow-2` | Soft light around accent elements. |
| `cap-bg`, `cap-fg`, `cap-ring` | The caption: its background, its text and its border. |
| `sev-info`, `sev-low`, `sev-medium`, `sev-high` | The levels of review signals. |

In `midnight` and the themes that start from it, `glow` follows `accent`, and `glow-2` and `brand-2`
follow `accent-2`, unless you set them.

## What a theme cannot change

- Added, removed and changed lines keep their green, red and amber, so a theme cannot make a removal
  look like an addition. New connections in diagrams keep their color too.
- The badges keep their colors: "Simulated UI", "Actual screenshot", "Secrets masked" and "Reported by
  caller". A theme cannot hide that a picture is simulated or that secrets were masked.
- Secrets are masked before the theme is used. A theme has no setting for masking.
- Fonts, sizes and the layout stay the same. A theme can put your logo in place of the MergeStory mark
  and name. The rest of the end card keeps its text.

## The checks

The checks look at every background that text and changes are drawn on: the background all along its
gradient from `bg-1` (top) to `bg-0` (bottom), every card, code window and inset box on it, and inset
boxes and code windows on cards. The soft glows behind some scenes are not part of the checks.

Two rules always apply, and no flag turns them off:

- `bg-0` and `bg-1` must be opaque.
- The colors of added, removed and changed lines, and of new connections, must stand out from every
  one of those backgrounds: at least 2:1. So a theme cannot make a change hard to see.

MergeStory also refuses a theme that is hard to read:

| What | Needs at least |
|---|---|
| `text-0`, `text-1` and `text-2` on every background | 4.5:1 |
| `text-3` on every background | 3:1 |
| `accent` and `accent-2`, which color labels, on every background | 3:1 |
| Captions (`cap-fg` on `cap-bg`), over any scene behind them | 7:1 |

It also refuses a light `code.shiki` scheme on a dark theme, or a dark one on a light theme. The error
names each color and its contrast. With `--allow-low-contrast` (on `generate`, `theme preview` and `theme init`)
these readability problems are warnings instead.

## Where a theme comes from

MergeStory looks for a theme name in this order:

1. The built-in themes.
2. `$MERGESTORY_HOME/themes/<name>/theme.json`.

Any other value must be the path of a theme folder (or of its `theme.json`). Only you give a path:
on the command line, or as a full path in your own config file. A relative path in the config file or
in `MERGESTORY_THEME` is an error.

MergeStory never takes a theme path from the storyboard, the pull request, the repository, the HTTP
API or a coding agent. The agent commands and the HTTP API take a theme name only.

In CI, prefer a theme name. A theme folder inside the repository can be changed by any pull request.

## Safety

- A theme is one JSON file with colors, and at most one logo image. It cannot run code, load a font or
  reach the network. The logo goes into the video as data, so the render page stays offline, with the
  same content security policy as before.
- In a theme folder, MergeStory reads only `theme.json` (at most 64 KB) and the logo it names (at most
  256 KB), and only when each is a plain file inside the folder: not a symbolic link and not a hard
  link. A theme folder that is a symbolic link is refused.
- A logo must be a PNG or JPEG image. SVG is refused, because an SVG file can hold scripts and links.

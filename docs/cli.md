# CLI reference

`mergestory` is the command-line tool of the MergeStory engine. This page lists every command and flag,
what each command prints, and the exit code it ends with. The settings behind the flags are in
[configuration.md](configuration.md). The installed version always has the last word:
`mergestory --help` and `mergestory <command> --help` show its flags.

| I want to... | Use |
|---|---|
| Check that this machine is ready | [`mergestory doctor`](#mergestory-doctor) |
| Make a video from a pull request or a branch | [`mergestory generate`](#mergestory-generate) |
| Upload a video I made earlier | [`mergestory publish`](#mergestory-publish) |
| Write the storyboard myself, or let a coding agent write it | [`analyze`](#mergestory-analyze), [`validate`](#mergestory-validate) and [`schema`](#mergestory-schema) |
| Let a coding agent run MergeStory without asking each time | [`mergestory agent`](#commands-for-coding-agents) |
| Make a video in the background | `generate --async`, then [`status`](#mergestory-status) and [`jobs`](#mergestory-jobs) |
| Make videos for many pull requests | [batch.md](batch.md) |
| Run MergeStory from a script or an agent, with nobody watching | [Unattended runs](#unattended-runs) |
| Offer MergeStory over HTTP | [`mergestory serve`](#mergestory-serve) |
| Install the free voice, or sign in to YouTube | [`mergestory setup`](#mergestory-setup) |
| Empty the cache | [`mergestory cache clear`](#mergestory-cache-clear) |

## The basics

Install it with `npm install -g mergestory`, or run it without installing as `npx mergestory`. Use `npx`
only in a folder you trust: when that folder has its own copy of a package, or its own npm settings,
`npx` uses those instead of the published package. In a clone
of this repository, run `node packages/engine/src/cli/main.ts <command>` (Node 22.18 or newer runs the
TypeScript files directly).

**The source.** Most commands take a `[source]` argument. It is one of these:

- a pull request URL, such as `https://github.com/acme/weather-app/pull/42` (GitHub Enterprise URLs work too);
- the short form `acme/weather-app#42`;
- the path of a local git repository. The default is `.`. A name that exists on disk is always read as a
  path.

For a local repository, `--base` and `--head` choose the range. Only committed changes count. Uncommitted
changes are never included. For a pull request, MergeStory reads the change through the GitHub API and
clones nothing. Passing `--base` or `--head` with a pull request is an error.

To explain a change that spans several repositories in one video, give `--source` once for each of them
instead of `[source]`. See [Several sources](#several-sources).

A local repository is read only when a `.git` entry names it: a normal clone, a linked work tree or a
submodule. MergeStory does not run inside a bare repository (a work tree of one is fine), or in a
repository that sits inside a checked-out folder, because its settings can name programs for git to
run. A repository in `$MERGESTORY_HOME/work` is refused for the same reason: a coding agent may write
there without asking. That folder is recognised under every name it has on disk.

**What is read and written.** MergeStory never writes into the repository it explains. Every run writes
one folder, described in [Run folders](#run-folders). A run folder inside the repository is refused.

**Stop a run.** The first Ctrl+C stops the run cleanly and the exit code is 130. A second one quits at once.

**Colors.** Output is plain text when it is not a terminal. `NO_COLOR` turns colors off. `FORCE_COLOR` turns
them on.

### Global options

These work with every command, before or after the command name.

| Flag | What it does |
|---|---|
| `--json` | Print one JSON object on stdout and nothing else. Logs go to stderr. See [JSON output](#json-output). |
| `--log-level <level>` | How much to log on stderr: `debug`, `info` (default), `warn`, `error` or `silent`. Environment variable: `MERGESTORY_LOG_LEVEL`. |
| `--log-format <format>` | `pretty` (default) or `json`. Environment variable: `MERGESTORY_LOG_FORMAT`. |
| `-q, --quiet` | Log errors only. Same as `--log-level error`. |
| `-V, --version` | Print the version. |
| `-h, --help` | Show help. |

A flag you give beats an environment variable, and an environment variable beats the config file. There is
no flag for the config file: set `MERGESTORY_CONFIG`, or use `$MERGESTORY_HOME/config.json`. See
[configuration.md](configuration.md#where-settings-come-from). The `--config` option was removed in 1.1.0.

### Context flags

`generate`, `analyze` and `validate` take the same flags for what only you know. They make the video more
accurate, because the engine can quote them as evidence.

| Flag | What it does |
|---|---|
| `--task <text>` | The original task, in a few sentences. At most 64 KB. It becomes evidence `TASK`. |
| `--task-file <file>` | Read the task from a file. At most 64 KB. Use either `--task` or `--task-file`, not both. |
| `--notes-file <file>` | Notes about your decisions, edge cases and what to review. At most 64 KB. It becomes evidence `NOTES`. |
| `--tests-file <file>` | Test results you really ran, as a JSON array. At most 256 KB. See below. They become `T1`, `T2`, and so on. |
| `--repro-file <file>` | The steps that show the bug, as a JSON object. At most 64 KB. See below. They become `REPRO`, and `REPRO.1`, `REPRO.2`, and so on for the steps. |
| `--screenshot <spec>` | A real screenshot, written as `<path>[:<caption>[:before or after]]`. You can repeat the flag. They become `SS1`, `SS2`, and so on. |
| `--screenshots-dir <dir>` | A folder of real screenshots: every `.png`, `.jpg` and `.jpeg` file in it, in name order. Give it once. They become `SS` ids after those of any `--screenshot`. An optional `captions.json` in the folder gives a caption and a side. See below. |
| `--recording <spec>` | A real screen recording, written as `<path>[:<caption>[:before or after]]`. You can repeat the flag. They become `RC1`, `RC2`, and so on. |
| `--redact <file>` | A JSON file of regions to hide in your screenshots and recordings. At most 64 KB. See "Hidden regions" below. |
| `--log <spec>` | A real log, written as `<file>[:<caption>]`. You can repeat the flag. They become `L1`, `L2`, and so on. A range of lines is `L1.120-140`. |

- **Test results.** Each entry has `command`, `passed` and `summary`, and may have `source` (`agent`, `ci` or
  `user`; the default is `agent`) and `log` (see below). Example:
  `[{"command": "npm test", "passed": true, "summary": "42 passed"}]`.
  Any other field is an error, so a typo such as `pass` never turns into a made-up result. MergeStory shows
  results as you report them and never runs tests. Only the first 10 entries are used, and a warning says
  so. A result with `source` set to `ci` is what lets a line say "CI is green". A result may also have
  `"log": "L1.120-140"`, the lines of a `--log` file that hold its output. It must be a valid log id of the
  same command, or the command stops with a usage error that names the entry and the id. `evidence.md`
  shows it next to the result.
- **Reproduction.** The steps that show the bug, written by the person who saw it:
  `{"title": "...", "environment": "...", "steps": [{"text": "...", "screenshot": "SS1", "result": "bug"}]}`.
  `title` is 1 to 120 characters. `environment` is optional, at most 200 characters, for example the browser.
  `steps` has 1 to 12 steps. A step has `text` (1 to 200 characters) and may have `screenshot` (an id such as
  `SS1`) or `recording` (an id such as `RC1`), not both, because a step shows one picture. It may also have
  `result`: `expected`, `actual`, `bug` or `fixed`. The id must belong to a screenshot or recording that you
  passed to the same command. Any other field, a wrong type, an empty text or an id that was not passed is an
  error that names the step. The reproduction is the author's account, not a check of the code. A line that
  cites it says so ("the reproduction shows ..."). A video shows the steps in a `repro` scene (see
  [storyboard.md](storyboard.md#visuals)). MergeStory never runs the steps.
- **Screenshots.** PNG or JPEG, checked by content and not by file name. At most 4 MB and 40 megapixels. At
  most 6 are used unless you raise the setting [`inputs.maxScreenshots`](configuration.md) (from 0 to 12); the
  first ones are used and a warning says so. A file that is not a picture, is too large or has a
  credentials-like name is refused at once. A picture wider than 2560 pixels is made 2560 pixels wide when
  the video is made, so a full-page capture does not slow the render. FFmpeg does it, and the file itself is
  never changed. This happens before any speech is paid for. If a picture cannot be made smaller, the run
  stops and names the picture. `analyze` and `validate` do not change any picture.
  MergeStory does not look inside a picture: a secret or an e-mail address that shows in a screenshot shows
  in the video. Hide such parts with `--redact`, and check a capture before you pass it.
- **A folder of screenshots.** `--screenshots-dir <dir>` takes every file in the folder that ends in `.png`,
  `.jpg` or `.jpeg` (any letter case), sorted by name. Sub-folders and other files are ignored. Each file is
  checked like a `--screenshot` file. Pictures from `--screenshot` come first, in the order you gave them,
  then the pictures of the folder, so the ids of a command that only adds the folder do not change. A picture
  gets its file name without the ending as its caption. An optional `captions.json` in the folder changes
  that: `{"after.png": {"caption": "The basket after the fix", "side": "after"}}`. `side` is `before` or
  `after`, or left out. A key that is not a picture in the folder, any other field, a wrong `side` and a
  caption that is not text are errors. A folder that does not exist is an error. An empty folder is fine.
  The commands that `analyze` prints repeat the flag with an absolute path.
- **Recordings.** MP4 (H.264) or WebM (VP8 or VP9), checked by content with `ffprobe` and not by file name.
  A QuickTime (`.mov`) or Matroska (`.mkv`) file with one of these three codecs works too.
  The sound may be AAC, MP3, Opus or Vorbis, and is never used. A file with another kind of track is refused.
  A recording must be at least 0.2 seconds long, with a picture of at most 40 megapixels. The defaults are at
  most 4 recordings, each at most 50 MB and 60 seconds; the first ones are used and a warning says so. A
  file that cannot be read, or that is too large or too long, is refused at once, before any speech is paid
  for. Change the limits with the `inputs` [settings](configuration.md#inputs-inputs). `analyze` and
  `validate` need `ffprobe` only when you pass a recording; `generate` always needs FFmpeg and `ffprobe`.
  Use only recordings that were really captured: MergeStory never makes one up. It does not look inside a
  recording: a secret or an e-mail address that shows in it shows in the video, and in the pictures that
  the run folder keeps in `recording-frames/`. Hide such parts with `--redact`, and check a capture before
  you pass it.
- **Hidden regions.** `--redact <file>` covers parts of your screenshots and recordings before anything is
  kept. The file is JSON, at most 64 KB, given once: an object whose keys are ids of this command (`SS1`, `RC2`, and so
  on), each with a list of at most 20 regions, for example
  `{"SS2": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}], "RC1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}]}`.
  `x`, `y`, `w` and `h` are fractions (0 to 1) of the whole picture as a player shows it: upright, before
  any `zoom` of a storyboard, before any scaling. A region that reaches outside the picture is cut to it.
  A region of a recording is hidden in every frame of the clip. It cannot be limited to a part of the
  clip: a region with `from` or `to` is an error. Each region is covered by one opaque block: a dark grey fill (`#262626`) inside a light grey edge
  (`#b0b0b0`), so it shows on a dark picture and on a light one. No pixel of the picture under it is kept,
  so the cover is the same whatever was under it, also in a picture with transparency. It is not a blur,
  because a blurred or pixelated text can sometimes be read back. FFmpeg does this: a screenshot is hidden
  when it is loaded for the video, before it is made smaller if it is wider than 2560 pixels, and a
  recording in every frame that is cut from it. The video, the render
  plan and the files in `recording-frames/` hold only the hidden picture; the original exists only in your
  own file. A scene with a hidden region gets the badge "Sensitive data masked".
  The file is checked strictly, and an error stops the run, for a screenshot before any speech is paid
  for. Nothing is skipped. These are errors: an id that
  this command does not have (also one that the limits dropped), an unknown field, a value that is not a
  list, more than 20 regions for one capture, a number that is missing or not finite, `w` or `h` of 0 or
  less, a region with `from` or `to`, a region with no part inside the picture, an id or
  a field given twice, a backslash anywhere in the file (no value needs one), `--redact` given twice, a
  screenshot with hidden regions that is stored turned (a JPEG or PNG with an EXIF orientation: save it
  upright first), and FFmpeg failing to hide a region. A region smaller than 2 pixels grows to 2. MergeStory finds nothing by itself: it hides only the regions that you
  name. `analyze`, `validate` and a dry run only check the file. A storyboard cannot ask for hiding or
  undo it, and the HTTP API takes no such file.
- **Logs.** A real log: the output of a run, a test or a command that really happened. It must be UTF-8
  text. A file with a NUL byte, or one that is not valid UTF-8, is refused. Line ends are turned into one
  kind, and the colour and cursor codes of a terminal are removed, so a log copied from a terminal reads
  cleanly. Hidden and control characters are removed too, and a log with nothing left to read is
  refused like an empty file. At most 4 logs, each at most 256 KB; the first ones are used and a warning
  says so. A file that is too large is refused from its size, before it is read. The lines are numbered
  from 1. `L1` is the whole log, `L1.120-140` is lines 120 to 140, and `L1.120` is one line. A range must lie inside the log and
  spans at most 200 lines. A narration line can cite a range, and a range that is not valid is removed like
  any unknown id. `evidence.md` lists each log with its number of lines and shows a masked excerpt: the
  first 30 lines, the last 30 lines, and up to 40 lines with `error`, `fail`, `exception`, `assert`, `warn`,
  `panic` or `traceback` that are not shown yet, with one line before and after each. Each line is cut to
  200 characters. When the pack is full, the excerpt gets shorter, like the other sections: first 10 lines
  from each end and 15 lines with a keyword, then 5 and 5. With `privacy.llmContext` set to `minimal` the
  excerpt is left out. The video shows a log in the `log` visual, labelled "Real output". Secrets and
  e-mail addresses are masked in every line that is shown or written, as they are in code. Use only
  output that was really produced: MergeStory never makes one up. The offline storyboard does not show logs.
- **Safety.** A file that looks like a credentials file (`.env`, a key file) is refused. Text that looks like
  a secret is masked, and a warning says how many values were masked. A text with more than 1,000 letters,
  digits, `_`, `.` or `-` in a row is refused, because scanning it for secrets would take too long.

## Several sources

One video can explain a change that lives in more than one repository. The use case is a fix that works only
when two pull requests are merged together. `generate`, `analyze` and `validate` take `--source` for this. The
`agent` commands do not: they keep one source, and `--source` is refused there as an unknown option.

```
mergestory analyze --source ./orders-api:main..fix/total --source ./storefront
mergestory validate storyboard.json --source acme/orders-api#12 --source acme/storefront#7
mergestory generate --source acme/orders-api#12 --source acme/storefront#7 --storyboard storyboard.json
```

**The form.** `--source <repo>[:<base>..<head>]`, repeated once for each source, at most 4 times. `<repo>` is
what `[source]` takes: the path of a local repository, a pull request URL or `owner/repo#123`. The range
is for a local repository. It is split off at the last colon, and only when the text after that colon has the
form `<base>..<head>`, where each side is empty or made of the characters of a git ref. So a URL or a Windows
drive letter is never read as a range. `main..` and `..fix/x` are fine: the side that is missing takes the
default of `--base` and `--head`. A range together with a pull request is an error, as `--base` is.
A single `--source` does exactly what the `[source]` argument does.

**Letters and folders.** Every source is read and analysed on its own, as if it were the only one. Then they
are joined into one change that looks like a repository with one top folder for each source. The sources are
sorted by the host, the owner and the name of the repository, then by the pull request number, then by the
head commit. The first one is `A`, then `B`, `C` and `D`. The order of the flags does not matter, so
`analyze`, `validate` and `generate` give the same letters. An id that comes from a repository starts with the
letter of its source: `A.F1`, `A.F1.H2`, `B.S3`, `A.PR`. Ids that you supplied (`TASK`, `NOTES`, `T1`, `REPRO`,
`SS1`, `RC1`, `L1`) keep their names. A path starts with the folder of its source, which is the name of the repository with
every character other than letters, digits, `.`, `_` and `-` turned into `-`. When two repositories have the
same name, the later one gets `-2`, then `-3`: `orders-api/src/total.js`, `storefront/src/total.js`.
`evidence.md` lists every source with its letter and its folder. The closing card, the watch page and the
titles that publishers get name every repository and every change (`orders-api #3 + storefront #7`). The first
title card of the storyboard must name every pull request, with its repository name and `#<number>`: when it
does not, `validate` warns (`title-missing-source`) and sets the kicker to those names if they fit.

**What is refused.** All of these are usage errors (exit code 2) that stop the run before any video is made:

- `--source` together with the `[source]` argument, `--base` or `--head`. Give the range inside each source.
- More than 4 sources.
- The same source twice (the same repository at the same commits).
- `--out` inside any of the local repositories.
- `--comment` and `--update-description` on the command line. Nothing is posted to a pull request when there
  are several sources, so post the link on each pull request yourself. When only the configuration asks for
  it, the run goes on, posts nothing and adds one warning. In a real run the warning names the repositories and their changes.

A source with no changes is an error that names that source.

**A storyboard is needed.** The free offline storyboard knows one repository only. With several sources and
no model set up, `generate` stops with a usage error. Run `analyze` with the same `--source` flags, write the
storyboard as `AUTHORING.md` says, and give it to `generate --storyboard`. When a model writes the storyboard
and the storyboard fails its checks, the run fails with the reasons: there is no fall back to the offline
storyboard. `analyze` and `validate` work with several sources. The commands that `analyze` prints repeat
every `--source`, with an absolute path for each local repository.

**Not in this version.** The `agent` commands, the [HTTP API](api.md) (it takes one `source`), relationships
between repositories that the analysis finds by itself (an author can still draw the edge in an `architecture`
visual), posting to several pull requests, and the offline storyboard for several sources.

## `mergestory generate`

```
mergestory generate [source] [flags]
```

Makes a video. In order, it reads the change and analyses it. Then it gets a storyboard: one you give it, one a
model writes, or the free offline one. It checks every claim and every line of code, narrates and renders.
Last, it copies the result to the place you chose and, when you ask, posts the link on the pull request. The
default run calls no paid service and sends nothing anywhere. With `--dry-run` it stops after the check and prints a
plan. See [architecture.md](architecture.md#pipeline) for the stages.

**Source.** `[source]` is described under [The basics](#the-basics).

| Flag | What it does | Default |
|---|---|---|
| `--base <ref>` | Local repository: the older side of the change. | the merge base of `HEAD` and the default branch |
| `--head <ref>` | Local repository: the newer side of the change. | `HEAD` |
| `--source <repo>[:<base>..<head>]` | One video for a change in several repositories. Repeat it, up to 4 times. Not together with `[source]`, `--base` or `--head`. See [Several sources](#several-sources). | none |

**Context.** `--task`, `--task-file`, `--notes-file`, `--tests-file`, `--repro-file`, `--screenshot`,
`--screenshots-dir`, `--recording`, `--redact` and `--log`. See [Context flags](#context-flags).

**Style and length.**

| Flag | What it does | Default |
|---|---|---|
| `--style <style>` | How technical the narration is: `technical`, `product` or `hybrid`. | `hybrid` |
| `--quality <preset>` | `draft` (720p, 24 fps), `standard` (1080p, 30 fps) or `high` (1080p, 60 fps). | `standard` |
| `--max-duration <sec>` | The longest video, from 20 to 600 seconds. Before narration, MergeStory drops scenes and lines, least important first, until the estimated length fits. The mission and review scenes always stay. The real voice may run a little over, and a warning says so. | 150 |
| `--duration <sec>` | A target length, from 20 to 600 seconds. | adapts to the size of the change |
| `--language <code>` | The narration language, for example `en`. The free Kokoro voice and the offline storyboard are English only. The check that removes claims such as "all tests pass" reads English only. | `en` |
| `--theme <theme>` | The look of the video: `midnight`, `paper`, `high-contrast`, `terminal`, a theme of yours in `~/.mergestory/themes`, or the path of a theme folder. `dark` and `light` still work: they are `midnight` and `paper`. See [themes.md](themes.md). | `midnight` |
| `--allow-low-contrast` | Use a theme that fails the contrast check, with a warning instead of an error. | off |

**Providers.** The defaults call no paid service and keep everything on this machine.

| Flag | What it does | Default |
|---|---|---|
| `--llm <provider>` | Who writes the storyboard: `none` (the free offline storyboard), `anthropic`, `openai` or `openai-compatible`. Paid providers need their key in the environment. | `none` |
| `--model <name>` | The model. | `claude-haiku-5-5` for `anthropic`, `gpt-6-luna` for `openai`. `openai-compatible` has no default. |
| `--llm-base-url <url>` | The address of an OpenAI-compatible server on this machine, for example `http://localhost:11434/v1`. The flag takes only `localhost`, `127.x.x.x` or `::1`. For a server on another machine, set `MERGESTORY_LLM_BASE_URL` or `llm.baseUrl` in the config file. No credentials in the URL. | none |
| `--tts <provider>` | Speech: `auto`, `kokoro`, `say`, `openai`, `elevenlabs` or `none`. `auto` only picks a free local voice: Kokoro for English (installed once on the first run), otherwise Kokoro if installed, then macOS `say`, then captions only. `say` and `none` never install anything. | `auto` |
| `--voice <name>` | The voice name for the speech provider. | the provider's own voice |
| `--publish <provider>` | Where the finished video goes: `local` (a folder on this machine), `s3` (S3-compatible storage), `youtube` (your channel), `drive` (your Google Drive) or `none` (nowhere). | `local` |
| `--visibility <visibility>` | Who can open an S3 link: `private` (signed, expires in 7 days at most), `protected` (permanent, behind your sign-in proxy) or `public` (permanent, open to anyone). For Google Drive: `private` (only you), `protected` (your Google Workspace organization) or `public` (anyone with the link). | `private` |
| `--comment` | Post one comment with the video link on the pull request, or update it. | off |
| `--update-description` | Add or update a section with the link in the pull request description. | off |
| `--budget <usd>` | The most this run may spend on paid model and voice calls, in US dollars (0 to 100), checked against estimates. See [configuration.md](configuration.md#budget). | 0.25 |

`--comment` and `--update-description` need a pull request as the source and a video that is not only on
this machine (`--publish s3`, `youtube` or `drive`). Otherwise MergeStory skips the update and adds a warning. See
[hosting.md](hosting.md) for the storage options, [youtube.md](youtube.md) for YouTube and [drive.md](drive.md)
for Google Drive.

**Run.**

| Flag | What it does |
|---|---|
| `--storyboard <file>` | Use a storyboard you wrote instead of generating one. At most 1 MB. It goes through the same checks as every storyboard. If it has errors, the command stops with exit code 3 and prints up to 40 of them under the message, in the form that [`validate`](#mergestory-validate) uses. A list of 40 ends with a line that says more problems may follow. `validate` shows every error, except that it lists at most 40 schema problems and says how many more there are. See [storyboard.md](storyboard.md). |
| `--dry-run` | Show the plan: the scenes, the estimated length, a high estimate of the cost, and what a real run would send. It sends, renders and publishes nothing. It still reads the pull request from GitHub and writes the analysis files to the run folder. |
| `--async` | Run in the background and print a job id. See [`status`](#mergestory-status). The settings are checked first, so a typo is reported at once. |
| `--out <dir>` | Write the run files to this folder instead of under the MergeStory home. It must be outside the repository being explained and outside `$MERGESTORY_HOME/work`. An existing folder must not be or hold a symbolic link. |
| `--no-cache` | Do not use or fill the cache of speech clips and model answers. |
| `--no-captions` | Leave the captions out of the picture. The `captions.vtt` file is still written. |
| `--music <file>` | Background music (MP3, WAV, M4A, FLAC or OGG). It is mixed in quietly and lowered while someone speaks. The file must exist. |
| `--max-render-seconds <sec>` | Stop when rendering takes longer than this many seconds (1 to 86400). The run then ends with exit code 8 (`RENDER_TIMEOUT`) and writes no `video.mp4`. The limit covers the render stage only, which draws and encodes the frames. Reading the change and making the voice come before it and are not counted. Without the flag, the setting `render.maxSeconds` applies, and without that there is no limit. |

**Examples.**

```bash
mergestory generate https://github.com/acme/app/pull/42
```

```bash
mergestory generate . --base main --dry-run
```

```bash
mergestory generate acme/app#42 --llm anthropic --budget 0.10
```

```bash
mergestory generate . --storyboard storyboard.json --tests-file tests.json
```

**Output.** A block that shows the video, the watch page, the run folder, the cost, what was sent and any
warnings. With `--json` it prints the [result object](#the-result-of-generate-and-publish). With
`--dry-run` it prints the [plan object](#the-plan-of-a-dry-run). With `--async` it prints the job id, and
with `--json` it prints `{"ok": true, "id": "<job id>", "status": "queued"}`.

**Exit codes.** See [Exit codes](#exit-codes). One case is worth knowing: when you asked for a comment or a
description update and GitHub refused it, the video is already published and the result is printed in full
(`ok` is `true`), but the exit code is 5. The `notify` field then shows `commentUrl: null` and
`descriptionUpdated: false`.

## `mergestory publish`

```
mergestory publish <run> [flags]
```

Uploads a video that you made earlier, and can post it on the pull request. Nothing is rendered, narrated or
sent to a model. Use it to look at the local video first and share it only when you are happy:

```bash
mergestory publish 20261104-101500-a1b2 --publish s3 --visibility protected --comment
```

`<run>` is the run folder (the `runDir` of a result) or the run id. A run id is looked up under
`$MERGESTORY_HOME/runs`. The folder must hold `publish-input.json`, which `generate` writes when the video is
rendered. A folder inside `$MERGESTORY_HOME/work` is refused: it holds drafts, not a run. The result is the earlier result with the new `publish` and `notify` parts. Its `cost` and `egress`
add up what was spent and sent before.

| Flag | What it does | Default |
|---|---|---|
| `--publish <provider>` | `local`, `s3`, `youtube` or `drive`. | `publish.provider` from the environment or config file, otherwise `local` |
| `--visibility <visibility>` | `private`, `protected` or `public`. S3 and Google Drive. | `private` |
| `--comment` | Post or update the comment on the pull request. | off |
| `--update-description` | Add or update the section in the pull request description. | off |

- If the provider is `none`, the command stops with a usage error: there is nowhere to publish to.
- Only the video, the poster and the captions of the run folder are uploaded. A file that is a link to
  somewhere outside the folder is refused (exit code 7).
- Before MergeStory makes a link that anyone can open (`public` S3 links, or a YouTube video that is not
  `private`), it asks GitHub again whether the repository is public. A note in the run folder that says
  "public" is not believed on its own.
- If the pull request update fails, the video stays published. Run the command from the warning again to
  retry. It uploads the video again.

**Examples.**

```bash
mergestory publish 20261104-101500-a1b2 --publish s3
```

```bash
mergestory publish ~/.mergestory/runs/20261104-101500-a1b2 --publish s3 --visibility protected --comment
```

```bash
mergestory publish ./my-run --publish youtube
mergestory publish ./my-run --publish drive --visibility protected --comment
```

## `mergestory analyze`

```
mergestory analyze [source] [flags]
```

Analyses a change and writes the files you need to author a storyboard yourself. No model is
called. This is the first step for a coding agent. See [storyboard.md](storyboard.md#how-an-agent-writes-one).

| Flag | What it does |
|---|---|
| `--base <ref>`, `--head <ref>` | The range of a local repository. See [`generate`](#mergestory-generate). |
| `--source <repo>[:<base>..<head>]` | A source of a change in several repositories; repeat it. See [Several sources](#several-sources). |
| `--task`, `--task-file`, `--notes-file`, `--tests-file`, `--repro-file`, `--screenshot`, `--screenshots-dir`, `--recording`, `--redact`, `--log` | See [Context flags](#context-flags). They decide which evidence ids exist. |
| `--out <dir>` | Write the files here instead of under the MergeStory home. It must be outside the repository being explained. An existing folder must not be or hold a symbolic link. |

It writes four files into the output folder:

| File | What it holds |
|---|---|
| `analysis.json` | The analysis: file roles, components, symbols, risks and the evidence index. |
| `evidence.md` | The evidence pack: every fact a storyboard may cite, each with an id. Text from the pull request inside it is untrusted data. |
| `AUTHORING.md` | The guide for writing a storyboard, with the exact `validate` and `generate` commands for this change. It names every field and every allowed value of a storyboard. |
| `storyboard.schema.json` | The JSON Schema of a storyboard. The guide covers what a writer needs, so this file is for looking up a schema error. |

The output ends with the next steps. If you passed context flags, it reminds you to give the same flags to
`validate` and `generate`.

## `mergestory validate`

```
mergestory validate <storyboard> [source] [flags]
```

Checks a storyboard against a change without rendering anything, without any paid call and without writing
files. It runs the same checks that `generate --storyboard` runs. Give it the same source, refs and
context flags as `analyze`. Otherwise the ids `TASK`, `NOTES`, `T1`, `REPRO`, `SS1`, `RC1` and `L1` do not
exist, and the lines that cite only them are removed. A range of a log, such as `L1.120-140`, is valid when the
log was passed and the range lies inside it.

| Flag | What it does | Default |
|---|---|---|
| `--base <ref>`, `--head <ref>` | The range of a local repository. | as for `generate` |
| `--source <repo>[:<base>..<head>]` | A source of a change in several repositories; repeat it, as for `analyze`. See [Several sources](#several-sources). | none |
| `--task`, `--task-file`, `--notes-file`, `--tests-file`, `--repro-file`, `--screenshot`, `--screenshots-dir`, `--recording`, `--redact`, `--log` | See [Context flags](#context-flags). | none |
| `--max-duration <sec>` | The longest video, from 20 to 600 seconds. Validation only warns when making the video would have to drop scenes. | 150 |
| `--duration <sec>` | A target length, from 20 to 600 seconds. | adapts |
| `--language <code>` | The narration language. | `en` |

It prints `errors` (these block rendering), `warnings` (something was removed or replaced) and `fixes` (every
change made automatically). The exit code is 0 when there are no errors, even if there are warnings, and 3
when there is at least one error. [storyboard.md](storyboard.md#what-the-checks-do) explains each code.

When there are errors, it also writes one line to the log on stderr: the number of errors and how many of
each code, for example `warn: [validate] Storyboard has errors: 3 (uncited-line 2, schema 1)`. The errors
themselves are only in the result on stdout.

## Commands for coding agents

A coding agent can be steered by text in a pull request. So the general commands, with their flexible
flags, should run only with your approval. The `mergestory agent` commands are the safe part to pre-approve.
Whatever arguments they get:

- They read the current repository (through git), their work folder and MergeStory's own files: the
  settings, the cache and the voice.
- They write only in the MergeStory home (the work folder, the run folder, the cache and the one-time voice
  install) and in the system's temporary folder.
- They start only the programs MergeStory itself uses: git, `gh`, FFmpeg, a browser, the local voice and,
  once, npm to install that voice. No argument can name a program.
- They never upload, comment or spend money.
- The only hosts they contact are GitHub, to read a pull request of the current repository, and the hosts of
  the one-time voice download.

This holds for the plain command. A variable set in front of it, such as `MERGESTORY_CONFIG=<file>`, changes
what it does, so do not pre-approve that form.

```
mergestory agent analyze  [source] --name <name> [--base <ref>] [--head <ref>]
mergestory agent validate [source] --name <name> [flags]
mergestory agent render   [source] --name <name> [flags]
mergestory agent frames   [source] --name <name>
```

**The work folder.** `--name` is required. It is 1 to 64 characters: `a-z`, `0-9`, `.`, `_` and `-`, and it
starts with a letter or digit. The work folder is `$MERGESTORY_HOME/work/<name>` (by default
`~/.mergestory/work/<name>`). It is created with mode 0700. The files have fixed names, all directly in the work
folder:

| File | Written by | What it holds |
|---|---|---|
| `task.md`, `notes.md`, `tests.json` | the agent | The task, the notes and the test results. Same limits and masking as `--task-file`, `--notes-file` and `--tests-file`. Every agent command reads them, so the evidence ids match. |
| `screenshots/` | the agent | Screenshots: every `.png`, `.jpg` and `.jpeg` file in it, sorted by name, becomes `SS1`, `SS2`, and so on. An optional `screenshots/captions.json` works as the one for recordings: `{"after.png": {"caption": "After the fix", "side": "after"}}`. Same limits and checks as `--screenshot`. |
| `repro.json` | the agent | The steps that show the bug, with the shape and the limits of `--repro-file`. Every agent command reads it. A step can use a screenshot from `screenshots/` or a recording from `recordings/`, by its id (`SS1`, `RC1`). |
| `recordings/` | the agent | Screen recordings: every `.mp4`, `.m4v`, `.mov`, `.webm` and `.mkv` file in it, sorted by name, becomes `RC1`, `RC2`, and so on. An optional `recordings/captions.json` gives a caption and a side: `{"clip.mp4": {"caption": "Before the fix", "side": "before"}}`. `side` is `before` or `after`, or left out. A key that is not a file in the folder, and any other field, is an error. Same limits and checks as `--recording`. |
| `redact.json` | the agent | Regions to hide in the screenshots and recordings, in the format of `--redact`: keys are `SS1`, `RC1`, and so on, by the order of the files in `screenshots/` and `recordings/`. Same checks. Every agent command reads it, so the video never shows what it hides. |
| `logs/` | the agent | Logs: every `.log` and `.txt` file in it, sorted by name, becomes `L1`, `L2`, and so on. An optional `logs/captions.json` gives a caption: `{"run.log": {"caption": "The check after the fix"}}`. A key that is not a file in the folder, and any other field, is an error. Same limits and checks as `--log`. |
| `storyboard.json` | the agent | The storyboard. |
| `AUTHORING.md`, `evidence.md`, `analysis.json`, `storyboard.schema.json` | `agent analyze` | As for [`analyze`](#mergestory-analyze). `AUTHORING.md` shows the `agent validate` and `agent render` commands. |

The commands refuse to work when the work folder, or the `work` folder above it, is a symbolic link, or
when the work folder holds a symbolic link at any depth. The agent commands never take a screenshot, a recording, a log or a region as a flag. They read `screenshots/`, `recordings/` and `logs/` in the work folder. `agent validate` creates nothing in the work folder, and `agent render` creates only `last-run.json` in a work folder that exists.

**The source.** The agent commands only explain the repository of the current folder. Leave the source out, or
give `.`, for the local branch range (`--base`, `--head`). A pull request (URL or `owner/repo#123`) is accepted
only when its repository is one of the git remotes of the current repository, on github.com or on the host of
`github.apiUrl`. Anything else is a usage error. For another repository or folder, run `mergestory analyze`.

**What they refuse.** `--out`, `--task`, `--task-file`, `--notes-file`, `--tests-file`, `--repro-file`,
`--storyboard`, `--screenshot`, `--screenshots-dir`, `--recording`, `--redact`, `--log`, `--music`, `--llm`, `--model`, `--llm-base-url`, `--publish`, `--visibility`, `--comment`,
`--update-description`, `--budget` and `--async`. Of the global options, `--json`, `--log-level`,
`--log-format` and `-q` apply.

## `mergestory agent analyze`

```
mergestory agent analyze [source] --name <name> [--base <ref>] [--head <ref>]
```

Like [`analyze`](#mergestory-analyze), but it writes the four files into the work folder. `--name` names the
work folder; `--base` and `--head` set the range of the local repository. With `--json` it prints
`{"ok": true, "name", "workDir", "files": {"guide", "evidence", "analysis", "schema"}, "summary"}`, with the
same `summary` as `analyze`.

## `mergestory agent validate`

```
mergestory agent validate [source] --name <name> [flags]
```

Like [`validate`](#mergestory-validate), for `storyboard.json` in the work folder. It fails when there is no
`storyboard.json`. Flags: `--name`, `--base`, `--head`, `--max-duration`, `--duration` and `--language`, as
for `validate`. It prints the same result and ends with the same exit codes as `validate` (3 when there is an
error).

## `mergestory agent render`

```
mergestory agent render [source] --name <name> [flags]
```

Makes the video on this machine from `storyboard.json` in the work folder. Without that file the free offline
storyboard is used. Whatever the environment or the config file says, it uses no model, a free local voice
(`auto` unless you choose one), the `local` publish target, no comment, no description update and no music.
The run folder is `$MERGESTORY_HOME/runs/<run id>`, never the work folder. The paths of `ffmpeg` and the
browser still come from your settings.

| Flag | What it does | Default |
|---|---|---|
| `--name <name>` | The work folder. | required |
| `--base <ref>`, `--head <ref>` | The range of a local repository. | as for `generate` |
| `--style`, `--quality`, `--max-duration`, `--duration`, `--language` | As for `generate`. | as for `generate` |
| `--theme <name>` | A theme name, as for `generate`. A path is refused. | `midnight` |
| `--tts <provider>` | `auto`, `kokoro`, `say` or `none`. | `auto` |
| `--voice <name>` | The voice name for the speech provider. | the provider's default |
| `--dry-run` | Show the plan and render nothing. | off |
| `--no-cache` | Do not use or fill the cache. | cache on |
| `--no-captions` | Leave captions out of the video. | captions on |

It prints the same result and ends with the same exit codes as `generate`. After a real render (not
`--dry-run`) it writes `last-run.json` in the work folder, which holds the run folder, so that `agent frames`
finds the video.

## `mergestory agent frames`

```
mergestory agent frames [source] --name <name>
```

Takes still pictures from the latest `agent render` of the work folder, so that you can look at the video
before you share it. It writes `frames/` in the work folder (and replaces what was there): `contact-sheet.jpg`,
one small frame for every 2 seconds, tiled (for a video longer than 48 seconds, one for every
`ceil(length / 24)` seconds), and `scene-01.jpg`, `scene-02.jpg`, and so on: one full-size frame for each
scene, taken in the middle of the scene's last narration beat (the middle of the scene when it has no beat).
It uses the FFmpeg that the other commands use. It fails with exit code 2 when the work folder has no
rendered video yet. With `--json` it prints
`{"ok": true, "name", "framesDir", "contactSheet", "sheetStepSec", "frames": [{"sceneId", "title", "timeSec", "file"}]}`.

## `mergestory schema`

```
mergestory schema
```

Prints the JSON Schema of a storyboard on stdout. `analyze` writes the same schema to
`storyboard.schema.json`.

## `mergestory doctor`

```
mergestory doctor [--online]
```

Checks that this machine is ready to make videos, and says how to fix what is missing. These are the checks:
Node.js (22.12 or newer), git, FFmpeg and FFprobe, the H.264 encoder, the browser, the free local voice, the
speech provider, the model provider, GitHub access, publishing, the MergeStory home folder and the free disk
space. Each check is `pass`, `warn` or `fail`, with a fix when it does not pass. It names settings and
environment variables and never prints their values.

| Flag | What it does |
|---|---|
| `--online` | Also contact the services you set up: it asks the storage service about the bucket, for protected links it runs the sign-in check, and for Google Drive it shows the organization domain of the account. Without it, nothing is sent over the network. |

The exit code is 1 when any check fails. Warnings do not change it. A config file with a mistake is reported
as a failed `config` check, and the other checks still run with the defaults.

With `--json`, the report also says as data what is on disk for the free voice:
`"kokoro": {"installed", "version", "modelCached"}`. When `installed` and `modelCached` are both `true`, a
run downloads nothing for the voice. See [Unattended runs](#unattended-runs).

## `mergestory setup`

```
mergestory setup [target]
```

Installs optional extras and signs in to services. Without a target it lists them.

| Target | What it does |
|---|---|
| `kokoro` | Installs the free local voice ahead of time, for example in CI. Without it, the first English video installs the voice itself. It waits while another run is installing it. It adds about 400 MB of files under the MergeStory home. It then downloads the speech model from `huggingface.co` (about 90 MB, or about 330 MB for the full-precision model that is the default on Apple Silicon), so that no later run has to download anything for the voice. Set `MERGESTORY_KOKORO_DTYPE` to `q8` (small) or `fp32` (full) to choose, and set it the same way for the runs. English only. No repository content is sent anywhere. |
| `youtube` | Signs in to YouTube once, so videos can be uploaded to your channel. It needs a browser and installs nothing. Without a terminal it runs only when the client id and secret both come from the environment and `CI` is not set. See [youtube.md](youtube.md). |
| `drive` | Signs in to Google Drive once, so videos can be uploaded to your Drive. It asks only for the `drive.file` permission. Same rules as `youtube` without a terminal. See [drive.md](drive.md). |

## `mergestory status`

```
mergestory status <jobId> [--wait] [--timeout <sec>]
```

Shows the state of a background job started with `generate --async`. A job moves from `queued` to `running`
and ends as `succeeded` or `failed`.

| Flag | What it does | Default |
|---|---|---|
| `--wait` | Wait until the job has finished, and log its progress on stderr. | off |
| `--timeout <sec>` | With `--wait`: stop waiting after this many seconds. The command then fails with exit code 1, and the job keeps running. | 900 |

The exit code is 0 unless the job failed. For a failed job it is the exit code of the job's error. If a
background worker dies before the job is done, the job is marked as failed, so nobody waits for it forever.

## `mergestory jobs`

```
mergestory jobs [--limit <n>]
```

Lists recent background jobs, newest first. `--limit <n>` sets how many to show, from 1 to 200 (default 20).
A larger number is an error.

Job files live in `$MERGESTORY_HOME/jobs/<job id>/job.json`. The folder is private, and the files never hold
secrets: a background worker gets its keys from its own environment. A job id is also the id of its run.

## `mergestory serve`

```
mergestory serve [flags]
```

Starts the HTTP API. Jobs run one at a time on this machine. See [api.md](api.md) for the endpoints.

| Flag | What it does | Default |
|---|---|---|
| `--host <host>` | The address to listen on. Anything but a loopback address needs a token. | `127.0.0.1` |
| `--port <port>` | The port to listen on (0 to 65535). | 7171 |
| `--token-env <name>` | The name of the environment variable that holds the API token. It takes a name, never the token itself, so the token stays out of your shell history. | `MERGESTORY_API_TOKEN` |
| `--allow-root <dir>` | A folder that local repositories may live in. You can repeat the flag. Without it, only pull requests are accepted. | none |
| `--allow-host <name>` | Another name accepted in the `Host` header, for a reverse proxy on this machine that passes on the name it was reached by, for example `mergestory.example.com`. Give the name alone, without a scheme, port or path. You can repeat the flag. | none |

The token must be at least 16 characters long, for example the output of `openssl rand -hex 24`.

## `mergestory cache clear`

```
mergestory cache clear
```

Deletes the cache: speech clips (`tts`), model answers (`llm`) and file contents (`files`) under
`$MERGESTORY_HOME/cache`. It never touches runs, jobs, models, plugins or sign-in data. A paid speech or
model provider may bill again for work that was cached.

## `mergestory runs`

```
mergestory runs [--limit <n>]
```

`runs` lists the videos in `$MERGESTORY_HOME/runs`, newest first: run id, date, title, length, where the
video went ("this machine" or the provider) and its link. A folder without a readable `result.json`, such
as the folder of a dry run, is left out. `--limit <n>` sets how many to show, from 1 to 500 (default 20). With `--json` it prints
`{"ok": true, "runs": [{"runId", "runDir", "createdAt", "title", "durationSec", "video", "publish"}]}`,
where `publish` is `{"provider", "watchUrl", "shareUrl", "expiresAt"}` or `null`. `shareUrl` is the link to share, or `null` when the video is only on this machine.

## `mergestory runs delete`

```
mergestory runs delete <run-id...>
mergestory runs delete --older-than <days>
```

Removes the folders of the run ids you give, with everything in them, and the files of the
background jobs that made them, and prints how many bytes were freed. `--older-than <days>`
removes every run and finished job made more than that many days ago (1 to 3650), by the time in
its id; a folder with any other name is kept. Give run ids or `--older-than`, not both. A run that a
job is still making is kept, with its job. An id is refused (exit code 2, nothing deleted
for it) when it is not a plain run id, when the folder is a symbolic link, or when the folder holds none
of `result.json`, `publish-input.json` and `analysis.json`. The other ids are still deleted. With `--json` it prints
`{"ok": true, "deleted": ["..."], "freedBytes": 0}`; when an id is refused, `ok` is `false` and `errors`
lists them. This only removes files on this machine. It does not remove an uploaded video.

## `mergestory theme preview`

```
mergestory theme preview <theme> [--out <dir>] [--allow-low-contrast]
```

Draws sample scenes with a theme and writes the stills and a page that shows them all, `index.html`.
It calls no model, makes no voice and uses no network. `<theme>` is a theme name or the path of a theme
folder, as for `generate --theme`. See [themes.md](themes.md).

| Flag | What it does | Default |
|---|---|---|
| `--out <dir>` | The folder for the stills and the page: an empty folder, or one that an earlier preview made. A folder with other files, or with a symbolic link in it, is refused. | `$MERGESTORY_HOME/previews/<theme>` |
| `--allow-low-contrast` | Draw a theme that fails the contrast check, with a warning. | off |

## `mergestory theme init`

```
mergestory theme init <name> [--accent <color>] [--accent-2 <color>] [--brand <file>] [--logo <file>]
                       [--from <theme>] [--force] [--allow-low-contrast]
```

Makes a theme from your brand colors and saves it as `$MERGESTORY_HOME/themes/<name>/theme.json`, with
your logo next to it when you pass `--logo`. The theme goes through the same checks as any theme before
it is saved. See
[themes.md](themes.md#make-a-theme-from-your-brand-colors).

| Flag | What it does | Default |
|---|---|---|
| `--accent <color>` | The main brand color, for example `"#ff7a1a"`. | the first brand color of `--brand` |
| `--accent-2 <color>` | A second brand color, for labels and highlights. | the next brand color of `--brand`, else the one of `--from` |
| `--brand <file>` | A file with your brand colors (CSS, JSON or a list), up to 1 MB, with colors written as `#hex`, `rgb()` or `hsl()`. Its first color that labels can use on the chosen look becomes the accent, and the next such color of a clearly different hue the second accent. | none |
| `--logo <file>` | Your logo for the top bar and the end card: a still PNG or JPEG file, at most 256 KB and 2048x2048 pixels. It is copied into the theme folder as `logo.png` or `logo.jpg`. See [themes.md](themes.md#add-your-logo). | none |
| `--from <theme>` | The built-in theme to start from: `midnight` or `dark` (a dark theme), `paper` or `light` (a light one), `high-contrast` or `terminal`. | `midnight` |
| `--force` | Replace the `theme.json` of an existing theme with this name. Pass `--logo` again to keep a logo. | off |
| `--allow-low-contrast` | Save a theme that fails the contrast check, with a warning. | off |

One of `--accent` and `--brand` is needed. The name cannot be the name of a built-in theme.

## Run folders

Every run writes one folder: `$MERGESTORY_HOME/runs/<run id>/` (the default home is `~/.mergestory`), or the
folder you give to `--out`. A run id looks like `20261104-101500-a1b2`.

| File | What it holds |
|---|---|
| `analysis.json` | The analysis of the change. |
| `evidence.md` | The evidence pack. Written by `analyze`, and by a run that asks a model for a storyboard. |
| `storyboard.json` | The storyboard that was used, after the automatic fixes and the length trim. |
| `grounding.json` | `groundedClaims`, `fixes` and `warnings` of the checks. |
| `narration/` | One short WAV file for each narration line. Only when the video has a voice. |
| `audio.wav` | The narration track. Not written when the video has no voice and no music. |
| `captions.vtt`, `captions.srt` | The captions. |
| `render-plan.json` | The plan the renderer turned into frames: the real code, tokens, layout and timing. |
| `recording-frames/` | The pictures of the recordings that the video shows, as JPEG files, one folder for each use (`s-<scene number>`, `s-<scene number>.before` and `.after` for the panels of a before-after scene, and `s-<scene number>.step-<step>` for a step of a reproduction). Only when the video shows a recording. A run that takes over this folder removes the pictures of the earlier run. |
| `video.mp4`, `poster.jpg` | The video and its poster image. |
| `watch.html` | The watch page, next to the video. It is the page of `watch/`. It finds `video.mp4` and `poster.jpg` by name and carries the captions itself, so it still plays when you upload it together with those files. |
| `watch/` | The watch page (`index.html`) with copies of the video, poster and captions. Always written. |
| `publish/` | What the `local` publisher wrote, or the folder in `publish.localDir`. |
| `publish-input.json` | What `mergestory publish` needs to upload the run later. |
| `result.json` | The result, as printed. When a run stops before its video is made, and after this folder was made, it holds the error instead (`ok` is `false`). See [Unattended runs](#unattended-runs). |

The folder holds code excerpts, so treat it like the repository, and do not commit it. Delete a run
folder when you no longer need it.

## Unattended runs

A script or an agent that runs MergeStory with nobody watching needs files with fixed names, one place
that says what happened, and a run that cannot go on for ever.

**Fixed names.** Give every run its own folder with `--out <dir>`. A finished run always leaves these
files there: `video.mp4`, `captions.vtt`, `captions.srt`, `watch.html`, `result.json` and, unless the
capture failed, `poster.jpg`. Nothing has to be read from the log.

Upload only the video, the poster, the captions and `watch.html`. `watch.html` plays the `video.mp4` that
lies next to it. Do not upload the rest of the folder: the other files hold code from the change and paths
of this machine. `result.json` is for your script to read, not to share.

**What happened.** The exit code says whether the run worked: see [Exit codes](#exit-codes). `result.json`
says the rest.

- After a run that worked, it is the [result object](#the-result-of-generate-and-publish): `ok` is `true`,
  and it has `durationSec`, `scenes`, `evidenceUsed`, `files`, `warnings` and, in `grounding.fixes`,
  everything the checks changed.
- After a run that stopped before its video was made, it is
  `{"ok": false, "runId", "runDir", "error": {"code", "message", "hint", "details"}}`. That is the error
  that `--json` prints.
- After a run that made the video but could not upload it, or could not update the pull request, it is
  still the result of the finished video: `ok` is `true`, and `publish` or `notify` shows what is
  missing. The exit code is 5, so the exit code is what says that such a run did not fully work.
- A run that fails before its folder is made writes no `result.json`. A wrong flag, a source that cannot
  be read and a change with nothing in it are such failures. So look at the exit code first.
- Use a new folder for every run. A run that starts in a folder that an earlier run used takes the
  folder over once it has read and analysed the change: it removes the earlier `result.json`,
  `publish-input.json`, video, poster, captions and `watch.html`, and their copies in `watch/` and
  `publish/`. So after that point the folder never holds the video of another change, also when the new
  run fails. A run that fails before that point leaves the folder as it was. In a folder that holds no
  earlier run, nothing is removed: a file of yours with one of these names is only replaced when the new
  file is written.
- A dry run writes no `result.json`.

**A time limit.** `--max-render-seconds <sec>`, or the setting `render.maxSeconds`, stops a render that
takes too long. The run ends with exit code 8 (`RENDER_TIMEOUT`). It writes no `video.mp4`, because the
renderer only moves a finished video into the folder. To limit the whole run, stop the process from
outside with `SIGTERM`, as `timeout` does. MergeStory then stops cleanly with exit code 130 and removes
its temporary files. When the video was not made yet, it leaves `ABORTED` in `result.json`. When the stop
comes later, during an upload, `result.json` stays the result of the finished video.

**No download at a bad moment.** A run installs the free voice when it is missing: about 400 MB of
packages and the speech model. In a machine image, install both while you build the image:

```bash
mergestory setup kokoro
```

Then check it once:

```bash
mergestory doctor --json
```

In the report, `kokoro.installed` and `kokoro.modelCached` are both `true` when a run has nothing left to
download for the voice.

**The home folder.** Set `MERGESTORY_HOME` to a folder that the run can write. MergeStory then keeps all
its files there and does not need `HOME`: it works when `HOME` is not set or is empty, when the home
folder cannot be written, and for a user that has no home folder at all. For a user with no home folder,
the MergeStory home also serves as the home folder of the programs that MergeStory starts, such as the
browser. Set `MERGESTORY_BROWSER_PATH` as well, so that the browser is not looked for under a home
folder.

**Containers.** Most containers do not let a user that is not root use the browser's sandbox. The browser
then starts without it, and a warning says so. Running as root does the same without the warning.

## JSON output

With `--json`, stdout holds exactly one JSON object, and logs go to stderr. A failure is also one object, on
stdout, and the exit code is not 0:

```json
{
  "ok": false,
  "error": {
    "code": "GROUNDING_FAILED",
    "message": "The supplied storyboard has 1 problem(s) that block rendering.",
    "hint": "Fix the listed problems and run again. `mergestory validate <storyboard.json> <source>` checks without rendering.",
    "details": {
      "errors": [
        {
          "path": "scenes[0].visual.heading",
          "code": "schema",
          "message": "is required (every field must be present; use null or [] when there is nothing to say)"
        }
      ],
      "warnings": []
    }
  }
}
```

`code` is one of the codes in [Exit codes](#exit-codes). `hint` says what to do. `details` may be `null`.
Everything that is printed has been through the secret redactor. The one exception is a link to the
published video: a signed link stops working without its signature, so it is kept as it is.

`mergestory schema` is the only command that ignores `--json`. It always prints the schema.

### The result of generate and publish

```json
{
  "ok": true,
  "runId": "20261104-101500-a1b2",
  "runDir": "/path/to/run",
  "title": "Retry temporary failures with backoff",
  "summary": "Two sentences for reviewers.",
  "durationSec": 146.5,
  "elapsedSec": 92.4,
  "chapters": [{ "title": "The mission", "startSec": 0 }],
  "scenes": [
    { "id": "s1", "role": "mission", "title": "The mission", "visual": "title", "startSec": 0, "durationSec": 11.2 }
  ],
  "evidenceUsed": ["TASK", "F6.H1", "S12"],
  "storyboardSource": "agent",
  "files": {
    "video": "/path/to/run/video.mp4",
    "poster": "/path/to/run/poster.jpg",
    "captions": "/path/to/run/captions.vtt",
    "captionsSrt": "/path/to/run/captions.srt",
    "storyboard": "/path/to/run/storyboard.json",
    "watchPage": "/path/to/run/watch/index.html",
    "watchHtml": "/path/to/run/watch.html"
  },
  "publish": {
    "provider": "s3",
    "watchUrl": "https://...",
    "shareUrl": "https://...",
    "videoUrl": "https://...",
    "posterUrl": "https://...",
    "captionsUrl": "https://...",
    "expiresAt": "2026-11-11T10:15:00.000Z",
    "visibility": "private",
    "location": "s3://bucket/mergestory/v/<token>/"
  },
  "notify": { "commentUrl": "https://github.com/acme/weather-app/pull/42#issuecomment-1", "descriptionUpdated": false },
  "grounding": { "groundedClaims": 21, "fixes": [], "warnings": [] },
  "cost": { "totalUsd": 0, "budgetUsd": 0.25, "records": [] },
  "egress": [],
  "warnings": []
}
```

| Field | Meaning |
|---|---|
| `scenes` | The scenes as they were rendered: `id`, `role`, `title`, the type of the `visual`, and `startSec` and `durationSec` in the finished video. |
| `evidenceUsed` | Every [evidence id](storyboard.md#evidence-ids) that the video cites or shows, each one once. It tells you whether the video used what you supplied, for example a screenshot. |
| `storyboardSource` | Who wrote the storyboard: `agent` (you passed `--storyboard`), `llm` or `heuristic` (the offline storyboard). |
| `files` | Paths on this machine. `files.poster` is `null` when no poster image was made (for example when the capture failed). The run still succeeds. `files.watchPage` is the page in `watch/`, which has its own copies of the video, the poster and the captions. `files.watchHtml` is the same page next to `video.mp4`. |
| `publish` | `null` when you chose `--publish none`, and in the `result.json` of a run whose upload failed (the exit code is then 5). With the default `--publish local` it is `{"provider": "local", ...}` and the links are `file://` links to files on this machine. A local `publish` has no `expiresAt`, counts as `private` and has `"shareUrl": null`. |
| `publish.visibility` | `private`, `protected`, `public`, or `unlisted` (YouTube's link-only mode). |
| `publish.expiresAt` | When a signed link stops working, or `null` for a link that does not expire. |
| `notify` | `null` unless you asked for a comment or a description update and it was tried. Then it is `{commentUrl, descriptionUpdated}`. |
| `grounding` | How many narration lines cite evidence, every automatic fix, and the warnings. |
| `cost` | `totalUsd`, the `budgetUsd` and one record per paid call, with `provider`, `kind` (`llm`, `tts`, `storage` or `other`), `model`, token or character counts, `costUsd`, and `estimated` (true when the cost comes from a price list and not from a bill), and `priceNote` when no price was known (`assumed`: counted at the fallback rate; `local`: a model server on this machine or a private network, counted as $0). Cached answers cost 0 and have `cached: true`. |
| `egress` | Every outbound transfer: `destination` (a host name), `purpose`, `bytes` and `contains` (for example `video` or `diff`). |
| `warnings` | Things worth knowing, in plain words. |

When `publish` is null or `publish.shareUrl` is null, nothing was shared. Otherwise the link to post or send is `publish.shareUrl`. For the local provider `shareUrl` is `null` and `publish.watchUrl` is a `file://` link that works only on this machine: never post it. A `result.json` written by an older version has no `shareUrl`; there, treat provider `local` as not shared.

### The plan of a dry run

```json
{
  "ok": true,
  "dryRun": true,
  "runId": "20261104-101500-a1b2",
  "runDir": "/path/to/run",
  "title": "Retry temporary failures with exponential backoff",
  "storyboardSource": "heuristic",
  "estimatedDurationSec": 125,
  "scenes": [{ "id": "s1", "role": "mission", "title": "What this change is", "visual": "title" }],
  "providers": { "llm": "none (offline)", "tts": "say", "publish": "local" },
  "estimatedCost": { "totalUsd": 0, "budgetUsd": 0.25, "records": [] },
  "plannedEgress": [],
  "warnings": []
}
```

`providers.llm` is `none (offline)`, `agent-supplied`, or `<provider>:<model>`. A dry run never calls the
model, so with `--llm` it shows the estimate and the offline storyboard stands in for the outline.
`estimatedCost` is a high estimate: it includes each repair attempt (`Est. cost (high estimate)` in the text
output). `warnings` also says when it is over the budget, when publishing would fail, and when a pull
request update would be skipped.

### The other commands

| Command | JSON on success |
|---|---|
| `analyze` | `{"ok": true, "runId", "runDir", "files": {"analysis", "evidence", "guide", "schema"}, "summary": {"title", "changeLabel", "size", "files", "suggestedDurationSec", "evidenceItems"}}` |
| `agent analyze` | `{"ok": true, "name", "workDir", "files": {"analysis", "evidence", "guide", "schema"}, "summary"}`. `agent validate` and `agent render` print the same object as `validate` and `generate`. |
| `agent frames` | `{"ok": true, "name", "framesDir", "contactSheet", "sheetStepSec", "frames": [{"sceneId", "title", "timeSec", "file"}]}` |
| `validate` | `{"ok", "errors", "warnings", "fixes", "groundedClaims"}`. `ok` is `false` when there is an error. Each error and warning has `path` (for example `scenes[3].visual.ref`), `code` and `message`. `fixes` is a list of strings. |
| `doctor` | `{"ok", "online", "version", "summary": {"pass", "warn", "fail"}, "checks": [{"id", "name", "status", "detail", "fix"}], "kokoro": {"installed", "version", "modelCached"}}` |
| `setup` | `{"ok": true, "targets": [{"name", "summary"}]}`. `setup kokoro` gives `{"ok": true, "kokoro": {"installed", "location", "version", "modelCached"}}`. `setup youtube` gives `{"ok": true, "youtube": {"credentialsFile", "scopes"}}`, and `setup drive` gives `{"ok": true, "drive": {"credentialsFile", "scopes"}}`. Never a token. |
| `status` | `{"id", "status", "createdAt", "updatedAt", "startedAt", "finishedAt", "options", "progress": {"stage", "message", "progress"}, "result", "error"}`. `result` is a result or plan object once the job has succeeded. `error` is `{code, message, hint}` for a failed job. A storyboard in `options` is shown as `"[provided]"`. |
| `jobs` | `{"jobs": [{"id", "status", "createdAt", "updatedAt", "progress", "title", "error"}]}` |
| `serve` | `{"ok": true, "url", "host", "port", "auth", "allowRoots"}` once, at start. The server then runs until you stop it. |
| `cache clear` | `{"ok": true, "path", "cleared": ["tts", "llm"]}` |
| `theme init` | `{"ok": true, "theme", "base", "path", "colors", "logo"}`. `colors` are the colors written to the theme, and `logo` is the path of the copied logo, only with `--logo`. |
| `theme preview` | `{"ok": true, "theme", "base", "sheet", "stills"}`. `base` is `dark` or `light`, `sheet` is the page and `stills` the image files. |

## Exit codes

Scripts and coding agents can branch on the exit code. The `code` field of a JSON error names the cause.

| Exit code | Error codes | What it means | What to do |
|---|---|---|---|
| 0 | | Success. | Report the result. |
| 1 | `RENDER_FAILED`, `INTERNAL` | Rendering failed, or something unexpected happened. `doctor` also ends with 1 when a check fails. | Read the message. Try `--quality draft`. Add `--log-level debug` for more detail. |
| 2 | `USAGE`, `CONFIG_INVALID`, `SOURCE_INVALID`, `SOURCE_NOT_FOUND`, `JOB_NOT_FOUND` | The command, a setting, the source or an id is wrong. Running `mergestory` with no command also ends with 2. | Fix the command, the setting, the path or the ref. |
| 3 | `STORYBOARD_INVALID`, `GROUNDING_FAILED` | The storyboard has errors. `validate` ends with 3 when it finds errors. | Read `errors` (in `validate`). In `generate` and `agent render`, read the errors listed under the message, or `error.details.errors` with `--json`. Fix the storyboard and check it again. |
| 4 | `BUDGET_EXCEEDED` | A paid call would take the run over the budget. It was not made. | Tell the person. Do not raise `--budget` on your own. |
| 5 | `GIT_FAILED`, `GITHUB_AUTH`, `GITHUB_FAILED`, `RATE_LIMITED`, `LLM_FAILED`, `LLM_REFUSED`, `TTS_FAILED`, `PUBLISH_FAILED`, `NOTIFY_FAILED` | A service failed: git, GitHub, a model, speech or the upload. | Read the hint. Network access or credentials are the usual cause. `NOTIFY_FAILED` can come with a full result: see [`generate`](#mergestory-generate). |
| 6 | `FFMPEG_NOT_FOUND`, `BROWSER_NOT_FOUND` | FFmpeg or a browser is missing. | Show the install hint from the error. |
| 7 | `PRIVACY_BLOCKED` | MergeStory refused to publish, to protect a private repository or a run folder. | Keep links private, or ask the person. See [hosting.md](hosting.md). |
| 8 | `RENDER_TIMEOUT` | Rendering took longer than `--max-render-seconds` (`render.maxSeconds`). No video was written. | Raise the limit, use `--quality draft`, or make the video shorter with `--max-duration`. |
| 130 | `ABORTED` | The run was cancelled (Ctrl+C or SIGTERM). | Nothing to do. |

# Changelog

All notable changes to MergeStory are listed here, newest first.

## Unreleased

### Engine

- **Fixed:** a storyboard can show code from large source files. Files up to 8 MiB (was 1 MiB) are read, for
  local repositories and for pull requests on GitHub. Before, every code reference into a larger file, such
  as a big bundled script, failed with `code-ref-unreadable`. Binary files and files over 8 MiB still read as
  not available.
- **Fixed:** checklist cards no longer cut a title or a detail without saying so. The text first gets a
  smaller size and more lines. If it still does not fit at the smallest readable size, the render logs one
  warning that names the items to shorten.
- **Changed:** small changes get shorter videos. The suggested length is 25 seconds (was 45) for up to 20
  changed lines, and 40 seconds (was 70) for up to 120. Larger changes keep their length. `--duration`
  still sets the length you choose.
- **Changed:** the storyboard guide (`AUTHORING.md` and the model prompt) leads with why the change exists
  and its most important hunk; the overview of the components comes after the code. The video says so when
  the pull request text gives no reason. The review scene names two or three places to read closely, with
  file and lines, and there is no recap scene at the end. Every line must add a new fact, and the pull
  request number is not spoken. A model receives about 200 more tokens per request.
- **Added:** `validate` warns when a narration line repeats an earlier one (`repeated-line`). The offline
  storyboard is not checked, and its closing scene no longer repeats the line about added tests.
- **Fixed:** the voice reads clock times, dates and versions as a person says them. `17:00` is "5 PM",
  `2026-11-19` is "November 19, 2026" and `1.0.0.52` is "1 point 0 point 0 point 52". Before, the speech
  engine chose how to read them. Captions still show the text as written.

### Docs

- **Changed:** the website and the README are new. Both show frames of real videos in place of drawings. The
  website plays every film in one player, which loads only after a click.
- **Added:** MergeStory for Chrome has its own section on the website and in the README, with a picture of the
  video playing inside a pull request.
- **Changed:** a new film, and three demo videos made with this engine: a real pull request of 94 files, a
  bug fix with a screen recording, and the weather feature. The demo watch page is rendered again.

## 1.8.0

### Skill and plugin

- The skill installs `mergestory@1.8.0`. It still asks for 1.5.0 or newer: an older engine ignores the new
  folders and files, and the skill says what to do then.

### Engine

- **Added:** one video for a change in several repositories, for example a fix that works only when two pull
  requests are merged together. `analyze`, `validate` and `generate` take `--source <repo>[:<base>..<head>]`,
  up to 4 times, for local repositories and pull requests. The ids of each repository get a letter in front
  (`A.F1`, `B.S2`) and its paths get its folder in front (`orders-api/src/total.js`), and the letters do not
  depend on the order of the flags. One line of narration may cite ids of several repositories, an
  `architecture` visual may show components of all of them, and the title card must name every pull request
  (the check `title-missing-source` warns, and repairs the kicker when the names fit). The closing card, the
  watch page and the upload titles name every repository, and a link to code goes to the repository and
  commit of its own source. With several sources you write the storyboard yourself: MergeStory writes none on
  its own. Nothing is posted to a pull request, and `--comment` and `--update-description` are refused with
  several sources. A request to a model with one source does not change; with several it gets one extra
  paragraph of about 160 tokens. The `agent` commands and the HTTP API keep one source. The reproduction, the
  logs, the hidden regions and the screenshots are not tied to a repository and work with several sources. It
  needs engine 1.8.0 or newer. See `examples/two-repos-demo` and "Several sources" in `docs/cli.md`.
- **Added:** real logs in the video. `--log <file>[:<caption>]` passes the output of a run, a test or a
  command as context to `analyze`, `validate` and `generate`. You can repeat it up to 4 times. A log must be
  UTF-8 text of at most 256 KB. Its lines are numbered from 1, and the colour codes of a terminal are
  removed. A log gets the evidence id `L1`, `L2`, and so on, and a narration line can cite lines of it as
  `L1.120-140`. A range that is not inside the log is removed like any unknown id. `evidence.md` lists each
  log and shows a masked excerpt: the first and last lines, and the lines with an error word. The excerpt is
  left out when `privacy.llmContext` is `minimal`. An entry of `--tests-file` can point at its output with
  `"log": "L1.120-140"`. The agent commands read logs from `logs/` in the work folder. The new `log` visual
  shows lines of a log in a code window with no syntax colours, with the lines the narration talks about
  highlighted. The scene is labelled "Real output", and a line that is too long is cut at the edge of the
  window. The bug-fix demo now shows the real output of a small check. The checks are `log-unknown`,
  `log-range-out-of-range` and `log-too-long`; a range is cut to the log and to 18 lines, and each cut is
  listed in `fixes`. A line of a log is masked like a line of code. A model that writes a storyboard gets
  about 360 more tokens in every request. It needs engine 1.8.0 or newer.
- **Added:** hide parts of a screenshot or a recording. `--redact <file>` on `analyze`, `validate` and
  `generate` takes a JSON file with a list of regions for each capture, for example
  `{"SS1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}], "RC1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}]}`.
  The numbers are fractions of the picture, and a region of a recording is hidden in every frame of the clip. FFmpeg covers each
  region with one solid grey block, which is the same whatever was under it, before the picture is used anywhere:
  the video, the render plan and the pictures in `recording-frames/` hold only the hidden picture, and if
  hiding fails the run stops. This includes the small pictures of a reproduction step. The agent commands
  read `redact.json` from the work folder. A scene that
  shows such a capture carries the badge "Sensitive data masked", and the evidence pack marks the capture
  "parts hidden". The file is checked strictly: an id that was not passed, an unknown field or a region
  outside the picture is an error, and nothing is skipped. MergeStory finds nothing by itself. A publish
  target only ever gets the video, its poster, its captions and the watch page, and a publisher now refuses
  any other file. It needs engine 1.8.0 or newer. See "Hidden regions" in `docs/cli.md`.
- **Added:** reproduction steps. `--repro-file <file>` passes the steps that show a bug to `analyze`,
  `validate` and `generate`, as JSON: a `title`, an optional `environment` and 1 to 12 `steps`. A step has a
  `text`, and may have a `screenshot` or a `recording` (an id such as `SS1` or `RC1` of a capture that you
  passed too) and a `result` (`expected`, `actual`, `bug` or `fixed`). The file is at most 64 KB, and a
  mistake in it is refused with the step named. The agent commands read `repro.json` from the work folder.
  The reproduction gets the evidence ids `REPRO` and `REPRO.1`, `REPRO.2`, and so on. Like the notes, it is the
  author's account and is not checked against the code, so a line that cites it says so ("the reproduction
  shows ..."), and it is not backing evidence for a simulated visual. The new `repro` visual lists steps by
  number, each on its beat. The new scene roles `reproduction` and `proof` put the bug before the code and the
  fix working after it, when something real was supplied to show them. The checks are `repro-unknown` and
  `repro-step-unknown`; a longer list is cut to 6 steps and the cut is listed in `fixes`. The offline
  storyboard shows a reproduction too. When a video must be shortened, these two scenes are dropped last. A
  model that writes a storyboard gets about 430 more tokens in every request. A step with a screenshot shows
  it as a small picture; a step with a recording shows the last picture of the clip, which is the page that
  the step led to. A step marked `bug` is red with a cross and the word "Bug", and one marked `fixed` is green
  with a check and the word "Fixed", so the colour is never the only sign. The scene is labelled "Reported
  steps". See "Visuals" in `docs/storyboard.md` and the example in `examples/bugfix-demo`.
- **Added:** more screenshots, and a folder of them. The limit is now the setting `inputs.maxScreenshots`:
  6 by default, up to 12. `--screenshots-dir <folder>` on `analyze`, `validate` and `generate` takes every
  `.png`, `.jpg` and `.jpeg` file in a folder, in name order, after any `--screenshot`. An optional
  `captions.json` in the folder gives each picture a caption and a side, as `recordings/captions.json` does
  for recordings. The agent commands also read a `screenshots/` folder in the work folder. A picture wider
  than 2560 pixels is made 2560 pixels wide with FFmpeg before it goes into the video, so a full-page
  capture no longer makes the render slow. The file itself is not changed, and a picture of 2560 pixels or
  less is used as it is. If FFmpeg cannot do it, the run stops and names the picture. The demo in
  `examples/bugfix-demo` now passes its two screenshots as a folder.
- **Added:** point at the part of a picture that matters. A `screenshot` visual, a `recording` visual and a
  `screenshot` panel in `before-after` can have `highlights`: up to 4 boxes, each `{x, y, w, h, label, beat}`
  in fractions of the picture (for a recording with a `zoom`, of the part that the zoom keeps). A box is
  drawn in the accent colour of the theme with a dark and a white line, so it can be seen on any picture. It
  appears on its beat, with an optional label of up to 40 characters. A `screenshot` or `recording` visual can
  also have a `focus` box: the camera slowly zooms into it (up to 4 times) over the scene, never faster than
  the narration, so a small error message in a big page can be read. The checks: a box or a focus outside the
  picture is moved inside, a label is checked like a caption, a label of more than 40 characters is shortened
  and warned about (`highlight-label-too-long`), and more than 4 boxes are trimmed. All are listed in
  `fixes`. A storyboard without the new fields is unchanged. A model that writes a storyboard gets about
  940 more tokens in every request. A recording scene with a `focus` keeps its frames up to 1.5 times
  larger, so the zoomed picture stays sharp. The bug-fix demo in `examples/bugfix-demo` uses both. The skill
  tells an agent about them. See "Visuals" in `docs/storyboard.md`.
- **Fixed:** the same inputs give the same video with a full browser too. A full Chrome, Chromium or
  Edge draws its pages on the GPU, and there a page was drawn a little differently when the browser had
  drawn another page before: in the first frames in which a recording slides away, some pixels along
  edges were one level lighter or darker. Which browser draws which part of a video changes from run to
  run, so the bytes of the video changed too. The headless shell, which MergeStory uses when it is
  installed, draws on the CPU and was not affected. Now every browser draws its pages on the CPU. A full
  browser gave 4 different videos in 24 renders of the bug-fix demo; now it gives one.
- **Fixed:** the colours of code no longer depend on how busy the machine is. The highlighter stopped
  work on a line after half a second on the clock, so on a very busy machine the rest of a line lost
  its colours, and the video was different. Now there is no time limit. A line of 20,000 characters or
  more is shown without colours instead; the video shows the first 240 characters of a line.

## 1.7.0

### Skill and plugin

- The skill installs `mergestory@1.7.0`. It still asks for 1.5.0 or newer: recordings are used only by an
  engine that reads them, and an older one ignores the folder.

### Engine

- **Added:** screen recordings in the video. `--recording <path>[:<caption>[:before|after]]` passes a real
  screen recording (MP4 with H.264, or WebM with VP8 or VP9; a QuickTime or Matroska file with one of these
  codecs works too) as context to `analyze`, `validate` and `generate`. MergeStory does not record anything
  itself: it shows what you captured. A file is checked by content with `ffprobe` and gets the evidence id
  `RC1`, `RC2`, and so on, listed in `evidence.md`. The `inputs` settings set the limits (4 recordings,
  50 MB and 60 s each, by default). A recording must be at least 0.2 seconds long and at most 40 megapixels.
  The sound may be AAC, MP3, Opus or Vorbis. A file with another kind of track is refused, with the reason.
  A recording that a phone stored turned on its side is shown upright. The agent commands read recordings
  from `recordings/` in the work folder. The new `recording` visual shows a clip (`trim`, `speed` and `zoom`
  are optional), and a before-after panel can hold one. The checks are `recording-unknown`,
  `recording-trim-out-of-range` and `recording-too-long`; a clip is cut to 20 seconds
  (`inputs.maxClipSeconds`) and the cut is listed in `fixes`. The video labels it "Recorded". A model that
  writes a storyboard gets about 440 more tokens in every request. The clip plays in the video at 12 frames
  a second, without its sound, and rests on its last frame when it ends before the scene does. A recording
  that cannot be decoded stops the run before any speech is paid for. MergeStory does not look inside a
  recording or a screenshot, so what the capture shows is what the video shows: only captions and other text
  are masked. See "Visuals" in `docs/storyboard.md` and the example in `examples/bugfix-demo`, which makes
  its own captures.
- **Added:** a run now leaves what a script or an agent needs when nobody is watching. The run folder
  has `watch.html` next to `video.mp4`: the watch page, which plays the video beside it, so the two
  can be uploaded together. The result has `scenes` (every scene with the type of its visual, its
  start and its length), `evidenceUsed` (every evidence id that the video cites or shows), and the
  paths `files.captionsSrt` and `files.watchHtml`. When a run stops before its video is made, and
  after its folder was made, `result.json` holds the error (`ok` is `false`) instead of nothing. A
  run in a folder that an earlier run used removes that run's result, video, poster, captions and
  watch page once it has read and analysed the change, so a failed run never leaves the video of
  another change there. "Unattended runs" in `docs/cli.md` describes all of it.
- **Added:** `--max-render-seconds <sec>` and the setting `render.maxSeconds` stop a render that takes
  too long. The run ends with the new exit code 8 (`RENDER_TIMEOUT`) and writes no `video.mp4`.
- **Added:** `mergestory doctor --json` reports the free voice as data: `kokoro.installed`,
  `kokoro.version` and `kokoro.modelCached`. A machine image can check once that a run has nothing
  left to download.
- **Changed:** `mergestory setup kokoro` also downloads the speech model (about 90 MB, or about 330 MB
  on Apple Silicon). Before, the first video that used the voice downloaded it, so a machine could not
  be made complete ahead of time.
- **Fixed:** MergeStory works for a user that has no home folder, once `MERGESTORY_HOME` is set. Some
  containers run as such a user, with `HOME` unset. Before, a run stopped with a system error while it
  looked for a browser, even when `MERGESTORY_BROWSER_PATH` named one. Now the MergeStory home also
  serves as the home folder of the programs that MergeStory loads and starts. Without
  `MERGESTORY_HOME`, the error says to set it.
- **Fixed:** the voice install works when the home folder cannot be written. npm keeps its cache
  there. Where npm cannot write its cache, the install now gives it one in the MergeStory home and
  removes it afterwards. A cache that npm can write is used as before.
- **Security:** with `HOME` set to nothing or to a relative path, the search for a browser looked in
  folders under the current folder, which is often the repository being explained. It could have
  started a program from there. Such a `HOME` now counts as no home folder, and no relative path is
  searched.
- **Fixed:** on a machine that refuses the browser its sandbox, the browser starts without the sandbox
  again, with a warning. Most containers refuse it for a user that is not root, and so does Ubuntu
  23.10 and later. The check for that refusal did not know how the browser library words it, so such
  a run stopped with "The browser could not be started".
- **Fixed:** a render that is cancelled stops at once and leaves no video. It closes its browsers, and
  it does not wait for a browser that is still starting. Before, a browser that no longer answered
  could hold the stop up for a minute, one that never answered held it up for ever, and a stop in the
  last step of a render could leave a finished video in the folder.
- **Fixed:** when `mergestory generate --storyboard` or `mergestory agent render` refuses a
  storyboard, the text output now lists the blocking problems under the message, in the form that
  `validate` prints. It lists up to 40, and a list of 40 says that more problems may follow. Before,
  the hint said "Fix the listed problems" and none was shown, so the author had to run `validate` to
  see them. The `--json` output and the exit code (3) are unchanged.
- **Fixed:** `validate` and the list above show each problem on one line. A line break or tab inside
  the path or the message of a problem is now shown as a space. Before, such a problem could print
  as several lines.
- **Changed:** `AUTHORING.md` states four more rules. A terminal holds at most 12 lines and a browser
  page at most 8 blocks. The `text` of a browser block is its label, title, header, first line or
  caption, depending on the kind. A focus range outside the code is dropped, and neither the ranges
  nor their beats have to rise. Narration over the word budget is kept as it is, and only a video
  estimated longer than `--max-duration` is trimmed, after a warning from `validate`. The rules for
  focus ranges and block text are field descriptions in the schema, so a model that writes a
  storyboard receives them as well (about 120 tokens more per request). The guide that a model gets
  as its prompt is unchanged.

## 1.6.0

### Skill and plugin

- The skill installs `mergestory@1.6.0`. It still asks for 1.5.0 or newer.
- The skill no longer sends the agent to `storyboard.schema.json`. The agent follows `AUTHORING.md`
  and opens the schema only for a schema error that the message does not explain.

### Engine

- **Added:** `mergestory runs delete --older-than <days>` removes every run and finished background
  job made more than that many days ago. Deleting a run by id now also removes the files of the job
  that made it. A run that a job is still making is kept.
- **Added:** `mergestory validate` and `mergestory agent validate` write one line to the log when a
  storyboard has errors: the number of errors and how many of each code. Before, a failed check left
  no trace on stderr. The result on stdout and the exit codes are unchanged.
- **Fixed:** the evidence pack says that its test line counts test files, not test cases. Before,
  "Tests: 0 added" could be read as "no tests were added" when modified test files held new cases.
- **Fixed:** a review prompt reports the right number in "and N more". Before, the count stopped at
  8 places. For source files without a test change it stopped at 5, and for large blocks and long
  functions at 3.
- **Changed:** the pull request comment is shorter. The chapters are folded, and one click opens
  them.
- **Changed:** a review item of the offline storyboard no longer lists its places in the detail,
  because the item already links to the first place. A finding in several places says how many.
  Before, the review scene, the watch page and the comment showed the file and line twice.
- **Changed:** the authoring guide asks that the detail of a review item does not repeat its title
  or its file and line.
- **Changed:** `AUTHORING.md` lists every allowed value of a storyboard, adds three field rules from
  the schema, and says that the schema does not have to be read. So an agent no longer has to read
  `storyboard.schema.json`, about 45 KB, for each video. The file is still written. The log line of
  `analyze` counts the evidence pack and the guide.

### Docs

- New page: [Videos for many pull requests](docs/batch.md). It shows a loop in a shell and a backfill
  in GitHub Actions, and says what a batch costs, which limits it can hit and how to clean up.

## 1.5.1

### Skill and plugin

- The skill installs `mergestory@1.5.1`. It still asks for 1.5.0 or newer.

### Engine

- **Fixed:** short values under names like `password` (`password = "hunter2"`, `DB_PASSWORD=abc123`)
  and quoted passphrases with a digit or sign are now masked. Before, values under 8 characters and
  values with spaces were shown.
- **Fixed:** Hugging Face, Google OAuth, DigitalOcean, Shopify and PyPI tokens, and more Slack token
  forms, are masked in videos and kept out of logs.
- A missing browser, FFmpeg or voice setup now stops a run before the storyboard step, so a paid
  model is not called for a run that cannot finish.
- With a GitHub App token, the pull request comment is updated instead of a new one being posted on
  every run.
- A stray end marker in a pull request description no longer makes a new MergeStory section appear
  on every run.
- A model's answer is no longer reused from the cache after `llm.effort`, `llm.maxOutputTokens` or
  `llm.baseUrl` changes.
- A 429 answer that reports a quota or spending limit is no longer retried for paid voices.
- `mergestory serve` refuses an API token that contains whitespace, which no request could send.
- Line numbers in code views stay correct in files that contain a lone carriage return.
- `--json` output keeps control characters, escaped, instead of dropping them.
- The published package pins the dependency versions that CI tested.

## 1.5.0

### Skill and plugin

- The skill installs `mergestory@1.5.0` and asks for 1.5.0 or newer, because its troubleshooting
  notes describe the new errors below.

### Engine

- **Changed:** for a storyboard that an agent or a person wrote (`mergestory agent validate`,
  `agent render`, `validate` and `--storyboard`), two automatic repairs are now errors, because they
  left the voice describing code that was not on screen:
  - `diff-too-tall`: a diff view that needs more than 18 rows. The message names a range that fits.
    Before, the range was shortened or the view became a snippet without the removed lines.
  - `code-ref-unreadable` on a code visual: the file cannot be read. Before, the scene became the
    changed-files overview.

  A storyboard that a model writes (`--llm`) and the offline storyboard are repaired as before.
- The review scene, the watch page and the pull request comment say that the priorities of review
  items are suggestions.
- A sentence about checks in the code, such as "only after the flag and plan checks pass", is no
  longer removed as a claim about CI. "Checks pass" on its own is still a claim.
- A caption with a word longer than one line stays one caption. Before, a long name split the
  sentence into captions that were on screen for about half a second each.
- A name prefix that is joined to something else, such as `key = "Customer.Field." + name`, is no
  longer masked as a secret. Values under names like `password` are masked as before.
- New warning `internal-term`: the narration says "the pack" or "the evidence pack", which a viewer
  does not know. The sentence stays. The authoring guide now tells the agent to avoid these words.
- A review scene with one or two cards is centered. Before, the cards sat at the top with the
  lower half empty.

### Docs

- MergeStory for Chrome is in the Chrome Web Store. The website and the README link it.
- The cost page shows what a coding agent's usage looks like, measured with a Sonnet-class model: the
  tokens, roughly $0.20 to $0.45 per video for a fresh agent, as in CI, and roughly $0.15 to $0.25
  when the same session wrote the change.
  The website and the plugin README no longer say "often more than 10,000 tokens".
- The website says that the checks do not prove every sentence is right.
- The website and the README lead with "No MergeStory fee" and say what the agent's usage costs:
  about 20 cents per video if you pay per token. The "$0" headline is gone. The cost film is a
  new cut that says the same.

## 1.4.1

No changes to the engine: 1.4.1 works like 1.4.0.

### Skill and plugin

- The plugin version and the version that the skill installs now change in the release itself,
  before its tag. Plugin catalogs that copy the plugin from a release tag now get the plugin made
  for that release. Before, each tag carried the plugin of the release before it.
- The skill installs `mergestory@1.4.1`. It still accepts 1.4.0, so it does not ask you to upgrade
  from 1.4.0.

### Releasing

- The release workflow stops before npm when the tag does not match the package version, the
  plugin version or the version that the skill installs.

## Skill and plugin 1.4.0

- The skill installs `mergestory@1.4.0`, which adds theme logos.

## 1.4.0

### Themes

- A theme can carry your logo. `mergestory theme init <name> --logo <file>` copies a still PNG or JPEG
  into the theme, or you name the file in `theme.json` with `"logo": "logo.png"`. The logo takes the
  place of the MergeStory mark and name in the top bar and on the end card, which keeps a small "Made
  with MergeStory" line. The file must be a plain file in the theme folder, at most 256 KB and
  2048x2048 pixels. SVG and animated PNG are not supported. See
  [docs/themes.md](docs/themes.md#add-your-logo).

### Screenshots

- A JPEG screenshot with a rotation tag (EXIF orientation), as phones often save them, now keeps its
  shape. Before, a screenshot turned a quarter this way came out stretched.

## Skill and plugin 1.3.0

- The skill installs `mergestory@1.3.0`, which adds video themes.
- For another look, the skill passes `--theme <name>`. It never passes a theme path, and never takes a
  theme from the repository's files.

## 1.3.0

### Themes

- Videos have themes. Four come with MergeStory: `midnight` (the default, the old `dark`), `paper` (the
  old `light`), `high-contrast` and `terminal`. `--theme dark` and `--theme light` still work, and they
  look exactly as before.
- Make your own theme: a `theme.json` with colors in `~/.mergestory/themes/<name>`, or a folder whose
  path you give to `--theme`. A theme is data only: colors and a code color scheme. It cannot change
  how added, removed and changed lines look, or the badges, and its backgrounds must let those colors
  stand out. See [docs/themes.md](docs/themes.md).
- `mergestory theme init <name> --accent <color>` makes a theme from your brand color. `--brand
  <file>` takes the colors from a file of yours (CSS, JSON or a list), and `--from paper` makes the
  theme light.
- `mergestory theme preview <theme>` draws sample scenes with a theme on one page, with no model, no
  voice and no network.
- A contrast check refuses a theme that is hard to read. `--allow-low-contrast` makes it a warning.
- The agent commands and the HTTP API take a theme name only, never a path.

### Browser extension

- [MergeStory for Chrome](https://github.com/PiniShv/mergestory-chrome) plays the video inside the pull
  request page on GitHub. It is a separate project with its own repository.

### Cost report

- A speech request that times out (also when it is tried again), or whose audio cannot be read after the
  service answered, may still be billed. It is now counted at its estimate, like a model call.

## Skill and plugin 1.2.5

- After you open a pull request, the skill offers a video in one short sentence and makes one only when
  you say yes. Before, it could make a video nobody asked for, and that uses your agent's tokens.

## 1.2.4

### Cost, stated exactly

- The README, the npm page, the plugin page, the docs and the website now say exactly what MergeStory
  charges (nothing by default) and what can still cost money: your coding agent's usage, models and
  voices you turn on, storage and downloads, and CI minutes. Their providers bill you.
- Prices are estimates from list prices, and the budget is a safeguard per run, not a guarantee of your
  final bill. To cap your real bill, set a spending limit with each provider.
- The `Cost` line and the dry-run estimate end with "your coding agent, storage and CI are billed
  separately".
- The `--budget` help says what the budget covers, and the `doctor` model check says that the provider
  bills your account. The `--llm`, `--tts` and `analyze` help no longer say "free". The npm description
  says "Open source" instead of "Free".

### Cost report

- A model server on this machine or your network (for Anthropic, a gateway on this machine) is now
  counted at the model's built-in price or the price you set in `pricing`. Before, it counted as $0, so
  a run near its budget can now stop with `BUDGET_EXCEEDED`. With no known price it still counts as $0,
  and the run warns once that the budget does not cover it.
- The `Cost` line no longer calls an assumed rate a list price. It says when a model had no known price
  and a rate was assumed, or when a model server on this machine or your network was counted as $0.
  Each record in `result.json` has a `priceNote` (`assumed` or `local`) for this.
- A model call that times out, or whose answer cannot be read, may still be billed. It is now counted at
  its estimate instead of at $0.
- The dry-run estimate is now a high estimate: it includes each repair attempt, and with a model it
  prices the speech for the longest narration that fits `maxDurationSec`. It is labelled
  `Est. cost (high estimate)`. When it is over the budget, the note says that a real run stops before
  any call that would go over it.
- When no usage comes back from the server, the input count includes the repair history.
- `mergestory publish` shows "not known: the earlier result of this run is missing" as the cost when
  `result.json` is gone, instead of $0.0000.
- The progress line of `analyze` counts the guide and the schema as well as the evidence pack.
- The plugin skill calls the cost an estimate only when it is above $0, and says that the agent's own
  usage, storage and CI are billed separately.
- docs/cost.md says that the `gpt-4o-mini-tts` and ElevenLabs rates are conversions, and that you can
  set your own in `pricing`.

## Skill and plugin 1.2.4

- The skill installs `mergestory@1.2.4`, which says exactly what a video can cost and counts the cost
  of a run accurately.
- The skill calls the cost an estimate only when it is above $0, and says that the agent's own usage,
  storage and CI are billed separately. The plugin page says what can still cost money.

## 1.2.3

### Narration

- Short words in capitals are spoken as words. The local voice spelled a word of two or three
  capitals letter by letter, so "DEV mode" sounded like "D, E, V mode" and MAX_RETRIES like
  "M, A, X retries". Common words and code words (DEV, ZIP, MAX, KEY, NEW, NOT) are now read as
  words, and abbreviations people say as a word (RAM, GIF, LAN) too.
- Most abbreviations are now spelled, even in a short phrase. In "the API, CLI and SDK" the voice
  read some of them as words ("cly"). Their letters are now joined for the voice ("C-L-I").
  Abbreviations with an A after the first letter, such as QA and SLA, keep their written form, so
  the voice can still read some of them as a word.
- Product terms are read the way people say them: SaaS and PaaS as words, A/B and CI/CD letter by
  letter, MoM, QoQ, YoY and WoW as "month over month" and so on.
- The voice starts after 1.5 seconds instead of 0.8, so the title settles before the first words.
- Captions still show the text exactly as written.

### Documentation

- New: [what MergeStory costs, and why it is so cheap](docs/cost.md).
- A new website at https://mergestory.pinishv.com, served from the `docs/` folder.
- The README and the npm page explain the cost of a video.

## Skill and plugin 1.2.3

- The skill installs `mergestory@1.2.3`, which reads short words in capitals as words and starts
  the voice after 1.5 seconds.
- The plugin's home page is https://mergestory.pinishv.com.

## 1.2.2

- `mergestory setup drive` and `setup youtube` say which of the client id and client secret
  variables are set, by name only, both when they ask for the values and when they refuse to run
  without a terminal. A variable that did not reach the shell is now easy to spot.
- The Drive guide explains that values in Claude Code's managed settings reach only the shells Claude
  Code starts, so the coding agent runs the sign-in and the person only clicks Allow.
- After a Drive upload, one line says who can open the video: people in the organization with the
  link (protected), anyone with the link (public), or only you (private).
- The warning that Google ends a sign-in after 7 days for External apps in "Testing" now shows only
  when the client id was typed in. A client that an admin set for everyone is usually an Internal app,
  where the limit does not apply.

## Skill and plugin 1.2.2

- The skill runs `mergestory setup drive` in its own shell instead of sending the user to a terminal,
  where managed settings do not apply, and asks to allow the browser and the local sign-in port when
  a sandbox blocks them.
- The skill installs `mergestory@1.2.2`.

## 1.2.1

### Privacy

- Webhook addresses are masked wherever code is shown or sent: Slack (services, workflows and
  triggers), Microsoft Teams, Discord and similar services, also when a JSON file writes the slashes
  as `\/`. Before, only one Slack form was caught, so a webhook on a changed or removed line of a
  configuration file could reach the evidence pack.
- Secrets in a URL's query string (`?token=`, `?key=`, `?signature=` and similar) are masked too.
- Long names such as `updateInvoiceApprovalStatusForCustomer` are no longer masked as if they were
  random keys. Real keys without a telling name are still masked.

### Rendering

- Google Chrome on macOS could draw every frame 87 pixels short, so the render failed with "The browser
  captured a 1920x993 frame instead of 1920x1080". MergeStory now sizes the browser window to the frame.
- `mergestory doctor` draws one test frame and fails the browser check, with the steps to fix it, when
  the browser cannot draw full frames.
- The render error for frames of the wrong size now says exactly what to install and set.

### Google Drive

- Hints that pointed to `docs/*.md in the MergeStory repository` now give the full link, so they also
  work for the installed package, which does not include the docs.
- `mergestory setup drive` says that an admin can set one OAuth client for the whole company, so each
  person only picks an account and clicks Allow.

## Skill and plugin 1.2.1

- The skill installs `mergestory@1.2.1`.
- If `setup drive` asks for an OAuth client id, the skill stops and explains that an admin sets it,
  instead of asking the user for it.
- The troubleshooting guide covers renders that fail with a frame of the wrong size.

## 1.2.0

### Sharing

- New `--publish drive` uploads the video to a `MergeStory` folder in your own Google Drive. It asks
  Google only for the `drive.file` permission, so it reaches only the files it created.
- `--visibility` decides who can open a Drive link: `private` (the default) is only you, `protected` is
  your Google Workspace organization, and `public` is anyone with the link. A public link for a private
  repository is blocked unless you allow it.
- If Drive refuses to share a file, the upload still counts: the file stays private and a warning says why.
- New files never take on a Workspace's default sharing; only the chosen visibility applies.
- New `mergestory setup drive` signs in once. Organizations can give every laptop the client id and
  secret through `MERGESTORY_DRIVE_CLIENT_ID` and `MERGESTORY_DRIVE_CLIENT_SECRET`. See
  [docs/drive.md](docs/drive.md).
- `mergestory setup youtube` and `mergestory setup drive` now also run without a terminal, for example
  for a coding agent, when the client id and secret both come from the environment and `CI` is not set.
- `mergestory doctor` checks the Drive sign-in, and with `--online` shows the organization of the account.

## Skill and plugin 1.2.0

- When the team set up Google Drive, the skill shares a video there after you approve, and asks you
  to sign in to Google once per machine.
- Sharing uses the storage the team set up, without naming it in the command.
- The skill installs `mergestory@1.2.0`, and the example GitHub Actions workflow runs that version.

## Skill and plugin 1.1.0 (2026-11-12)

The Agent Skill and the Claude Code plugin. They need engine 1.1.0.

- The skill now uses the `mergestory agent` commands. After the one approval of the skill itself, Claude
  Code asks no further question for a video of the repository you are in: these commands explain only
  that repository, keep their files in one work folder and render on your machine.
- A pull request of another repository, a repository in another folder and every upload still need your
  approval.
- The skill reads its own reference files without a question.
- The skill installs `mergestory@1.1.0`, and the example GitHub Actions workflow runs that version.

## 1.1.0 (2026-11-12)

### Safer with coding agents

- The global `--config` option is removed. A settings file can name other programs and hosts, so a flag
  added to an approved command could change what MergeStory runs and where it sends data. Set
  `MERGESTORY_CONFIG=<file>` instead, or use `~/.mergestory/config.json`. Typing `--config` now gives an
  error that says this.
- `--llm-base-url` only takes an address on this machine. Before, the flag could send the evidence pack to
  any https host. A server on another machine still works through `MERGESTORY_LLM_BASE_URL` or
  `llm.baseUrl` in the config file.
- New `mergestory agent analyze`, `agent validate` and `agent render` commands for coding agents. They work
  in a work folder under `~/.mergestory/work`, explain only the repository of the current folder, and take
  no flag that names a file, a folder, a program or a host. `agent render` never calls a model or a paid
  voice, never uploads and never comments, whatever the environment or the config file says. With
  `mergestory --version` and `mergestory doctor --json` they are safe to pre-approve.
- `generate --out` and `publish` refuse a folder inside `~/.mergestory/work`. Before, a draft folder that an
  agent may write to could become a run folder, and `publish` trusts the files of a run folder.
- MergeStory no longer writes into an existing output folder (`--out`, or a work folder) that is a symbolic
  link or holds one. Before, a link placed there could make a written file land elsewhere.
- A local repository is read only when a `.git` entry names it: a normal clone, a linked work tree or a
  submodule. MergeStory does not run inside a bare repository, in a repository that sits inside a
  checked-out folder, or in one in the work folder. Before, the settings of such a repository could
  name a program that git then ran.
- Every program that MergeStory starts by name (`git`, `gh`, FFmpeg, the browser, and `npm` for the voice
  install) is found on `PATH` and started by its full path. A `PATH` entry that is not a full path is
  ignored, and a `git` inside the repository being explained is refused. Before, on Windows, a program
  with that name in the current folder could run instead.

### Also new

- A pull request link from another host, such as Bitbucket or GitLab, is still refused. The error now
  says to pass the path of the local repository with `--base <branch>` instead.
- The message for missing FFmpeg now has the install command for Windows.
- The result of a finished run has `elapsedSec`, the time the run took. `generate` prints it as
  "Made in 1m 32s". Results from 1.0.0 do not have it, and `publish` still works with them.
- The authoring guide (`AUTHORING.md`) now shows one example of every visual with all its fields, so a
  storyboard is right in fewer tries.
- New `mergestory runs` command: lists the videos on this machine. `mergestory runs delete <run-id>`
  deletes the folder of a run. It only deletes real run folders under the runs folder.

## Skill and plugin 1.0.1 (2026-11-11)

The Agent Skill and the Claude Code plugin. The engine stays at 1.0.0.

- The plugin is now a small folder of its own, `plugins/mergestory`, with a manifest. Installing it no
  longer copies the whole repository. The Agent Skill moved to `plugins/mergestory/skills/mergestory`.
- When FFmpeg is missing, the skill asks and installs it, instead of stopping.
- The skill installs the engine with `npm install -g`, after asking. It no longer uses `npx`, which can
  run a copy of a package from the repository it is started in instead of the published one.
- For a pull request that is not on GitHub, the skill uses the local repository.
- The skill keeps its working files in `~/.mergestory/work`, so Claude Code does not ask about each file.
- The skill no longer lets every `mergestory` command run without a question. Only the version check and
  the machine check do. Claude Code asks before `analyze`, `validate` and `generate`, so a command with
  options that the user did not ask for cannot run unseen.
- The render step always keeps the video on this machine (`--publish local`), also when a team set up
  storage as the default. Uploading is a separate step that the user approves.
- Without team storage, the skill says where the video file is instead of offering an upload, and it no
  longer offers YouTube.

## 1.0.0 (2026-11-05)

The first release.

### Videos

- Turns a GitHub pull request, or a branch of a local git repository, into a narrated MP4 with captions,
  a poster image and a watch page.
- Thirteen kinds of scenes: title, mission, changed files, architecture diagram, flow, code, before and
  after, terminal, browser, checklist, bullets, screenshot and summary. The code on screen is read from the
  repository. Simulated scenes (terminal and browser) are always labelled.
- Three quality presets (`draft`, `standard`, `high`), a dark and a light theme, optional background music,
  and narration brought to a standard loudness (-16 LUFS).
- `--max-duration` trims a long storyboard before narration, and `--dry-run` shows the plan, the cost and
  everything that would leave the machine.

### Accuracy

- Every narration line cites evidence from the change. One grounding check runs on every storyboard, whoever
  wrote it. It removes unknown evidence ids, claims nobody can prove, names that are not in the change and
  web addresses that are not in the code, and it fixes code ranges. Test results are shown only as the caller
  reported them.
- Three ways to get a storyboard: built offline (the default, free), written by a model (Anthropic, OpenAI or
  an OpenAI-compatible server, with a repair round), or written by a coding agent with `analyze`, `validate`
  and `generate --storyboard`.

### Speech

- A free local voice (Kokoro, English), the macOS `say` voice, OpenAI, ElevenLabs, or captions only.
  `auto` only picks a free voice, and for English that is always Kokoro.
- The first English run installs Kokoro once (about 400 MB, then the voice model) from the npm registry
  and `huggingface.co`, and sends nothing from the change. `mergestory setup kokoro` does it ahead of time.
  If the install fails, the run stops and says how to go on; it never falls back to `say`.
- One install at a time, also across processes, and an install that was cut off counts as not installed.
  Windows needs a manual install.

### Sharing

- Videos stay on your machine by default.
- S3-compatible storage (Amazon S3, Cloudflare R2, Backblaze B2, Google Cloud Storage, self-hosted servers)
  with private links that expire, protected links behind your team's sign-in (checked before the upload), or
  public links.
- Upload to your own YouTube channel, unlisted by default.
- `mergestory publish` uploads a video made earlier, so you can watch it before you share it.
- One pull request comment, or a section in the pull request description, with the link.
- An example GitHub Actions workflow that makes a video when a pull request gets a label.

### Interfaces

- The `mergestory` command: `generate`, `publish`, `analyze`, `validate`, `schema`, `doctor`, `setup`,
  `status`, `jobs`, `serve` and `cache`. With `--json`, every command prints one JSON object.
- An HTTP API for jobs (`POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs` and `GET /v1/health`), and
  background jobs with `generate --async`.
- A library: `generate`, `prepareAuthoring`, `checkStoryboard`, `publishRun`, `startServer` and the building
  blocks.
- An Agent Skill, and a Claude Code plugin marketplace that installs it.

### Privacy and cost

- No telemetry. MergeStory never writes into the repository it explains.
- Sensitive files are never shown or sent. Secrets and e-mail addresses are masked everywhere.
- Secrets come from environment variables only. The config file is read only from `--config`,
  `MERGESTORY_CONFIG` or `$MERGESTORY_HOME/config.json`, never from the current folder, and an unknown key is
  an error.
- A budget of $0.25 for each run is checked before every paid call. Every run reports its cost and every
  outbound transfer.

### Known limits

- The offline storyboard and the Kokoro voice are English only. The check that removes claims such as
  "all tests pass" reads English only, and a run in another language warns about it.
- A model request that times out is not sent again, because the provider may still bill it. The cost report
  cannot count such a request.
- Where the system does not allow the browser sandbox (as root, or for a downloaded Chromium on Ubuntu 23.10
  and later), the browser runs without it, and MergeStory says so.

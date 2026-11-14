# Changelog

All notable changes to MergeStory are listed here, newest first.

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

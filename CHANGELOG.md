# Changelog

All notable changes to MergeStory are listed here, newest first.

## 1.1.0

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
- New `mergestory runs` command: lists the videos on this machine. `mergestory runs delete <run-id>`
  deletes the folder of a run. It only deletes real run folders under the runs folder.

## Skill and plugin 1.0.1

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

## 1.0.0

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

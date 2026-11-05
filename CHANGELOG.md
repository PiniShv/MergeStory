# Changelog

All notable changes to MergeStory are listed here, newest first.

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

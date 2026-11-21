<div align="center">

<img src="docs/assets/logo.svg" alt="" width="84" height="84">

# MergeStory

### Your pull request. Explained.

MergeStory turns a pull request into a short narrated video:<br>
**what changed**, **why**, and **what to review**.

[Website](https://mergestory.pinishv.com) · [Watch the film](https://www.youtube.com/watch?v=i4SWSSwX3kM) · [Install](#get-started) · [MergeStory for Chrome](#mergestory-for-chrome)

[![CI](https://github.com/PiniShv/MergeStory/actions/workflows/ci.yml/badge.svg)](https://github.com/PiniShv/MergeStory/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mergestory.svg)](https://www.npmjs.com/package/mergestory)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<a href="https://mergestory.pinishv.com"><img src="docs/assets/frame-mission.webp" alt="The opening frame of a MergeStory video: Retry temporary failures with exponential backoff. Plus 148, minus 12, across 7 files." width="100%"></a>

</div>

<br>

A typical video runs from 1 to 3 minutes. It is made on your machine, and it stays there until you
share it. Open source, under Apache-2.0.

## Everything a reviewer needs, in one video

<table>
<tr>
<td width="50%"><b>The big picture.</b> An animated diagram shows which parts changed and how they connect.<br><br><img src="docs/assets/frame-diagram.webp" alt="A video frame with a diagram of five components. Two are marked changed and one is marked new."></td>
<td width="50%"><b>The real code, line by line.</b> The key lines light up as the narrator explains them.<br><br><img src="docs/assets/frame-code.webp" alt="A video frame with the code of a retry loop. Two lines are highlighted, with a short note."></td>
</tr>
<tr>
<td width="50%"><b>Before and after.</b> How behaviour changes, when there is something real to show.<br><br><img src="docs/assets/frame-flow.webp" alt="A video frame with the sequence of one request: no response, a wait, a 503 error, another wait, then 200 OK."></td>
<td width="50%"><b>What to review.</b> Risky or subtle spots, each with a file and a line.<br><br><img src="docs/assets/frame-review.webp" alt="A video frame with a review checklist of five items, each with a file and line numbers."></td>
</tr>
</table>

These frames are from a real video. [Watch it on YouTube](https://www.youtube.com/watch?v=5WFVH8T0GG4), or open
its [watch page](https://mergestory.pinishv.com/demo/) with the chapters, the review checklist and every claim,
linked to the code.

More real videos: [a real pull request of 94 files](https://www.youtube.com/watch?v=x63P-LXSH68) (2:25) and
[a bug fix you can see](https://www.youtube.com/watch?v=oaLRpW8WOS0) (1:29).

A video tells the story in this order. A chapter appears only when it has something real to show:

1. **Why:** the problem the change solves, from the pull request, the ticket or your notes. When no source says why, the video says so.
2. **The bug happening:** the steps that show it, with a screenshot or a recording (only when you supply them).
3. **The key change:** the most important code first, highlighted line by line.
4. **Before and after:** what goes in, and what came out before and comes out now.
5. **The fix working:** the capture of the fix and the real test results (only when you supply them).
6. **The big picture:** which components changed and how they connect, when more than one did.
7. **What to review:** two or three places to read closely, each with a file and line link and the reason. When the pull request says what it leaves out, the video says that too.

There is no recap at the end: every sentence adds something new.

Next to the video, a watch page lists the chapters, the review checklist and every claim with links
to the code it is based on. Simulated visuals (terminal sessions, app screens) are always labelled.
Real captures that you supply are labelled too: "Actual screenshot" for a screenshot and "Recorded" for a
screen recording, the steps of a reproduction are labelled "Reported steps", and "Real output" marks lines
of a log you supply (see
[the storyboard guide](docs/storyboard.md)).

## Show the bug, then the fix

Add a screen recording, the steps and real test output. MergeStory puts them in the story and labels each
one as real. See [the bug-fix demo](examples/bugfix-demo/README.md).

<table>
<tr>
<td width="50%"><img src="docs/assets/frame-bug.webp" alt="A video frame with a screen recording of a basket page. The camera has zoomed in on the count, 23 items, labelled: 23, not 5."></td>
<td width="50%"><img src="docs/assets/frame-fix.webp" alt="A video frame with two screenshots of the basket page. Before the fix the count reads 23 items. After it, 5 items."></td>
</tr>
</table>

## MergeStory for Chrome

**Now playing inside your pull request.** Click the MergeStory link in the comment. The video plays right
there, next to the code. No new tab.

<a href="https://chromewebstore.google.com/detail/mergestory/kgchkgdmnjfbkabmmcnmhjkndehhcehl"><img src="docs/assets/chrome-in-pr.webp" alt="A pull request page. In a comment, the MergeStory link was clicked, and the video plays inside the comment." width="100%"></a>

- **Made for GitHub.** Each reviewer installs it once. It plays videos on YouTube and Google Drive, and any
  other link opens as before.
- **Nothing loads until you click.** No request goes to a video host before that.
- **No data, no settings, no account.** Free and open source.

**[Add to Chrome](https://chromewebstore.google.com/detail/mergestory/kgchkgdmnjfbkabmmcnmhjkndehhcehl)** · [Watch the 30-second film](https://www.youtube.com/watch?v=80lZhMxjrs0) · [Source](https://github.com/PiniShv/mergestory-chrome)

## In short

- **Every line cites the code.** Each narration line cites evidence from the change, and the code on screen is
  read from the repository, never generated. Claims nobody can check, like "all tests pass", are removed unless
  real test results were supplied.
- **No MergeStory fee.** By default, MergeStory itself calls no paid service.[^cost] The real cost is your coding
  agent's usage: about 20 cents per video if you pay per token. [See what it costs and why.](#what-it-costs)
- **Private by default.** No telemetry. Nothing from your code leaves your machine unless you set it up.
  [See what is protected.](#privacy-and-security)
- **Works with your agent.** An Agent Skill for Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Goose, Amp,
  Gemini CLI, Windsurf, Kiro and Cline. Also a CLI, an HTTP API, a library and a GitHub Actions example.
  [Install the skill.](#use-it-from-a-coding-agent)

## Get started

Requirements: Node.js 22.12+, git, [FFmpeg](https://ffmpeg.org/download.html), and Google Chrome or
another Chromium browser (or `npx playwright install chromium-headless-shell`).

```bash
npm install -g mergestory
```

```bash
mergestory doctor
```

Explain a pull request (the video stays on your machine):

```bash
mergestory generate https://github.com/acme/weather-app/pull/42
```

The first English video installs the free voice once (about 400 MB, then the voice model), so it
takes a minute or two longer. Nothing from the change is sent. To do it ahead of time, for example in CI,
run `mergestory setup kokoro`.

Or a local branch, without a pull request. This works with every git host:

```bash
mergestory generate . --base main --head feature/retry
```

Or one video for a change in several repositories, for example a fix that works only when two pull requests
are merged together. Give each repository as a `--source` (see [the demo](examples/two-repos-demo/README.md)):

```bash
mergestory generate --source acme/orders-api#12 --source acme/storefront#7 --storyboard storyboard.json
```

Try it on the included demo project ([how it works](examples/demo/README.md)):

```bash
./examples/demo/create-demo-repo.sh /tmp/mergestory-demo
```

```bash
mergestory generate /tmp/mergestory-demo --base main --head feature/retry
```

The result points to `video.mp4` and a local watch page. Add `--dry-run` to see the plan, the cost
estimate and what would leave the machine, without rendering anything.

## Use it from a coding agent

Install the skill, then ask the agent to "explain this PR as a video". After it opens a pull request,
the agent offers a video and makes one only when you say yes.

| Agent | Install |
|---|---|
| Many agents at once | `npx skills add PiniShv/MergeStory` (needs Node.js 22.20 or newer) |
| Claude Code | `/plugin install mergestory --marketplace PiniShv/MergeStory` (Claude Code 2.1.275 or newer). On older versions: `/plugin marketplace add PiniShv/MergeStory`, then `/plugin install mergestory@mergestory`. |
| Claude Code, by hand | copy `plugins/mergestory/skills/mergestory` to `~/.claude/skills/mergestory` (all projects) or `<project>/.claude/skills/mergestory` (one project). Claude Code does not read `.agents/skills`. |
| Codex, GitHub Copilot (VS Code, CLI and cloud agent), Cursor, OpenCode, Goose, Amp, Gemini CLI, Antigravity | copy `plugins/mergestory/skills/mergestory` to `.agents/skills/mergestory` (one project) or `~/.agents/skills/mergestory` (all projects). Copilot also reads `.github/skills`, and Cursor also reads `.cursor/skills`. |
| GitHub CLI | `gh skill install PiniShv/MergeStory mergestory` (GitHub CLI 2.90 or newer) |
| Windsurf (now Devin Desktop) | copy to `.devin/skills/mergestory`. It also reads `.agents/skills`. |
| Kiro | copy to `.kiro/skills/mergestory` |
| Cline | copy to `.cline/skills/mergestory` or `.claude/skills/mergestory` |

Gemini CLI is now for Code Assist. Other people use Google's Antigravity CLI (`agy`). Both read
`.agents/skills`.

With the skill, the agent writes the storyboard itself from MergeStory's evidence pack. The agent
knows why it made each decision, so the story is better, and MergeStory calls no extra paid model.
Reading the evidence pack and writing the storyboard is extra usage in your agent's session. The engine
still checks every claim and every line reference before rendering. See [the storyboard
format](docs/storyboard.md). The skill itself is in
[plugins/mergestory/skills/mergestory/SKILL.md](plugins/mergestory/skills/mergestory/SKILL.md).

## Share the video

By default a video stays on your machine. Look at it first, and share it when you are happy:

```bash
mergestory publish <run-id> --publish s3 --comment
```

You can also upload while you generate: `mergestory generate <pull request> --publish s3 --comment`.

- **S3-compatible storage** (Cloudflare R2, Amazon S3, Backblaze B2, Google Cloud Storage, or your own
  server): private links that expire in 7 days at most, permanent links behind your team's sign-in
  (`--visibility protected`), or public links for public code.
- **YouTube:** `--publish youtube` uploads to your own channel. The video is unlisted unless you choose
  otherwise.
- **Google Drive:** `--publish drive` uploads to a `MergeStory` folder in your own Drive. The link is
  private by default; `--visibility protected` opens it to your Google Workspace organization.
- **The pull request:** `--comment` posts one comment with the link, and `--update-description` adds a
  short section to the description. Both need a video that is not only on your machine.

Public links for a private repository are blocked unless you allow them. Set-up guides:
[hosting your videos](docs/hosting.md), [publishing to YouTube](docs/youtube.md) and
[publishing to Google Drive](docs/drive.md).

With [MergeStory for Chrome](#mergestory-for-chrome), a click on the link in the comment plays the video
inside the pull request page.

## Use it in CI

Run the CLI in GitHub Actions on labelled pull requests and post the link as a comment. Copy
[`examples/github-actions/mergestory.yml`](examples/github-actions/mergestory.yml) and read
[docs/github-actions.md](docs/github-actions.md).

## Configuration

Everything works with no configuration. A flag beats an environment variable, and an environment
variable beats the config file. Common options:

| What | Flag | Environment variable |
|---|---|---|
| Storyboard by an LLM | `--llm anthropic` (or `openai`, `openai-compatible`) | `MERGESTORY_LLM_PROVIDER`, plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| Voice | `--tts kokoro` (local), `say` (macOS), `openai`, `elevenlabs`, `none` | `MERGESTORY_TTS_PROVIDER` |
| Upload | `--publish s3` (or `youtube`, `drive`) | `MERGESTORY_PUBLISH_PROVIDER`, `MERGESTORY_S3_BUCKET`, `MERGESTORY_S3_ENDPOINT`, credentials |
| Comment on the PR | `--comment` (needs an uploaded video) | `GITHUB_TOKEN` (or the `gh` CLI login) |
| Budget per run | `--budget 0.25` | `MERGESTORY_BUDGET_USD` |
| Quality | `--quality draft`, `standard`, `high` | `MERGESTORY_QUALITY` |
| Theme | `--theme midnight` (or `paper`, `high-contrast`, `terminal`, [your own](docs/themes.md)) | `MERGESTORY_THEME` |
| Config file | none | `MERGESTORY_CONFIG` (default: `~/.mergestory/config.json`) |

Local voice: English videos use Kokoro, an open neural voice that runs on your machine. The
first English video installs it once (about 400 MB plus a one-time model download), and
`mergestory setup kokoro` does it ahead of time. `--tts say` (macOS) or `--tts none` skips it.

Full reference: [docs/configuration.md](docs/configuration.md) and [docs/cli.md](docs/cli.md).

## What it costs

A default run calls no paid service, so MergeStory adds **$0** per video.[^cost] Other costs can still apply.

| Step | Default | Cost |
|---|---|---|
| Storyboard (the script) | Written by the coding agent you already use, from MergeStory's evidence pack. Without an agent, built offline from the analysis. | No MergeStory charge. Your agent reads the evidence pack and writes the script: extra usage, billed by its provider if you pay per token. |
| Voice | Kokoro, an open neural voice for English that runs on your own CPU. Installed once (about 400 MB plus the model download). | No fee. Uses your machine and disk. |
| Rendering | Your own browser draws each frame from a JSON plan. FFmpeg encodes. Same input, same video. | No fee. Uses your machine, or your CI minutes in CI. |
| Checks | Every claim and line reference is checked locally. | $0 |
| Sharing | Local by default. YouTube or Google Drive on your own account, or object storage. | Local: nothing. YouTube: no storage fee. Drive: your storage quota. R2 and S3: billed by the provider for storage and requests, and S3 also for data transfer out. |

### Why it is so cheap

- The agent already understands the change, so it writes the story. No second model reads the change again.
- The voice is open and runs on your CPU.
- Your own browser and FFmpeg render the video. No render farm, no cloud GPU.
- The checks run on your machine.
- A budget check runs before each paid MergeStory call, using estimated prices. It is a safeguard, not a
  guarantee. Every run prints its estimated cost.

Paid services are opt-in, and their providers bill your own account. A storyboard by Claude Haiku 5.5
(`--llm anthropic`) is estimated at under $0.01 per video, from list prices checked 2026-11. Providers change
prices, and your provider's bill is the final word. The default budget is $0.25 per run, checked before every
paid call. To cap your real bill, set a spending limit or alert with each provider.

Read [the full cost breakdown](docs/cost.md).

▶ [Watch the short film on what it costs.](https://www.youtube.com/watch?v=qdXa9S12tpg) It shows the
default settings. See [what can still cost money](docs/cost.md#what-can-still-cost-money).

## Privacy and security

MergeStory reads code that may be private, so the defaults are strict: no telemetry, no uploads
unless configured, a one-time download of the free voice that sends nothing from the change, sensitive files (`.env`, keys, credentials) never shown or sent, secrets masked
in all text (captions, narration, code and logs), private links that expire (or permanent links behind your
team's sign-in), and read-only access to your repository. Screenshots and recordings you supply are shown as they
are, apart from the regions you ask to hide. Details: [SECURITY.md](SECURITY.md).

## How it works

MergeStory **reads** the change. Your coding agent **tells** the story. The engine **checks** every claim before
it renders a single frame. Then you get an MP4, captions (VTT and SRT), a poster image and a local watch page.

```mermaid
flowchart LR
  PR[Pull request or branch] --> AN[Analyzer]
  AN --> SB[Storyboard]
  SB --> GR[Grounding checks]
  GR --> NA[Narration]
  NA --> RE[Renderer]
  RE --> PU[Publish]
  PU --> LINK[Link on the PR]
```

The engine (`packages/engine`) is the product. The Agent Skill (`plugins/mergestory/skills/mergestory`) is a thin
adapter, packaged as a Claude Code plugin in `plugins/mergestory`. Videos are rendered programmatically from a JSON plan by a deterministic HTML runtime and
FFmpeg, so the same input gives the same video. Read [docs/architecture.md](docs/architecture.md).

## Documentation

- [Architecture](docs/architecture.md)
- [CLI reference](docs/cli.md)
- [Configuration](docs/configuration.md)
- [Themes](docs/themes.md)
- [What it costs](docs/cost.md)
- [Storyboard format](docs/storyboard.md)
- [GitHub Actions](docs/github-actions.md)
- [Videos for many pull requests](docs/batch.md)
- [HTTP API and library](docs/api.md)
- [Hosting your videos](docs/hosting.md)
- [Publishing to YouTube](docs/youtube.md)
- [Publishing to Google Drive](docs/drive.md)
- [The demo](examples/demo/README.md)
- [MergeStory for Chrome](https://chromewebstore.google.com/detail/mergestory/kgchkgdmnjfbkabmmcnmhjkndehhcehl) ([source](https://github.com/PiniShv/mergestory-chrome))
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## License

[Apache-2.0](LICENSE). The software is provided "as is", without warranties, and the license limits liability
(sections 7 and 8). Bundled fonts: Inter and JetBrains Mono (SIL Open Font License 1.1).

GitHub, YouTube, Google Drive and Chrome are trademarks of their owners. MergeStory is not affiliated with them.

[^cost]: MergeStory is open source, and a default run calls no paid service, so MergeStory itself adds no charge. Your coding agent's usage, any model or voice you turn on, storage and CI minutes can still cost money, and their providers bill you. See [what can still cost money](docs/cost.md#what-can-still-cost-money).

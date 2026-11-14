# mergestory

**Every change has a story.**

MergeStory turns a pull request into a short, narrated video that explains what changed, why, and
what to review. The code on screen is read from the repository, every narration line cites evidence
from the change, and nothing from your code or the change leaves your machine unless you configure it.

This package is the engine: the `mergestory` command, an HTTP API and a library. The project
README (`README.md` at the root of the repository) has the full documentation: the agent skill,
GitHub Actions, configuration, costs, privacy and how it works.

## Install

You need Node.js 22.12 or newer, git, [FFmpeg](https://ffmpeg.org/download.html), and Google Chrome
or another Chromium browser.

```bash
npm install -g mergestory
```

```bash
mergestory doctor
```

## Use

Explain a pull request. The video stays on your machine:

```bash
mergestory generate https://github.com/acme/weather-app/pull/42
```

Explain a local branch, or see the plan and the cost first:

```bash
mergestory generate . --base main --head feature/retry
```

```bash
mergestory generate . --dry-run
```

Pick a theme, or make one from your brand color and logo:

```bash
mergestory generate . --theme paper
```

```bash
mergestory theme init acme --accent "#ff7a1a" --logo logo.png
```

By default no paid service is called, speech and rendering run locally, and links are private.
Run `mergestory --help` or `mergestory <command> --help` for every option.

## What it costs

**MergeStory charges nothing.** A default run calls no paid service. Speech and rendering run on your machine.

| Step | Default | Cost |
|---|---|---|
| Storyboard | written by your coding agent, or built offline | no MergeStory charge; extra usage for your agent, billed by its provider if you pay per token |
| Voice and rendering | local | no fee; uses your machine (the voice is a one-time download of about 400 MB, plus the voice model) |
| Storyboard with Claude Haiku 5.5 (opt-in) | `--llm anthropic` | estimated under $0.01, billed by Anthropic to your account |

Every run prints its estimated cost. A budget ($0.25 by default) is checked before each paid model or voice
call. It is a safeguard, not a guarantee of your final bill.

Other costs can still apply, and their providers bill you: your coding agent's usage, any model or voice you
turn on, storage and downloads, and CI minutes. Prices are estimates from list prices checked 2026-11. To cap
your real bill, set a spending limit or alert with each provider.
Read more at https://mergestory.pinishv.com and in
https://github.com/PiniShv/MergeStory/blob/main/docs/cost.md.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. The software is provided "as is", without warranties, and the license limits
liability (sections 7 and 8).

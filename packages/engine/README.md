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

By default no paid service is called, speech and rendering run locally, and links are private.
Run `mergestory --help` or `mergestory <command> --help` for every option.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

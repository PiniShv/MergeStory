# MergeStory for Claude Code

Explain a pull request as a short narrated video for reviewers: animated diagrams, the real code,
captions and a review checklist.

## Install it

```
/plugin install mergestory --marketplace PiniShv/MergeStory
```

## Use it

Ask Claude to "explain this pull request as a video", or type `/mergestory:mergestory`. Claude checks
the machine, writes a storyboard from the change, and renders the video on your machine. The result is
an MP4 and a watch page with the chapters and the checklist.

You need Node.js 22.12 or newer, git, FFmpeg, and Chrome or another Chromium browser. If the engine
or FFmpeg is missing, Claude asks before it installs it.

Claude Code asks for your approval before the skill runs, and before each engine step that reads
the change (`analyze`, `validate`, `generate`). Uploading a video is always a separate step that
you approve.

## Data

By default nothing from your code leaves the machine. That changes only when you ask to publish the
video, or when your team set up a paid voice for MergeStory. The first English video downloads a free
voice once, from the npm registry and `huggingface.co`, and sends nothing from the change. There is
no telemetry.

The engine is the [`mergestory`](https://www.npmjs.com/package/mergestory) package. Documentation and
source: [github.com/PiniShv/MergeStory](https://github.com/PiniShv/MergeStory).

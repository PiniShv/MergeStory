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

Claude Code asks for your approval once, before the skill runs. After that its own steps run without
a question: they explain only the repository you are in, keep their files under `~/.mergestory`, and
render on your machine. Installing the engine or FFmpeg, explaining a pull request of another
repository, and uploading a video are separate steps that you approve.

## Data

By default nothing from your code leaves the machine. That changes only when you ask to publish the
video, or when your team set up a paid voice for MergeStory. The first English video downloads a free
voice once, from the npm registry and `huggingface.co`, and sends nothing from the change. There is
no telemetry.

## Cost

After you open a pull request, Claude offers a video and makes one only when you say yes.

MergeStory adds no charge by default. Writing the storyboard is extra usage in your Claude Code
session: Claude reads MergeStory's instructions and evidence pack, often more than 10,000 tokens. If
you pay per token, that usage is billed to you. A model or a cloud voice that you turn on, storage and
CI minutes can also cost money. See [what can still cost
money](https://github.com/PiniShv/MergeStory/blob/main/docs/cost.md#what-can-still-cost-money).

The engine is the [`mergestory`](https://www.npmjs.com/package/mergestory) package. Documentation and
source: [github.com/PiniShv/MergeStory](https://github.com/PiniShv/MergeStory).

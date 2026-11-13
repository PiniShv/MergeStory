# The demo

A small weather API client learns to retry. Use it to try MergeStory without a pull request, an account or an API key.

**The change.** `WeatherClient.getForecast` now retries temporary failures (network errors, HTTP 429 and 5xx) with exponential backoff and jitter. It honours `Retry-After`, and other 4xx errors fail at once. A new helper, `withRetry`, holds the retry loop.

## What is in this folder

| File | What it is |
|---|---|
| `create-demo-repo.sh` | Makes the demo repository, with the branches `main` and `feature/retry`. |
| `base/`, `feature/` | The files of the two branches. |
| `task.md` | The task, as its author wrote it. |
| `notes.md` | The author's notes: the decisions, and what to review with care. |
| `tests.json` | One test run that the author reports (`npm test`, 5 passed). MergeStory shows it as reported. It never runs tests. |
| `storyboard.json` | A storyboard written by hand for this change. |

## Set up

Create the repository outside this one. MergeStory never writes into the repository it explains.

```bash
./examples/demo/create-demo-repo.sh /tmp/mergestory-demo
```

Run the commands below from this folder:

```bash
cd examples/demo
```

If you work from a clone of this repository, use `node ../../packages/engine/src/cli/main.ts` in place of `mergestory`.

## Three ways to make the video

### 1. Offline storyboard (no paid service)

The default. The storyboard is built on this machine from the diff, the task and the notes. No model is called and nothing is sent anywhere.

```bash
mergestory generate /tmp/mergestory-demo --base main --head feature/retry --task-file task.md --notes-file notes.md --tests-file tests.json
```

Add `--dry-run` to see the plan first: the scenes, the estimated length and cost, and what would leave the machine (nothing from the change; on a first run, the one-time voice download). Without the three context files the storyboard says what changed from the diff alone. With them it also quotes the notes next to the code they explain.

### 2. Write the storyboard yourself

This is what a coding agent does with the MergeStory skill. First `analyze` writes the facts a storyboard may use, each with an id.

```bash
mergestory analyze /tmp/mergestory-demo --base main --head feature/retry --task-file task.md --notes-file notes.md --tests-file tests.json --out /tmp/mergestory-demo-work
```

Read `evidence.md` and `AUTHORING.md` in that folder, then write a `storyboard.json`. The one in this folder is ready, so you can skip that step. Check it against the change:

```bash
mergestory validate storyboard.json /tmp/mergestory-demo --base main --head feature/retry --task-file task.md --notes-file notes.md --tests-file tests.json
```

Then render it:

```bash
mergestory generate /tmp/mergestory-demo --base main --head feature/retry --task-file task.md --notes-file notes.md --tests-file tests.json --storyboard storyboard.json
```

Every claim and every code range is checked again before anything is rendered.

### 3. Storyboard from a language model

Put your own key in the environment. MergeStory reads it from there and never writes it to a file.

```bash
export ANTHROPIC_API_KEY=<your key>
```

```bash
mergestory generate /tmp/mergestory-demo --base main --head feature/retry --task-file task.md --notes-file notes.md --tests-file tests.json --llm anthropic
```

Run it with `--dry-run` first. It shows the estimated cost and what would be sent to the model: the diff, the code around it, and the task and notes you passed. The budget (`--budget`, 25 cents by default) is checked before each paid call, using estimated prices. It is a safeguard, not a guarantee of your final bill.

## What to expect

| | Storyboard from | Cost |
|---|---|---|
| 1 | the offline generator | no paid call |
| 2 | `storyboard.json`, written by hand or by your coding agent | no paid call from MergeStory (an agent's own usage is billed by its provider) |
| 3 | a language model | an estimated fraction of a cent for this change, billed by the provider |

The video is about two minutes long with any of the three. The length follows the size of the change.

Speech and rendering run on your machine. They add no provider charge, but they use your machine's time and power. Rendering takes one to three minutes. The first video installs the free Kokoro voice once, which takes a minute or two longer. Run `mergestory setup kokoro` to do it ahead of time, or add `--tts none` for a silent video with captions. `mergestory doctor` checks what is installed.

Every name and number in the video comes from the change. The video says that tests passed only because `tests.json` reports it, and it says who reported it.

## Where the output goes

Each run writes one folder, `~/.mergestory/runs/<run-id>/`. Set `MERGESTORY_HOME` to move the home folder, or pass `--out <dir>` to choose the folder for one run.

- `watch/index.html`: open this in a browser. It has the video, the chapters, the review checklist and every claim with a link to the code it comes from.
- `video.mp4`, `poster.jpg`, `captions.vtt`: the video and its parts.
- `storyboard.json`: the storyboard that was used. Compare the three to see how they differ.

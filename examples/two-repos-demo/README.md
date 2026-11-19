# The two-repositories demo

A shop page showed a total that was a hundred times too big. The service (`orders-api`) gave the total in cents under the name `total`, and the page (`storefront`) showed it as euros. The fix needs a change in both repositories, and each change alone leaves the page wrong. This demo makes one video for the two changes. It needs an engine newer than 1.7.0.

The shop, its names and its prices are made up.

## What is in this folder

| File | What it is |
|---|---|
| `create-demo-repos.sh` | Makes the two repositories in one folder. Each has the branches `main` (before) and `fix/total-cents` (the fix). |
| `orders-api/`, `storefront/` | The files of each repository: `base/` is `main`, `feature/` is the fix. |
| `task.md`, `notes.md` | The task and the author's notes. They become the evidence ids `TASK` and `NOTES`. |
| `storyboard.json` | A storyboard written by hand. It cites ids of both repositories (`A.` is `orders-api`, `B.` is `storefront`), shows the code of both, and draws both in the architecture scene. |

## Make the video

You need Node and FFmpeg. Run the commands from the root of this repository. If you work from a clone, use `node packages/engine/src/cli/main.ts` in place of `mergestory`.

Create the repositories outside this one:

```bash
./examples/two-repos-demo/create-demo-repos.sh /tmp/mergestory-two-repos
```

Give every repository as its own `--source`, with the range of its change. The letters follow the names of the repositories, not the order of the flags: `A` is `orders-api` and `B` is `storefront`. Check the storyboard:

```bash
mergestory validate examples/two-repos-demo/storyboard.json --source /tmp/mergestory-two-repos/orders-api:main..fix/total-cents --source /tmp/mergestory-two-repos/storefront:main..fix/total-cents --task-file examples/two-repos-demo/task.md --notes-file examples/two-repos-demo/notes.md
```

Render it. Add `--tts none` for a silent video. A run with several sources needs a storyboard: MergeStory does not write one for it on its own.

```bash
mergestory generate --source /tmp/mergestory-two-repos/orders-api:main..fix/total-cents --source /tmp/mergestory-two-repos/storefront:main..fix/total-cents --task-file examples/two-repos-demo/task.md --notes-file examples/two-repos-demo/notes.md --storyboard examples/two-repos-demo/storyboard.json
```

To write your own storyboard for the two repositories, run `analyze` with the same `--source` flags and read `AUTHORING.md` and `evidence.md` in the folder it makes.

## For your own changes

- Use a pull request as a source in the same way: `--source https://github.com/owner/repo/pull/7`. Then the title card must name every pull request, with its repository name and its number.
- Nothing is posted to a pull request when there are several sources. Post the link on each pull request yourself.

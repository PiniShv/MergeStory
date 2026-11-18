# The bug-fix demo

A basket page shows "23 items" when someone types 2 and 3. The fix turns the two quantities into numbers. This demo shows the bug and the fix in the video, as a screen recording and as screenshots, and it needs engine 1.7.0 or newer.

MergeStory does not record anything. `capture.mjs` opens the page in a browser, types 2 and 3, and writes the recordings and the screenshots. Nothing is committed: the captures are made each time you run it.

## What is in this folder

| File | What it is |
|---|---|
| `create-demo-repo.sh` | Makes the demo repository, with the branches `main` (the bug) and `fix/basket-count` (the fix). |
| `base/`, `feature/` | The files of the two branches: `index.html`, `basket.js`, and in `feature/` a test file. |
| `capture.mjs` | Makes `before.png`, `after.png`, `before.mp4` and `after.mp4` from the two versions of the page, and `count.json`: where the text of the item count is in each picture, as fractions of it. A test checks the boxes in `storyboard.json` against it. |
| `task.md`, `notes.md`, `tests.json` | The task, the author's notes and one reported test run (3 tests, `node --test`). |
| `storyboard.json` | A storyboard written by hand: the bug, the code, the fix, then the two screenshots side by side. It points at the item count with `highlights`, and the camera zooms into the count in the first recording with `focus`. |

## Make the video

You need Node, FFmpeg, and a Chrome or Chromium browser. Set `MERGESTORY_BROWSER_PATH` to the browser's program. `capture.mjs` runs `ffmpeg` from the `PATH`, or the program that `MERGESTORY_FFMPEG_PATH` names. Run the commands from the root of this repository. If you work from a clone, use `node packages/engine/src/cli/main.ts` in place of `mergestory`.

Create the repository outside this one, and the captures in a folder of your own:

```bash
./examples/bugfix-demo/create-demo-repo.sh /tmp/mergestory-bugfix-demo
```

```bash
node examples/bugfix-demo/capture.mjs /tmp/bugfix-captures
```

Check the storyboard:

```bash
mergestory validate examples/bugfix-demo/storyboard.json /tmp/mergestory-bugfix-demo --base main --head fix/basket-count --task-file examples/bugfix-demo/task.md --notes-file examples/bugfix-demo/notes.md --tests-file examples/bugfix-demo/tests.json --screenshot "/tmp/bugfix-captures/before.png:The basket before the fix:before" --screenshot "/tmp/bugfix-captures/after.png:The basket after the fix:after" --recording "/tmp/bugfix-captures/before.mp4:The basket page before the fix: typing 2 and 3 shows 23 items:before" --recording "/tmp/bugfix-captures/after.mp4:The basket page after the fix: typing 2 and 3 shows 5 items:after"
```

Render it. Add `--tts none` for a silent video:

```bash
mergestory generate /tmp/mergestory-bugfix-demo --base main --head fix/basket-count --task-file examples/bugfix-demo/task.md --notes-file examples/bugfix-demo/notes.md --tests-file examples/bugfix-demo/tests.json --storyboard examples/bugfix-demo/storyboard.json --screenshot "/tmp/bugfix-captures/before.png:The basket before the fix:before" --screenshot "/tmp/bugfix-captures/after.png:The basket after the fix:after" --recording "/tmp/bugfix-captures/before.mp4:The basket page before the fix: typing 2 and 3 shows 23 items:before" --recording "/tmp/bugfix-captures/after.mp4:The basket page after the fix: typing 2 and 3 shows 5 items:after"
```

## Tips for your own captures

- Use a small browser window (this demo uses 960 by 540). The video scales a clip down to fit its window, so text from a large window gets too small to read.
- Use `zoom` in the storyboard when only a part of the page matters.
- To draw the eye to one spot, add a box to `highlights`. Measure it on your own capture, as fractions of the picture, leave room for a font that is wider than yours, and give it the beat of the narration line that talks about it. Add a `focus` when that spot is small. Check the box in a rendered frame.
- The scene lasts as long as its narration. Write enough words for the clip, or set `speed`.

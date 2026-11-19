# Troubleshooting MergeStory runs

Read this when a command fails. Every error has a `hint`; start there. Run `mergestory doctor --json`
to see the state of the environment.

## The storyboard does not validate (exit code 3)

`agent validate`, `validate` and `generate --storyboard` report three lists. Only `errors` stop a run. `warnings` and
`fixes` say what the engine removed or changed on its own, so read them too: a line can disappear
without any error.

- **An evidence id that is not in `evidence.md` is not an error.** The engine removes it and adds a
  line to `fixes` ("removed unknown evidence id"). A narration line with no valid id left is removed,
  with an `uncited-line` warning. It becomes an error only when no line of a scene keeps an id.
- **A removed `TASK`, `NOTES`, `T1`, `REPRO`, `SS1`, `RC1` or `L1` means that context is missing.** With the `agent`
  commands, `task.md`, `notes.md`, `tests.json`, `repro.json` and `redact.json` must be in the work folder before `agent analyze`
  runs. With the other commands, use the same `--task-file`, `--notes-file`, `--tests-file`, `--repro-file`,
  `--screenshot`, `--screenshots-dir`, `--recording`, `--redact` and `--log` flags for `validate` and `generate` that you used for `analyze`. Otherwise those ids
  do not exist. A removed `SS1` or `RC1` means that the picture or recording was not passed to this command (or that the
  `screenshots/` or `recordings/` folder lacks the file, or the engine is older than the one that reads it). A removed
  `L1.120-140` means the same for a log, or that the range is not valid: it must lie inside the log, at most
  200 lines (`evidence.md` says how many lines each log has). Logs and `"log"` in `tests.json` need an
  engine newer than 1.7.0. Version 1.7.0 and older refuse a `tests.json` with a `log` field: remove it.

These codes are errors:

| Code | What it means | What to do |
|---|---|---|
| `schema` | A field is missing, has the wrong type, or has a value that is not allowed. | Write every field. Use `null` or `[]` when there is nothing to say. |
| `too-few-scenes` | There are fewer than 2 scenes. | Add a mission scene and a conclusion. |
| `no-narration` | A scene has no narration, or every line of it was removed. | Write lines that state what the change shows, and cite evidence. |
| `uncited-line` | No line of a scene cites a valid evidence id. | Cite ids from `evidence.md` on every line. |
| `code-ref-unknown-path` | The path is not a changed file. | Copy the path exactly from the Files table of `evidence.md`. |
| `code-ref-sensitive` | The file is sensitive or excluded, so it is never shown. | Choose another file. |
| `code-ref-binary` | The file is binary. | Choose a text file. |
| `code-ref-missing` | A code panel has no `codeRef`. | Add the path, the side and the lines. |
| `screenshot-unknown` | A screenshot visual names an id that was not supplied. | Use an `SS` id from `evidence.md`, or another visual. |
| `recording-unknown` | A recording visual names an id that was not supplied. | Use an `RC` id from `evidence.md`, or another visual. |
| `recording-trim-out-of-range` | A recording `trim` has less than 0.2 seconds inside the clip. | Choose a part that lies inside the clip. |
| `repro-unknown` | A `repro` visual has no reproduction to show: none was supplied (this needs an engine newer than 1.7.0), or none of its steps exists. | Write `repro.json` (or pass `--repro-file`) and list steps from `REPRO.1`, or use another visual. |
| `log-unknown` | A log visual names an id that was not supplied. | Use an `L` id from `evidence.md`, or another visual. |
| `log-range-out-of-range` | The lines of a log visual lie fully outside the log. | Choose lines inside the log. |
| `simulated-unbacked` | A terminal or browser visual has narration that cites no file, hunk or symbol id. | Cite an `F`, `F.H` or `S` id that shows the behaviour. |
| `empty-text` | A text that is shown is empty. | Write it. |

These codes are warnings. The engine fixed the problem, and the run goes on. Check that nothing you
wanted is gone:

| Code | What it means | What to do |
|---|---|---|
| `unverified-claim` | A sentence says that tests pass, CI is green, or gives a speed-up, a coverage figure or a word such as "secure". It was removed. | Cite a passing test run you reported with `--tests-file` (`T1`), or leave the claim out. |
| `unknown-identifier` | A sentence names a function, file or constant that is not in the change. It was removed. | Check the spelling against `evidence.md`. A name that only the pull request text or the notes hold needs a line that cites that source. |
| `url-in-text` | A sentence has a web address that is not in the code. It was removed. | Write it without the address. |
| `internal-term` | A sentence says "the pack" or "the evidence pack". The viewer has never seen it. The sentence stays. | Say what the change shows. |
| `code-ref-out-of-range` | The lines do not exist in the file. The visual became the changed-files overview. | Copy the line numbers from the hunk in `evidence.md`. |
| `code-ref-unreadable` | The file could not be read at that side. For a code visual this is an error. | Use the other side or another file. If no code can be shown, use a visual without code and do not walk through that file's code in the narration. |
| `diff-too-tall` | A diff view needs more than 18 rows, because it shows the removed lines too. This is an error. | Use the range the message names, and describe only lines that are on screen. Or set `mode` to `snippet`, which shows no removed lines, and do not describe the removed lines. |
| `no-evidence` | A new or changed node, step or item cites no valid evidence. | Cite an `M`, `F`, `S` or `R` id. |
| `recording-unknown` | A before and after panel names a recording that was not supplied. The panel shows its bullets instead. | Use an `RC` id from `evidence.md`. |
| `recording-trim-out-of-range` | A recording `trim` reached outside the clip. It was cut to fit. | Check the part that is shown. |
| `recording-too-long` | A recording scene would show more than 20 seconds. The clip was shortened from its end. | Pick the part that matters with `trim`. |
| `highlight-label-too-long` | The `label` of a highlight has more than 40 characters. It was cut at a word and ends in "…". | Write a shorter label. |
| `repro-step-unknown` | A `repro` visual lists a step that the reproduction does not have. The step was dropped. | List only steps from `REPRO.1` up to the last step. |
| `log-range-out-of-range` | The lines of a log visual reached outside the log. They were cut to fit. | Check the lines that are shown. |
| `log-too-long` | A log visual would show more than 18 lines. The lines were shortened from the end. | Show fewer lines, and mark the ones you discuss in `focus`. |
| `title-missing-source` | Several sources: the first title card does not name every pull request (repository name and `#<number>`). The kicker was set to the names of all the changes when they fit. | Write the names on the title card yourself. |

All the codes, and every automatic fix, are explained in `docs/storyboard.md` in the MergeStory
repository.

## Several sources (exit code 2)

- "needs a storyboard": with several `--source` flags and no model, MergeStory writes no storyboard. Run
  `mergestory analyze` with the same `--source` flags, write the storyboard, and give it to
  `generate --storyboard`.
- "--source cannot be used together": give every source as `--source <repo>[:<base>..<head>]`, with no
  source argument, `--base` or `--head`.
- "at most 4", "the same source was given more than once", "--out is inside the repository": use up to 4
  different sources, and an `--out` outside every local repository.
- "nothing is posted to a pull request": remove `--comment` and `--update-description`, and ask the user to
  post the link on each pull request. A setting in the config file only adds a warning.
- An id such as `F1` or a path such as `src/total.js` that is "removed" or "unknown": use the form with the
  letter (`A.F1`) or the folder (`orders-api/src/total.js`) that the message names.

## Nothing to explain

"There are no changes to explain": for a local repository only committed changes count. Commit the
work, or check `--base` and `--head`.

## Hidden regions fail (exit code 2)

The run stops and nothing is shown unhidden. The message names the id and the entry.

An engine of 1.7.0 or older does not know `--redact` or `redact.json`: the agent commands ignore the
file and give no error. When a part of a capture must be hidden and `mergestory --version` prints 1.7.0
or older, do not pass that capture at all.

- "Hidden regions: SS2 is not a screenshot or recording of this run": the id is not in this command. Ids
  restart at `SS1` and `RC1` in every command, and the limits drop the later files. Fix the id, or pass
  the capture.
- "has unknown field", "needs a list of regions", "needs ... as a number", "needs w and h above 0",
  "has N regions, the most is 20": fix the entry as the message says.
- "a region cannot be limited to a part of a clip": the entry has `from` or `to`. Remove them.
  A region of a recording is hidden in every frame of the clip.
- "gives SS1 twice", "gives a field twice in one region" or "has a backslash": JSON keeps only the last of
  two equal names, so the engine refuses them. Give each id once, each field once, and write no escapes.
- "Give --redact once": put all regions into one file.
- "stored turned (EXIF orientation N)": the screenshot is saved turned or mirrored. Save it upright (for
  example, export it again from the browser or an image editor), then measure the regions on it.
- "has no part inside the picture": the region lies outside
  the capture. Measure it again as fractions (0 to 1) of the whole picture.
- "cannot be shown with its hidden regions" or "could not be decoded": FFmpeg failed on that capture.
  Make the capture again, or leave it out. Never pass it without the regions.

## The agent commands refuse to run (exit code 2)

- "The agent commands only explain the repository of the current folder": the source is a pull
  request of another repository, a path, or a pull request on another host. Run the command in a clone
  of that repository, or use `mergestory analyze`, `validate` and `generate`, which the user approves.
- "... is a symbolic link or holds one": the work folder must not hold links. Remove the link that
  the hint names, or use another `--name`.
- "... is not one that a .git entry names": the current folder belongs to a bare repository, or to a
  repository that sits inside a checked-out folder. Run the command from a normal clone or work tree.
- "MergeStory does not run git in its work folder, or in a repository kept there": run the command
  from the user's clone, never from a folder under `~/.mergestory/work`.
- "There is no storyboard.json in the work folder": write it first, or check the `--name`.
- "unknown option": the agent commands take no flag that names a file, a folder, a model, a storage
  or a host. Leave it out, or use the general command, which the user approves.

## Settings problems (exit code 2)

- `Unrecognized key "..." (did you mean "...")`: a key in the config file, or a value from a
  `MERGESTORY_*` variable, is wrong. Every key is checked, so a typo is an error and never ignored.
- `Config key "..." looks like a secret`: secrets never go into the config file. Use the environment
  variable, for example `ANTHROPIC_API_KEY`.
- The config file is ignored: MergeStory reads it only from `MERGESTORY_CONFIG`, or from
  `$MERGESTORY_HOME/config.json` (default `~/.mergestory/config.json`). It never reads a file in the
  current folder, and there is no `--config` option.

## GitHub problems (exit code 5)

- 404 on a private repository: set `GITHUB_TOKEN` (or run `gh auth login`). Without a token only
  public repositories work, with 60 requests per hour.
- Rate limited: wait until the reset time in the hint, or use a token.
- A pull request on a GitHub Enterprise host: environment tokens are only sent to api.github.com or to
  the host in `github.apiUrl`. Log in to that host with `gh auth login --hostname <host>`.
- "Not a pull request reference" for a link to Bitbucket, GitLab or another host: MergeStory reads pull
  requests from GitHub only. Use the local repository path (`.`) with `--base <branch>` instead.

## Rendering problems

- FFmpeg is missing (exit code 6): ask the user, then install it (macOS with Homebrew:
  `brew install ffmpeg`; Debian or Ubuntu: `sudo apt-get install -y ffmpeg`; Windows:
  `winget install --id Gyan.FFmpeg -e`), or set `MERGESTORY_FFMPEG_PATH` and `MERGESTORY_FFPROBE_PATH`.
- The browser is missing (exit code 6): the user installs Google Chrome, or runs
  `npx playwright install chromium-headless-shell`, or sets `MERGESTORY_BROWSER_PATH`.
- `RENDER_FAILED` with "The browser captured a 1920x993 frame instead of 1920x1080" (or similar): this
  browser draws frames that are too short. MergeStory 1.2.1 and newer fix this for Google Chrome. If it
  still happens, ask the user, then run `npx playwright install chromium-headless-shell` from a folder
  outside any repository (so `npx` cannot pick up a repository's own copy), and run MergeStory with
  `MERGESTORY_BROWSER_PATH` set to the `chrome-headless-shell` program it downloaded. `mergestory doctor`
  draws one test frame and reports this before a render.
- A render is slow on a small machine: use `--quality draft`.
- Rendering stopped at the time limit (exit code 8, `RENDER_TIMEOUT`): the machine sets a limit with
  `render.maxSeconds`. No video was written. Try once with `--quality draft`. Only the person who runs
  the machine can raise the limit.
- The first English run takes a few minutes longer: it installs the free Kokoro voice once (about
  400 MB, then the voice model). No action is needed. Without network access, use `--tts none`.
- The voice install failed (exit code 5, `TTS_FAILED`): check the network and that npm works, then run
  `mergestory setup kokoro` to try again, or use `--tts say` (macOS) or `--tts none` for this run.
- No voice in the video: English videos always get the Kokoro voice, so this means `--tts none`, a
  language other than English with no macOS `say` (Kokoro speaks English only), or Windows, where
  Kokoro needs a manual install (the warning names the steps). Captions are always included.

## Publishing problems

- "Google Drive: not signed in": ask the user, then run `mergestory setup drive`. A Google page opens;
  they sign in with their company account and click Allow.
- "Protected links need a Google Workspace account": the user signed in with a personal Google
  account. Sign in again with the company account.
- The video uploaded but stayed private: the company does not allow link sharing in Drive. The video
  is in the user's Drive, in the MergeStory folder; they can share it there.
- "Skipped the PR update: the video is only on this machine": publish first (later with
  `mergestory publish <run> --comment`, which uses the team's storage). "this run was not made from a GitHub
  pull request" means there is no pull request to write to.
- Blocked to protect a private repository (exit code 7): a link that anyone can open (`--visibility public`,
  or a YouTube video that is not `private`) for a private or unknown repository needs
  `publish.allowPublicForPrivateRepos`. Prefer private links instead.
- "protected" links refused: the address answered without a sign-in. Put the domain behind an access
  proxy such as Cloudflare Access first.
- S3 credentials: set `MERGESTORY_S3_ACCESS_KEY_ID` and `MERGESTORY_S3_SECRET_ACCESS_KEY` (or the
  standard AWS variables), plus `MERGESTORY_S3_BUCKET` and, for R2 or other hosts,
  `MERGESTORY_S3_ENDPOINT`.
- YouTube "sign in again": run `mergestory setup youtube` in a terminal. Sign-ins expire after 7
  days while the Google consent screen is in "Testing".
- Exit code 5 with `ok: true`: the video is published, but GitHub refused the comment. The link in the
  result works. The warning names the command that tries the update again.

## Network errors in a sandbox

Some agents block network access by default. Tell the user which host to allow instead of retrying:
the GitHub API (`api.github.com`), the npm registry (to install the engine, and once for the Kokoro
voice packages), the storage endpoint, and `huggingface.co` once for the Kokoro voice model.

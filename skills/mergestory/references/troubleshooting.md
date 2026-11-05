# Troubleshooting MergeStory runs

Read this when a command fails. Every error has a `hint`; start there. Run `mergestory doctor --json`
to see the state of the environment.

## The storyboard does not validate (exit code 3)

`validate` and `generate --storyboard` report three lists. Only `errors` stop a run. `warnings` and
`fixes` say what the engine removed or changed on its own, so read them too: a line can disappear
without any error.

- **An evidence id that is not in `evidence.md` is not an error.** The engine removes it and adds a
  line to `fixes` ("removed unknown evidence id"). A narration line with no valid id left is removed,
  with an `uncited-line` warning. It becomes an error only when no line of a scene keeps an id.
- **A removed `TASK`, `NOTES`, `T1` or `SS1` means a context flag is missing.** Use the same
  `--task-file`, `--notes-file`, `--tests-file` and `--screenshot` flags for `validate` and `generate`
  that you used for `analyze`. Otherwise those ids do not exist.

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
| `simulated-unbacked` | A terminal or browser visual has narration that cites no file, hunk or symbol id. | Cite an `F`, `F.H` or `S` id that shows the behaviour. |
| `empty-text` | A text that is shown is empty. | Write it. |

These codes are warnings. The engine fixed the problem, and the run goes on. Check that nothing you
wanted is gone:

| Code | What it means | What to do |
|---|---|---|
| `unverified-claim` | A sentence says that tests pass, CI is green, or gives a speed-up, a coverage figure or a word such as "secure". It was removed. | Cite a passing test run you reported with `--tests-file` (`T1`), or leave the claim out. |
| `unknown-identifier` | A sentence names a function, file or constant that is not in the change. It was removed. | Check the spelling against `evidence.md`. A name that only the pull request text or the notes hold needs a line that cites that source. |
| `url-in-text` | A sentence has a web address that is not in the code. It was removed. | Write it without the address. |
| `code-ref-out-of-range` | The lines do not exist in the file. The visual became the changed-files overview. | Copy the line numbers from the hunk in `evidence.md`. |
| `code-ref-unreadable` | The file could not be read at that side. The visual became the changed-files overview. | Use the other side, or another file. |
| `diff-too-tall` | A diff view needs more than 18 rows. The range was shortened, or the mode became `snippet`. | Use a shorter range. |
| `no-evidence` | A new or changed node, step or item cites no valid evidence. | Cite an `M`, `F`, `S` or `R` id. |

All the codes, and every automatic fix, are explained in `docs/storyboard.md` in the MergeStory
repository.

## Nothing to explain

"There are no changes to explain": for a local repository only committed changes count. Commit the
work, or check `--base` and `--head`.

## Settings problems (exit code 2)

- `Unrecognized key "..." (did you mean "...")`: a key in the config file, or a value from a
  `MERGESTORY_*` variable, is wrong. Every key is checked, so a typo is an error and never ignored.
- `Config key "..." looks like a secret`: secrets never go into the config file. Use the environment
  variable, for example `ANTHROPIC_API_KEY`.
- The config file is ignored: MergeStory reads it only from `--config`, from `MERGESTORY_CONFIG`, or from
  `$MERGESTORY_HOME/config.json` (default `~/.mergestory/config.json`). It never reads a file in the
  current folder.

## GitHub problems (exit code 5)

- 404 on a private repository: set `GITHUB_TOKEN` (or run `gh auth login`). Without a token only
  public repositories work, with 60 requests per hour.
- Rate limited: wait until the reset time in the hint, or use a token.
- A pull request on another host: environment tokens are only sent to api.github.com or to the host
  in `github.apiUrl`. Log in to that host with `gh auth login --hostname <host>`.

## Rendering problems

- FFmpeg or the browser is missing (exit code 6): install FFmpeg, and Google Chrome or
  `npx playwright install chromium-headless-shell`, or set `MERGESTORY_BROWSER_PATH`.
- A render is slow on a small machine: use `--quality draft`.
- The first English run takes a few minutes longer: it installs the free Kokoro voice once (about
  400 MB, then the voice model). No action is needed. Without network access, use `--tts none`.
- The voice install failed (exit code 5, `TTS_FAILED`): check the network and that npm works, then run
  `mergestory setup kokoro` to try again, or use `--tts say` (macOS) or `--tts none` for this run.
- No voice in the video: English videos always get the Kokoro voice, so this means `--tts none`, a
  language other than English with no macOS `say` (Kokoro speaks English only), or Windows, where
  Kokoro needs a manual install (the warning names the steps). Captions are always included.

## Publishing problems

- "Skipped the PR update: the video is only on this machine": publish first, with `--publish s3` (or
  later with `mergestory publish <run> --publish s3 --comment`). "this run was not made from a GitHub
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
the GitHub API (`api.github.com`), the npm registry (for `npx`, and once for the Kokoro voice
packages), the storage endpoint, and `huggingface.co` once for the Kokoro voice model.

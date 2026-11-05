# MergeStory CLI reference (for agents)

Read this when you need a flag, a JSON field or an exit code. `mergestory <command> --help` is
always the final word for the installed version. The full reference is `docs/cli.md` in the
MergeStory repository.

## Commands you will use

| Command | What it does |
|---|---|
| `mergestory doctor --json` | Checks Node, git, FFmpeg, the browser, speech, LLM, GitHub access, publishing and disk space. Each check has `status` (pass, warn, fail) and a `fix`. Exit code 1 when a check fails. |
| `mergestory analyze <source> --out <dir> [context flags] --json` | Writes `analysis.json`, `evidence.md`, `AUTHORING.md` and `storyboard.schema.json` into `<dir>`. Free. |
| `mergestory validate <storyboard.json> <source> [context flags] --json` | Checks a storyboard against the change without rendering. Exit code 3 when it has errors. |
| `mergestory generate <source> [context flags] [--storyboard <file>] --json` | Makes the video. Without `--storyboard` the engine writes the storyboard itself (offline, or with the configured LLM). |
| `mergestory publish <run> --publish s3 [--comment] --json` | Uploads a video that was already rendered, and optionally comments on the pull request. No rendering. |
| `mergestory status <job-id> --wait --json` | Waits for a job started with `generate --async`. |

`<source>` is a pull request URL (`https://github.com/owner/repo/pull/42`), the short form
`owner/repo#42`, or a local repository path (`.`). For a local path, `--base <ref>` and `--head <ref>`
choose the range (default: the merge base with the default branch, and `HEAD`). Only committed changes
are included.

## Context flags (analyze, validate and generate)

Pass the same context flags to all three, so the evidence ids (TASK, NOTES, T1, SS1) match.

| Flag | Meaning |
|---|---|
| `--task <text>` / `--task-file <file>` | The original task (max 64 KB). Use one of them. Becomes evidence `TASK`. |
| `--notes-file <file>` | Implementation notes and decisions (max 64 KB). Becomes evidence `NOTES`. |
| `--tests-file <file>` | JSON array: `[{"command": "npm test", "passed": true, "summary": "212 passed"}]`. Only results you really ran. An optional `source` is `agent` (the default), `ci` or `user`. Become `T1`, `T2`, ... Only the first 10 are used. |
| `--screenshot <path>[:<caption>[:before\|after]]` | A real screenshot (PNG or JPEG, max 4 MB), repeatable. Becomes `SS1`, ... Only the first 6 are used. |

## Useful generate flags

| Flag | Meaning |
|---|---|
| `--quality draft\|standard\|high` | 720p 24 fps, 1080p 30 fps (default), 1080p 60 fps. |
| `--duration <sec>`, `--max-duration <sec>` | Target length (20-600 seconds, default adapts to the change) and hard cap (20-600, default 150). |
| `--tts auto\|kokoro\|say\|openai\|elevenlabs\|none` | Speech. `auto` only picks free local voices. |
| `--llm none\|anthropic\|openai\|openai-compatible` | Who writes the storyboard when none is given. Paid providers need their key in the environment. |
| `--publish local\|s3\|youtube\|none` | Where the video goes. `local` (default) keeps it on this machine. |
| `--visibility private\|protected\|public` | S3 links: signed and expiring, permanent behind a sign-in, or permanent and open. |
| `--comment`, `--update-description` | Write the link to the pull request. Needs a pull request source and a video that was published somewhere other than this machine. |
| `--budget <usd>` | Cost cap for the run (default 0.25). |
| `--dry-run` | Plan only: scenes, estimated cost and what would leave the machine. Nothing is rendered or sent. |
| `--async` | Run in the background; prints a job id. |
| `--out <dir>` | Write the run files to this folder (outside the repository). |

## JSON output

With `--json`, stdout holds exactly one JSON object; logs go to stderr.

Success of `generate` and `publish` (shortened):

```json
{
  "ok": true,
  "runId": "20261104-071500-ab12",
  "runDir": "/path/to/run",
  "title": "Retry temporary failures with exponential backoff",
  "summary": "Two sentences for reviewers.",
  "durationSec": 118.5,
  "chapters": [{ "title": "The mission", "startSec": 0 }],
  "storyboardSource": "agent",
  "files": { "video": "...", "poster": "...", "captions": "...", "storyboard": "...", "watchPage": "..." },
  "publish": { "provider": "s3", "watchUrl": "https://...", "videoUrl": "https://...", "expiresAt": "...", "visibility": "private" },
  "notify": { "commentUrl": "https://github.com/...", "descriptionUpdated": false },
  "grounding": { "groundedClaims": 21, "fixes": [], "warnings": [] },
  "cost": { "totalUsd": 0, "budgetUsd": 0.25, "records": [] },
  "egress": [],
  "warnings": []
}
```

`files.poster` is `null` when no poster image was made; check for it before you open the file.
`publish.provider` tells you where the video went. With the default `--publish local` it is `local`,
and `watchUrl` is a `file://` link to a file on this machine. `publish` is `null` only with
`--publish none`. `notify` is `null` unless a pull request update was asked for and tried. `egress`
lists every outbound transfer (host, purpose, bytes, what it contained).

`validate`: `{ "ok": true|false, "errors": [...], "warnings": [...], "fixes": [...], "groundedClaims": 21 }`.
Each error and warning has `path` (for example `scenes[3].visual.ref`), `code` and `message`. `fixes` is a
list of strings. `ok` is false only when there is an error. A warning or a fix is not an error: it says what
the engine removed or changed on its own.

Failure (any command): `{ "ok": false, "error": { "code": "GROUNDING_FAILED", "message": "...", "hint": "...", "details": { ... } } }`.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | Report the result. |
| 1 | Rendering or internal error, or `doctor` found a failed check | Show the message; retry once with `--quality draft`. |
| 2 | Usage, config or source problem | Fix the command, the path or the ref. |
| 3 | Storyboard failed validation | Read `errors` (from `validate`) or `error.details.errors` (from `generate`), fix the storyboard, validate again. |
| 4 | Budget would be exceeded | Tell the user. Do not raise `--budget` on your own. |
| 5 | A service failed (GitHub, LLM, speech, upload) | Read the hint; network or credentials are the usual cause. With `ok: true`, the video is published but the pull request update failed. |
| 6 | FFmpeg or the browser is missing | Show the install hint from the error. |
| 7 | Blocked to protect a private repository | Keep links private, or ask the user. |
| 130 | Cancelled | Nothing to do. |

# Videos for many pull requests

MergeStory makes one video per run. This page shows how to make many: with a loop in a shell, or with
GitHub Actions. It also says what a batch costs, which limits you can hit, and how to clean up.

## Before you start

- **Try one pull request first.** `mergestory generate <pull request> --dry-run` shows the plan and a high
  estimate of the cost, and renders nothing. See [`generate`](cli.md#mergestory-generate).
- **Decide where the videos go.** By default a video stays on this machine. A comment on the pull request
  needs a video that others can open: `--publish s3`, `youtube` or `drive`. See [hosting.md](hosting.md).
- **Make one video at a time on one machine.** See [What can run at the same time](#what-can-run-at-the-same-time).

## A loop in a shell

This makes a video for each of the 20 newest open pull requests of a repository, one after the other. It
needs the [GitHub CLI](https://cli.github.com) to list them.

```bash
gh pr list --repo acme/weather-app --state open --limit 20 --json url --jq '.[].url' |
while read -r url; do
  mergestory generate "$url" --json > "result-${url##*/}.json" || echo "exit code $?: $url" >&2
done
```

- **One result per pull request.** With `--json`, each run prints one JSON object, also when it fails. The
  loop saves it as `result-<number>.json`. See [JSON output](cli.md#json-output).
- **The exit code says what happened.** 0 is success. The table of [exit codes](cli.md#exit-codes) lists
  the others. One case to know: when you ask for a comment and GitHub refuses it, the video is published
  and `ok` is `true`, but the exit code is 5.
- **Each result says how long the run took** (`elapsedSec`) and what it cost (`cost`). Make two or three
  videos first, and you know what the whole batch needs on your machine.
- **Add your flags to the command**, for example `--publish s3 --comment` or `--llm anthropic`. Every flag
  of [`generate`](cli.md#mergestory-generate) works here.

To look at the videos before you share them, leave `--publish` and `--comment` out of the loop. Then upload
the ones you want with [`mergestory publish`](cli.md#mergestory-publish). It does not render them again.

## A backfill in GitHub Actions

The [example workflow](github-actions.md) makes one video when a pull request gets a label. It can also be
started by hand with a pull request number. Two ways to use that for many pull requests:

**A handful of pull requests.** Start the workflow once for each number. The workflow file must be on the
default branch, and `gh` must be signed in as someone who may run workflows.

```bash
for pr in 101 102 103; do
  gh workflow run mergestory.yml -f pr="$pr"
done
```

Each run gets its own runner. GitHub decides how many run at the same time.

**Many pull requests.** Copy the example workflow to a second file, for example
`mergestory-backfill.yml`, and change these parts. The block shows only what changes: it is not a whole
file, and the steps stay as they are in the example, except for one line.

```yaml
name: MergeStory backfill

on: workflow_dispatch

# Keep "permissions:" as it is. Remove "concurrency:".

jobs:
  video:
    # Remove "if:", and add the matrix.
    strategy:
      max-parallel: 2
      fail-fast: false
      matrix:
        pr: [101, 102, 103]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # Keep the steps. In the step that makes the video, change one line:
      #   PR_URL: ${{ format('{0}/{1}/pull/{2}', github.server_url, github.repository, matrix.pr) }}
```

`max-parallel` keeps you inside the limits below. `fail-fast: false` lets the other videos finish when one
fails. The `if:` and the `concurrency:` of the example are for the label. That `concurrency:` is also built
from the pull request number, which this copy does not get: with it, a second backfill would cancel one that
is still running.

Put the file on the default branch. Then press Run workflow on the Actions tab, or start it from a shell:

```bash
gh workflow run mergestory-backfill.yml
```

- **Let one run finish first.** The voice is a large download, and the workflow caches it. A cache does not
  exist until a run has saved it, so jobs that start together all download the voice. See
  [Caching the voice](github-actions.md#caching-the-voice).
- **Pull requests from forks.** A run that you start by hand also makes a video for a pull request from a
  fork. Its code and its text are untrusted, so choose the numbers yourself. See
  [How the workflow works](github-actions.md#how-the-workflow-works).
- **Minutes.** Each video uses runner minutes. See [What it costs](github-actions.md#what-it-costs).

## What it costs

A batch costs the price of one video, times the number of videos. [cost.md](cost.md) has the numbers.

| Who writes the storyboard | Cost of each video |
|---|---|
| Nobody: the offline storyboard (the default) | No paid service is called. |
| A model (`--llm`) | A small model call. See [A worked example](cost.md#a-worked-example). |
| A coding agent, one fresh agent for each pull request | The agent's own usage, the highest of the three. See [What the agent's usage looks like](cost.md#what-the-agents-usage-looks-like). The loop and the workflow on this page do not use an agent: this row is for a batch that a coding agent runs itself. |

**The budget is per run.** `--budget` stops one run before a paid call that would go over it. It does not
add up over a batch: 100 runs may each spend up to the budget. To cap a whole batch, set a spending limit
with the provider. See [The budget](cost.md#the-budget).

Storage, runner minutes and a paid voice are extra. See [What can still cost money](cost.md#what-can-still-cost-money).

## Limits

| Limit | What happens | What to do |
|---|---|---|
| The GitHub API | Every video reads its pull request through the API. Without a token the limit is 60 requests an hour. A token raises it: to 5,000 an hour for a personal token. The token that GitHub Actions gives a workflow has its own limit. When GitHub asks for a short pause, MergeStory waits and reads again. When the limit is used up, the run ends with `RATE_LIMITED` (exit code 5), and the hint says when the limit resets. | Set `GITHUB_TOKEN`, or sign in with `gh auth login`. Start the rest of the batch after the reset. GitHub lists the limits in [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). |
| Comments | If GitHub refuses the comment, the video is already published and the exit code is 5. | Run the command that the warning shows. It is a [`mergestory publish`](cli.md#mergestory-publish) for that run: it uploads the video again and renders nothing. |
| YouTube | A project can upload 100 videos a day, and fewer when each video also gets captions and a playlist entry. | Spread a large batch over days. See [Quota and limits](youtube.md#quota-and-limits). |
| A model | When a model call fails, for example because the provider limits your key, the run goes on with the offline storyboard and says so in the log. A budget stop (exit code 4) or a wrong setting still ends the run. | Look at `storyboardSource` in the result: `heuristic` means that the model did not write the storyboard. Run those pull requests again later, or lower `max-parallel`. |
| The size of a pull request | MergeStory reads at most 3,000 changed files of a pull request. | Nothing: very large pull requests are explained from those files. |

## What can run at the same time

- **A loop makes one video at a time.** That is the safe choice for one machine: one render already works
  on several browser pages at once (see `render.concurrency` in [configuration.md](configuration.md)).
- **`--async` has no limit.** Every `generate --async` starts its own background run at once. Twenty of
  them make twenty videos at the same time. Do not use it in a loop.
- **`mergestory serve` has a queue.** It makes one video at a time and lets 20 more wait. After that it
  answers `503` with `Retry-After: 60`. See [api.md](api.md).
- **In GitHub Actions each job has its own machine**, so jobs can run side by side. The services behind
  them cannot always: keep `max-parallel` low when you upload to YouTube or call a model.

## Disk and cleanup

Every run writes one folder under `$MERGESTORY_HOME/runs` (by default `~/.mergestory/runs`), with the
video in it. See [Run folders](cli.md#run-folders).

```bash
mergestory runs --limit 100
```

```bash
mergestory runs delete --older-than 30
```

The first command lists the newest runs: 20 without `--limit`, and 500 at most. The second removes every
run and finished background job that is more than 30 days old, and says how many bytes it freed. It removes
files on this machine only: an uploaded video stays where it is. See
[`runs delete`](cli.md#mergestory-runs-delete).

## Links and comments in a batch

- **Private links expire.** With `--publish s3`, a private link works for 7 days at most. For pull requests
  that people will open later, use `--visibility protected`, or YouTube. See [hosting.md](hosting.md).
- **A second run updates the comment.** MergeStory finds its own comment by a marker and updates it, when
  the same account wrote it. So a second run does not add a second comment. See
  [The comment](github-actions.md#the-comment).

## Related

- [GitHub Actions](github-actions.md)
- [What it costs](cost.md)
- [CLI reference](cli.md)
- [HTTP API and library](api.md)

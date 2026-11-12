# MergeStory in GitHub Actions

With one label on a pull request, GitHub Actions makes a short video of the change, uploads it to your own
storage and posts one comment with the link. This page explains the example workflow,
[`examples/github-actions/mergestory.yml`](../examples/github-actions/mergestory.yml), and what you need to
set up.

## What you get

1. A maintainer adds the label `mergestory` to a pull request. Or the maintainer starts the workflow by hand
   and types the pull request number.
2. The workflow installs FFmpeg and the free local voice, and runs `mergestory generate` for that pull request.
3. MergeStory uploads the video to your S3-compatible storage (for example Cloudflare R2) and posts one
   comment on the pull request. If the pull request already has a MergeStory comment, it updates that one.
4. The link is also written to the summary of the workflow run.

Nothing runs for every push. That keeps cost and noise down: only the pull requests that deserve a video get
one.

## Set it up

1. **Copy the workflow** to `.github/workflows/mergestory.yml` in your repository, on the default branch. The
   "Run workflow" button only appears for a workflow that is on the default branch.
2. **Create the storage.** For a first try, use a Cloudflare R2 bucket with private links. Follow
   [Cloudflare R2 with private links](hosting.md#cloudflare-r2-with-private-links). You get a bucket name, an
   address and a pair of keys. Other services work too: see [hosting.md](hosting.md).
3. **Add the variables and secrets** in the settings of the repository, under Secrets and variables, then
   Actions. The table in the next section lists them.
4. **Create a label** named `mergestory`.
5. **Try it.** Add the label to a pull request from this repository, and open the Actions tab. When the run
   ends, the comment is on the pull request. You can also open Actions, choose MergeStory, press Run workflow
   and type a pull request number.

## Variables and secrets

| Name | Where | Needed | What it is |
|---|---|---|---|
| `MERGESTORY_S3_BUCKET` | variable | yes | The name of the bucket. |
| `MERGESTORY_S3_ENDPOINT` | variable | for Cloudflare R2 and most other services | The address of the storage service, for example `https://<account-id>.r2.cloudflarestorage.com`. Leave it empty for Amazon S3. |
| `MERGESTORY_S3_ACCESS_KEY_ID` | secret | yes | The access key ID of a key that can read and write this bucket only. |
| `MERGESTORY_S3_SECRET_ACCESS_KEY` | secret | yes | The secret that belongs to it. |
| `MERGESTORY_LLM_PROVIDER` | variable | no | `anthropic` to let a model write the storyboard. The workflow uses `none` when it is not set. |
| `ANTHROPIC_API_KEY` | secret | with `anthropic` | The API key of the provider. |

GitHub makes the `GITHUB_TOKEN` itself for every run. The workflow passes it to MergeStory, which uses it to
read the pull request and to write the comment.

For another storage service, or for settings such as the region of an Amazon S3 bucket, add more lines to
the `env:` of the step "Make the video and comment on the pull request". [configuration.md](configuration.md)
lists every setting and its variable name. Keep keys in secrets and everything else in variables.

## How the workflow works

**Triggers.** The workflow starts on `pull_request` with the type `labeled`, and on `workflow_dispatch` (a
manual run with the pull request number as input). GitHub starts a run for every label that is added to a
pull request. The `if:` of the job lets only the label `mergestory` through, and the other runs are skipped.
A skipped run costs nothing.

**Fork rule.** The job never runs for a pull request from a fork. The code and the text of a fork are
untrusted. GitHub also does not pass secrets, and gives only a read-only token, to workflows that a fork's
pull request starts, so the upload could not work anyway. A manual run skips the check, because only people
with write access can start it, and they choose the pull request. Do not switch the trigger to
`pull_request_target`: that gives secrets to pull requests from forks.

**No checkout.** The job does not check out the repository. MergeStory reads the pull request through the
GitHub API and never runs its code.

**Permissions.** The workflow asks for `contents: read` (to read the files of the pull request) and
`pull-requests: write` (to write one comment). It asks for nothing else. MergeStory sends the token only to
`api.github.com`, or to the host in `GITHUB_API_URL`, which GitHub sets for you (also on GitHub Enterprise
Server).

**One video at a time.** The `concurrency` group holds the pull request number and the label name. If you add
the label again while a video is being made, the new run replaces the old one. The label name is part of the
group on purpose: a run for an unrelated label, such as `bug`, must not cancel a video that is being made.

**The steps.**

| Step | What it does |
|---|---|
| `actions/setup-node` | Installs Node.js 22. |
| Install FFmpeg | Installs FFmpeg with `apt`. |
| Cache the voice model and speech clips | Restores the cache, and saves it after the first run. See the next section. |
| Install the free local voice | Runs `mergestory setup kokoro`. Optional: without it, the video step installs the voice itself. |
| Make the video and comment on the pull request | Runs `mergestory generate "$PR_URL" --comment --json`. The result goes to `mergestory-result.json`. |
| Add the link to the job summary | Always runs. It writes the link, or the error message, to the summary of the run. |

**Pinned versions.** The workflow runs `mergestory@1.2.0`, and the actions are pinned to a full commit. A
moved tag cannot change which MergeStory or which action code runs. The pins do not cover the packages that
MergeStory itself depends on: npm picks their versions when the workflow installs it. Update the pins when
you want a new version.

**Values go through `env:`.** The pull request address and every setting reach the script through
environment variables, never through `${{ }}` inside the script text. The browser is the Google Chrome that
GitHub's Ubuntu runners already have (`/usr/bin/google-chrome`).

## The comment

The comment has the title, a short summary, a link ("Watch the 2-minute MergeStory"), the chapters and what
to review. The next run for the same pull request updates it. MergeStory finds its own comment by a marker,
and only updates a comment that the same account wrote. Text from the pull request is cleaned before it is
written: no mentions, no HTML and no live links.

A private link works for 7 days at most, and the comment says when it expires. A private link has no
preview image, because GitHub cannot load one.

If GitHub refuses the comment, the video is already uploaded and the link is in the job summary. The step
then ends with exit code 5. See [cli.md](cli.md#exit-codes).

## Caching the voice

The free voice, Kokoro, is a large download: about 400 MB of packages, and a speech model of about 90 MB on
Linux that comes from `huggingface.co`. The cache step keeps the packages (`~/.mergestory/plugins`), the model
(`~/.mergestory/models`) and the speech clips (`~/.mergestory/cache`), so that a run does not download them
again.

- **The key never changes**, so the cache is saved once. GitHub cannot change a cache after it is saved. To
  start with a fresh cache, change `v1` in the key. Clips from later runs are not added to it.
- **A cache made in a pull request run can only be used by that pull request.** It cannot be used by the base
  branch or by other pull requests. So the first video of each pull request downloads the voice again. To
  share the cache, run the workflow by hand once on the default branch (press Run workflow, choose the
  default branch and type the number of a small pull request). That run makes a real video, and its cache can
  be used by every pull request.
- GitHub removes a cache that nobody used for 7 days. A repository may keep 10 GB of caches by default.

## What it costs

- **Actions minutes.** The video is rendered on the runner. Standard GitHub-hosted runners are free for public
  repositories. For a private repository, each run uses the minutes of your plan. See GitHub's billing page
  for the current price. A run takes a few minutes: it installs FFmpeg, restores the voice, narrates and
  renders. The first run is slower, because it installs the voice. The job stops after 20 minutes
  (`timeout-minutes`).
- **Storage.** A 2-minute video is about 10 MB. [hosting.md](hosting.md#what-it-costs) has the numbers for
  Cloudflare R2: the first 10 GB are free, and watching a video costs nothing extra.
- **Paid services.** None by default. With a model it is usually under one cent per video, and the budget
  of 25 cents per run (`MERGESTORY_BUDGET_USD`) stops a run before any call that would go over it.

## Optional: let a model write the storyboard

Without a model, MergeStory builds the storyboard offline, for free, from the diff and the pull request text.
To let a model write it, set the variable `MERGESTORY_LLM_PROVIDER` to `anthropic` and add the secret
`ANTHROPIC_API_KEY`. For OpenAI, set the variable to `openai`, and add `OPENAI_API_KEY` to the `env:` of the
step. The model gets the diff and the code around it. To send only names and paths, set `privacy.llmContext`
to `minimal` in a config file (see [configuration.md](configuration.md#privacy-options)).

A coding agent that wrote the pull request can do better, for free: it knows why it made each decision. It
can make the video on its own machine with the MergeStory skill and upload it later with
`mergestory publish`. See [storyboard.md](storyboard.md#how-an-agent-writes-one).

## Links expire

A private link works for 7 days at most. To get a new link, take the label off and add it again, or run the
workflow by hand. Both make a new video.

For permanent links that need your team's sign-in, add `MERGESTORY_VISIBILITY: protected` and
`MERGESTORY_S3_PUBLIC_BASE_URL` (your domain) to the `env:` of the step. See
[Cloudflare R2 with your team's sign-in](hosting.md#cloudflare-r2-with-your-teams-sign-in-protected-links).
To use YouTube instead of storage, see [Use it in CI](youtube.md#use-it-in-ci).

Anyone who can read the comment or the job summary can open a private link until it expires. In a public
repository that is everybody.

## When something goes wrong

| What you see | Why | What to do |
|---|---|---|
| No run starts | The label is not named `mergestory`, or the workflow file is not on the default branch. | Check both. |
| The run is grey, or skipped | You added another label, or the pull request is from a fork. This is normal. | Nothing. |
| The run was cancelled | You added the label again, or started a second run for the same pull request. | Let the newer run finish. |
| `No storage bucket is configured` | The variable `MERGESTORY_S3_BUCKET` is missing. | Add it. |
| `Only one of the two storage credential variables is set` | One of the two secrets is missing. | Add both. |
| The upload is refused | A wrong key, region or address, or a key without write access. | See [Problems and fixes](hosting.md#problems-and-fixes). |
| There is a video but no comment, and the step ends with exit code 5 | The token cannot write pull requests. | Check that the file has `pull-requests: write`. A token is always read-only for a pull request from a fork. |
| Exit code 6 | FFmpeg or the browser is missing. | The Ubuntu runners of GitHub have a browser. On a self-hosted runner, install Chrome and FFmpeg, and set `MERGESTORY_BROWSER_PATH`. |
| `BUDGET_EXCEEDED` | A model call would cost more than the budget. | Raise `MERGESTORY_BUDGET_USD`, or pick a cheaper model. |
| The run hits the 20-minute limit | A big change on a small runner. | Raise `timeout-minutes`, or set `MERGESTORY_QUALITY` to `draft`. |

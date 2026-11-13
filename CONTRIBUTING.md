# Contributing to MergeStory

Thanks for helping. MergeStory turns pull requests into short, accurate explainer videos. The bar
for every change is the same as for the videos: correct first, then cheap, private and polished.

## Set up

Requirements: Node.js 22.12+, git, FFmpeg, and a Chromium-based browser (Google Chrome, or
`npx playwright install chromium-headless-shell`).

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs the type checks, the linter and the tests. The render integration test is
skipped when no browser or FFmpeg is found.

Run the CLI from source (Node 22.18+ runs TypeScript directly):

```bash
node packages/engine/src/cli/main.ts doctor
```

Try it on the demo repository, a small weather API client. The script builds a git repository with a
`main` branch and a `feature/retry` branch. The change adds retries with exponential backoff:

```bash
./examples/demo/create-demo-repo.sh /tmp/mergestory-demo
```

```bash
node packages/engine/src/cli/main.ts generate /tmp/mergestory-demo --base main --head feature/retry
```

## Where to start

Fixing a wrong or unclear page in `docs/` is a good first change, and so is an open issue that you can
reproduce. For a larger change, open an issue first so we can agree on the idea.

## Where things live

See [docs/architecture.md](docs/architecture.md). In short: the engine is `packages/engine`, the
Agent Skill is `plugins/mergestory/skills/mergestory` (the Claude Code plugin is the folder
`plugins/mergestory`), and shared types and contracts are in `packages/engine/src/core`. Change
contracts in `src/core` with care: every module depends on them.
The user documentation is in `docs/`, and the main page is the [README](README.md).

## Working on visuals

Scene templates live in `packages/engine/src/runtime/templates`. Render frames of a plan to PNG
files to check your work:

```bash
node packages/engine/scripts/preview-frames.mjs packages/engine/assets/preview/templates-sample.json /tmp/frames
```

Rules for templates:

- Every visual value must be a pure function of time. No `Date`, no `Math.random`, no CSS
  transitions or animations.
- Write to the DOM only through the `StyleWriter` (`ctx.sw`). That is how the renderer knows a
  frame did not change and can reuse it.
- Elements appear on their narration beat and then rest. Avoid idle motion.
- Use the design tokens and primitives in `src/runtime/styles.ts`. Check both themes.

## Documentation

The docs are part of the product, and a wrong page is a bug. When you change behaviour, change the page
that describes it:

| If you change | Update |
|---|---|
| a command or a flag | [docs/cli.md](docs/cli.md) and the skill in `plugins/mergestory/skills/mergestory` |
| a setting or an environment variable | [docs/configuration.md](docs/configuration.md) |
| the storyboard format or its checks | [docs/storyboard.md](docs/storyboard.md) |
| the HTTP API or the library exports | [docs/api.md](docs/api.md) |
| the example workflow | [docs/github-actions.md](docs/github-actions.md) |
| anything a user will notice | [CHANGELOG.md](CHANGELOG.md) |

`packages/engine/test/docs.test.ts` runs with `npm test`. It checks that every link in the Markdown
files points at a file and a heading that exist, that `docs/cli.md` names every command and flag, and
that `docs/configuration.md` names every setting and environment variable.

Write in plain English: short sentences, common words, and a short explanation the first time you use a
technical term. Use made-up names in examples (`acme/weather-app`, `/path/to/run`).

## Pull requests

- Keep pull requests focused. One topic per pull request.
- Add or update tests for behaviour changes. Tests must not need network access or API keys.
- Run `npm run check` before you push.
- Write in plain English in code comments and docs.
- Add a line to the changelog for a change that users will notice.
- Never commit secrets, real customer code or generated videos.
- Your contribution is licensed under the Apache License 2.0, like the rest of the project (section 5 of
  the license).

## How changes land

- `main` is protected. Every change goes through a pull request.
- The CI `check` job and CodeQL must pass, and the branch must be up to date with `main`.
- Pull requests are squash-merged. The pull request title and description become the commit
  message, so write them as a good commit message: what changed and why.
- Only maintainers can create `v*` release tags. Pushing a tag starts the npm release (see below).

## Releasing

Maintainers release from CI, never from a laptop:

1. Set the new version in `packages/engine/package.json` and `packages/engine/src/version.ts`, run
   `npm install` so the lockfile follows, and add the section to the changelog. Merge that.
2. Push a tag with the same version, for example `v1.2.3`.
3. The `Release` workflow checks the tag against the version, runs every check, builds the package,
   pins the version of every dependency in it (`npm-shrinkwrap.json`), renders a short video with
   exactly those files, and stages the package on npm. It signs in to npm with a short-lived
   identity from GitHub, so the repository holds no npm token.
4. A maintainer approves the staged version on npmjs.com with two-step sign-in. Only then can users
   install it.
5. After that, update the version that the skill installs
   (`plugins/mergestory/skills/mergestory/SKILL.md`), the plugin version
   (`plugins/mergestory/.claude-plugin/plugin.json`) and the example workflow, in one pull request.

## Reporting security problems

Do not open a public issue. Use GitHub's private vulnerability reporting: open the Security tab of the
repository and choose "Report a vulnerability". See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone who takes part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind and
constructive. Assume good intent, focus on the work, and help newcomers.

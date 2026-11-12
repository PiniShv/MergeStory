# HTTP API and library

MergeStory can run as a small HTTP server for other tools, and it can be used as a library from Node.js.
Both do the same work as the command line. This page covers the [HTTP API](#http-api) and the
[library](#library).

## HTTP API

The API starts a video job, tells you how it is going, and lists recent jobs. It uses Node's own HTTP module
and has no extra dependencies. Jobs run one at a time on the machine that runs the server.

### Start the server

```bash
export MERGESTORY_API_TOKEN=$(openssl rand -hex 24)
```

```bash
mergestory serve --allow-root ~/projects
```

| Flag | What it does | Default |
|---|---|---|
| `--host <host>` | The address to listen on. | `127.0.0.1` |
| `--port <port>` | The port to listen on. | 7171 |
| `--token-env <name>` | The name of the environment variable that holds the token. It takes a name, never the token. | `MERGESTORY_API_TOKEN` |
| `--allow-root <dir>` | A folder that local repositories may live in. You can repeat the flag. | none |
| `--allow-host <name>` | Another name for the `Host` check (see [Safety rules](#safety-rules)). You can repeat the flag. | none |

With `--json`, `serve` prints `{"ok": true, "url": ..., "host": ..., "port": ..., "auth": ..., "allowRoots": [...]}`
once, and then keeps running. Press Ctrl+C to stop it. A running job is cancelled, and jobs that are still
waiting end as failed.

### Safety rules

The API is safe by default:

- **It listens on the loopback address only** (`127.0.0.1`). It refuses to listen on any other address
  without a token.
- **The token** is sent as `Authorization: Bearer <token>`. It must be at least 16 characters long. It is
  compared in a way that does not reveal how much of it was right. With a token set, every request needs
  it, including `GET /v1/health`.
- **No token, no network.** Without a token, only this machine can reach the server, and MergeStory warns you
  at start.
- **A Host check** protects a loopback server against web pages that point their own name at `127.0.0.1`.
  A request whose `Host` header is not `localhost`, `127.0.0.1`, `::1` or the bound address gets `403`.
  A reverse proxy on the same machine must pass one of these names as the `Host` header, or its name must
  be allowed: with `mergestory serve --allow-host <name>` (repeatable), or with the option `allowedHosts` of
  `startServer`.
- **No CORS headers.** A web page on another site cannot call the API from a browser.
- **Plain HTTP.** On a network address, put a TLS proxy in front of the API. MergeStory warns you.
- **Local repositories need `--allow-root`.** See [Local repositories](#local-repositories).
- **The API takes no secrets.** The server uses its own environment: its model keys, its storage keys and its
  `GITHUB_TOKEN`. A caller cannot send a key, a file path to a screenshot or an address for a model server.
  Task, notes and test results that look like secrets are masked.

### Endpoints

Every response is JSON with `Cache-Control: no-store`. A trailing slash on the path is ignored.

| Method and path | What it does |
|---|---|
| `GET /v1/health` | Returns `{"ok": true, "version": "1.2.0"}`. |
| `POST /v1/jobs` | Starts a job. Returns `202`. |
| `GET /v1/jobs/:id` | Returns one job. |
| `GET /v1/jobs?limit=<n>` | Returns recent jobs, newest first, as `{"jobs": [...]}`. `limit` is 1 to 200 and the default is 20. |

#### `POST /v1/jobs`

Send `Content-Type: application/json` and a body of at most 256 KB. Every object in the body is strict: a key
that is not listed here is an error, so a typo is never ignored.

| Field | Type | What it is |
|---|---|---|
| `source` | string, required | A pull request URL, `owner/repo#123`, or the path of a local repository. At most 2048 characters. |
| `base`, `head` | string | The refs of a local repository. Not allowed with a pull request. At most 256 characters, no spaces, and they must not start with `-`. |
| `context.task`, `context.notes` | string | The task and the notes, at most 64 KB each. They become the evidence `TASK` and `NOTES`. |
| `context.tests` | array | Up to 100 results: `{"command", "passed", "summary", "source"?}`. `source` is `agent`, `ci` or `user`. Only the first 10 are used. |
| `storyboard` | object | A storyboard that you wrote. It goes through the same checks as every storyboard. See [storyboard.md](storyboard.md). |
| `options` | object | Settings, listed below. |

`options` may hold these keys, and no others:

| Key | Values |
|---|---|
| `style` | `technical`, `product`, `hybrid` |
| `quality` | `draft`, `standard`, `high` |
| `maxDurationSec`, `targetDurationSec` | Seconds. The same ranges as in [configuration.md](configuration.md). `targetDurationSec` may be `null`. |
| `language`, `theme` | A language tag, and `dark` or `light`. |
| `budgetUsd` | US dollars, from 0 to 100. |
| `llm.provider`, `llm.model` | The provider (`none`, `anthropic`, `openai`, `openai-compatible`) and a model name. |
| `tts.provider`, `tts.voice` | The speech provider (`auto`, `kokoro`, `say`, `openai`, `elevenlabs`, `none`) and a voice name. |
| `publish.provider` | `local`, `s3` or `none`. |
| `publish.visibility` | `private` or `public`. |
| `github.comment`, `github.updateDescription` | `true` or `false`. |

Everything else comes from the server's own settings: its environment variables and its config file (named
by `MERGESTORY_CONFIG`, else `$MERGESTORY_HOME/config.json`). So a server
that you start with `MERGESTORY_VISIBILITY=protected` makes protected links for every job that does not ask
for something else. A request cannot ask for `youtube` or `drive`, for protected links or for a model server address. A
server whose default provider is `youtube` or `drive` answers 403 to a job that names no other provider:
those sign-ins belong to the operator. Each accepted job keeps the provider it was accepted with.
Screenshots and dry runs are not part of the API either.

A request, with a pull request as the source:

```bash
curl -s http://127.0.0.1:7171/v1/jobs \
  -H "Authorization: Bearer $MERGESTORY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/acme/weather-app/pull/42",
    "context": { "task": "Add retries to the weather client." },
    "options": { "quality": "draft", "tts": { "provider": "none" } }
  }'
```

The answer is `202 Accepted`, with a `Location` header (`/v1/jobs/<id>`):

```json
{ "id": "20261104-101500-a1b2", "status": "queued" }
```

#### `GET /v1/jobs/:id`

Ask every few seconds until `status` is `succeeded` or `failed`. A job moves from `queued` to `running`, and
then ends as `succeeded` or `failed`. If the server stops before a job finishes, that job reads as `failed`
with the message "The worker process ended before the job finished." Send it again.

```json
{
  "id": "20261104-101500-a1b2",
  "status": "running",
  "createdAt": "2026-11-04T10:15:00.000Z",
  "updatedAt": "2026-11-04T10:15:20.000Z",
  "startedAt": "2026-11-04T10:15:01.000Z",
  "finishedAt": null,
  "options": { "source": { "kind": "github", "url": "https://github.com/acme/weather-app/pull/42" } },
  "progress": { "stage": "narrate", "message": "Narrating with kokoro", "progress": null },
  "result": null,
  "error": null
}
```

- `progress.stage` is `queued`, `source`, `analyze`, `storyboard`, `validate`, `narrate`, `visuals`, `render`,
  `publish` or `notify`. `progress.progress` is a number from 0 to 1 inside the stage, or `null`.
- `options` shows what was queued, with secrets masked. A storyboard shows as `"[provided]"`.
- `result` is the [result object](cli.md#the-result-of-generate-and-publish) once the job has succeeded.
  Its `files` are paths on the server. **The API does not serve files.** A client gets a link only when the
  server publishes (`publish.provider` is `s3`), so set that up on the server. See [hosting.md](hosting.md).
- `error` is `{"code", "message", "hint"}` for a failed job. The codes are the ones in [cli.md](cli.md#exit-codes).
- The job id is also the run id. The run folder is `$MERGESTORY_HOME/runs/<id>`, and the job file is
  `$MERGESTORY_HOME/jobs/<id>/job.json`.

A job in the list has `id`, `status`, `createdAt`, `updatedAt`, `progress`, `title` (when it has a result) and
`error`.

### Local repositories

A pull request is always accepted. A local repository is accepted only inside a folder that you allowed with
`--allow-root`:

- Without any `--allow-root`, a local path gets `403`: "Local repositories are not enabled on this server."
- The path, the top of its work tree, and its git folders must all lie inside one allowed root. Symbolic
  links are followed first. A plain folder inside a root cannot be used to read the repository that
  contains it, and a repository that has its `.git` somewhere else is refused.
- A path that does not exist and a path that is outside every root get the same answer, so the API cannot
  be used to find out what is on the disk.
- Every root must be an existing folder when the server starts. Otherwise `serve` stops with an error.
- A path is read from the working folder of the server. The path that the job uses is the real path of the
  top of the work tree.

### Limits

| What | Limit |
|---|---|
| Request body | 256 KB. Larger gives `413`. |
| Content type | `application/json`. Anything else gives `415`. |
| Text | No string, key or value, with more than 1,000 letters, digits, `_`, `.` or `-` in a row. Scanning such a text for secrets would take too long. |
| Jobs | One runs at a time. Up to 20 more wait. Then `POST` gives `503` with `Retry-After: 60`. |
| Time | 15 seconds for the headers and 30 seconds for the whole request. An idle connection closes after 5 seconds. At most 128 connections. |

### Errors

An error has the HTTP status, and a body like this:

```json
{
  "ok": false,
  "error": {
    "code": "USAGE",
    "message": "The request body is not valid.",
    "issues": [{ "path": "options.quality", "message": "Invalid option: expected one of \"draft\"|\"standard\"|\"high\"", "code": "invalid_value" }]
  }
}
```

`hint` and `issues` appear when they help. `issues` lists up to 20 problems of a request body, each with the
`path` of the field.

| Status | `code` | When |
|---|---|---|
| 400 | `USAGE` | The body is not valid JSON, has a key or value that is not allowed, has a very long unbroken string, is nested more than 64 levels deep, or uses `base` or `head` with a pull request. |
| 400 | `SOURCE_INVALID` | The source cannot be read, or the path is not a git work tree that the server can read. |
| 401 | `UNAUTHORIZED` | The token is missing or wrong. The answer has `WWW-Authenticate: Bearer`. |
| 403 | `FORBIDDEN` | The `Host` header is not allowed, local repositories are off, or the path is not inside an allowed root. |
| 404 | `NOT_FOUND`, `JOB_NOT_FOUND` | No such route, or no such job. |
| 405 | `METHOD_NOT_ALLOWED` | The path does not allow this method. The `Allow` header lists the right ones. |
| 413 | `PAYLOAD_TOO_LARGE` | The body is larger than 256 KB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | The content type is not `application/json`. |
| 503 | `QUEUE_FULL` | Too many jobs are waiting. Try again after the `Retry-After` time. |
| 500 | `INTERNAL` | An unexpected error on the server. |

A job that fails later is not an HTTP error. It is a job with `status` set to `failed`.

## Library

Install the package and use it from an ES module. The package has no CommonJS build.

```bash
npm install mergestory
```

It needs Node.js 22.12 or newer. The library reads settings from the same places as the command line, but
without flags: the `config` object that you pass wins over environment variables, and they win over the
config file. See [configuration.md](configuration.md).

### `generate`

Makes a video, or with `dryRun: true` a plan. It is the same as `mergestory generate`.

```ts
import { generate } from 'mergestory';

const result = await generate({
  source: 'https://github.com/acme/weather-app/pull/42',
  context: { task: 'Add retries to the weather client.' },
  config: { quality: 'draft', tts: { provider: 'none' } },
});

if ('dryRun' in result) {
  console.log(`Planned ${result.estimatedDurationSec} seconds`);
} else {
  console.log(result.files.video, result.publish?.watchUrl);
}
```

| Option | What it is |
|---|---|
| `source` | A pull request URL, `owner/repo#123` or a path (or a `SourceInput` object). |
| `base`, `head` | The refs of a local repository. |
| `context` | `{task, notes, tests, screenshots}`. A test is `{command, passed, summary, source}`, with `source` set to `agent`, `ci` or `user`. A screenshot is `{path, caption, moment}`. |
| `storyboard` | A storyboard that you wrote. It is checked like every storyboard. |
| `config` | Settings that win over everything else. The same shape as the config file. |
| `configPath` | The config file to use. |
| `dryRun` | Make a plan and nothing else. |
| `runId` | Your own run id. |
| `signal` | An `AbortSignal` that cancels the run. |
| `logger` | A logger. Use `createLogger()`, or `silentLogger` for none. |

The result is a `GenerateResult`, or a `PlanResult` for a dry run. Their fields are in
[cli.md](cli.md#json-output). Pass a second argument to see progress:
`generate(options, { onProgress: (event) => console.log(event.stage, event.message) })`.

A failure throws a `MergeStoryError`. It has a `code`, a `hint`, `details` and an `exitCode`. Check with
`isMergeStoryError(error)`.

### `prepareAuthoring`

Analyses a change and writes the files an agent needs to write a storyboard. It is the same as
`mergestory analyze`. It is free, and no model is called.

```ts
import { prepareAuthoring } from 'mergestory';

const authoring = await prepareAuthoring({
  source: '.',
  base: 'main',
  head: 'feature/retry',
  outDir: '/tmp/mergestory-work',
  context: { task: 'Add retries to the weather client.' },
});

console.log(authoring.files.evidence); // read this, then write storyboard.json
```

It takes the options of `generate`, except `storyboard` and `dryRun`, and adds `outDir` (where to write the
files). It returns `{runId, runDir, files: {analysis, evidence, guide, schema}, summary}`.

### `checkStoryboard`

Checks a storyboard against a change, without rendering. It is the same as `mergestory validate`. Pass the
same source, refs and context as to `prepareAuthoring`.

```ts
import { readFile } from 'node:fs/promises';
import { checkStoryboard } from 'mergestory';

const check = await checkStoryboard({
  source: '.',
  base: 'main',
  head: 'feature/retry',
  context: { task: 'Add retries to the weather client.' },
  storyboard: JSON.parse(await readFile('storyboard.json', 'utf8')),
});

if (check.errors.length > 0) console.error(check.errors);
```

The result has `errors`, `warnings`, `fixes`, `groundedClaims` and `storyboard`. `storyboard` is the
storyboard after the automatic fixes, or `null` while there is an error. See
[storyboard.md](storyboard.md#what-the-checks-do).

### Publishing a finished run

`publishRun` uploads a run that was rendered earlier. It is the same as `mergestory publish`, so you can
watch the local video first and share it only after you approve. Nothing is rendered again.

```ts
import { publishRun } from 'mergestory';

const result = await publishRun({
  run: '/home/ci/.mergestory/runs/20261104-101500-a1b2', // the runDir of a generate result, or the run id
  config: { publish: { provider: 's3', visibility: 'private' }, github: { comment: true } },
});

console.log(result.publish?.watchUrl);
```

| Option | What it is |
|---|---|
| `run` | The run folder (`runDir` in a `generate` result), or the run id. |
| `config` | Settings that win over everything else, typically `publish` and `github`. |
| `configPath` | The config file to use. |
| `signal`, `logger` | An `AbortSignal` that cancels the upload, and a logger. |

It returns a `GenerateResult`: the result of the earlier run with the new `publish` and `notify` fields,
and the cost and transfers of both runs added together. A failed upload throws a `MergeStoryError` and
keeps the run usable. A run folder that is not a MergeStory run (for example a damaged `publish-input.json`)
fails with the code `SOURCE_INVALID`.

### The HTTP API from code

```ts
import { startServer } from 'mergestory';

const server = await startServer({
  port: 7171,
  token: process.env.MERGESTORY_API_TOKEN,
  allowRoots: ['/srv/repos'],
  shutdownOnSignals: true,
});

console.log(`Listening on ${server.url}`);
await server.closed;
```

| Option | What it is |
|---|---|
| `host`, `port` | The address and the port. The defaults are `127.0.0.1` and 7171. Use port 0 for any free port. |
| `token` | The bearer token, at least 16 characters. It is required for any host that is not a loopback address. |
| `allowedHosts` | More names for the `Host` check of a loopback server, for a reverse proxy on the same machine. |
| `allowRoots` | The folders that local repositories may live in. |
| `configPath`, `home` | The config file that jobs use, and the MergeStory home that holds the job files. |
| `logger`, `signal` | A logger, and an `AbortSignal` that closes the server. |
| `shutdownOnSignals` | Also close on SIGINT and SIGTERM. |
| `maxQueued` | How many jobs may wait. The default is 20. |

It returns a handle with `host`, `port`, `url`, `closed` (a promise) and `close()`.

### Building blocks

The package also exports the parts of the pipeline:

| Export | What it is |
|---|---|
| `analyze`, `buildEvidencePack` | The analysis of a change, and the evidence pack of it. |
| `validateStoryboard`, `heuristicStoryboard` | The grounding checker, and the offline storyboard generator. |
| `StoryboardSchema`, `storyboardJsonSchema()`, `STORYBOARD_LIMITS` | The storyboard contract: the Zod schema, the JSON Schema and the limits. |
| `resolveConfig`, `readConfigFile`, `configFromEnv`, `ConfigSchema`, `QUALITY_PRESETS`, `SECRET_ENV_VARS` | The configuration. |
| `createSourceProvider`, `detectSourceInput` | Reading a pull request or a local repository. |
| `MergeStoryError`, `EXIT_CODES`, `isMergeStoryError` | Errors, and the exit codes of the CLI. |
| `createLogger`, `silentLogger`, `createRunContext` | Logging, and the context of one run. |
| `ENGINE_VERSION` | The version of the engine. |

The types of the data model, the provider interfaces and the render plan are exported too.

The stages read the `sensitive` flag of each changed file to decide what may be shown or sent. The sources
set it from the built-in sensitive paths and `privacy.excludePaths`. If you build a change set by hand, set
the flag yourself.

# Configuration

MergeStory works with no configuration. The defaults are free and private: no paid service is called, speech
and rendering run on your machine, and nothing is uploaded. Every setting on this page is optional. The flags
that map to a setting are listed in [cli.md](cli.md).

## Where settings come from

A setting can come from four places. The first one that has a value wins:

1. **A flag**, such as `--budget 1`.
2. **An environment variable**, such as `MERGESTORY_BUDGET_USD=1`.
3. **The config file.**
4. **The default.**

A flag you do not give leaves the environment and the config file in charge.

### The config file

The config file is a JSON file. MergeStory looks for it in this order and uses the first match:

1. the file you give with `--config <file>`;
2. the file named by the environment variable `MERGESTORY_CONFIG`;
3. `$MERGESTORY_HOME/config.json`, which is `~/.mergestory/config.json` unless you set `MERGESTORY_HOME`. This
   one is used only when it exists.

A file that you name with `--config` or `MERGESTORY_CONFIG` must exist, or the run stops with an error. A
relative path is read from the current folder.

**MergeStory never looks for a config file in the current folder.** That folder is often the repository
being explained. A file there could point MergeStory at other programs, servers or API hosts. The `home`
setting does not move the config file either: the file is always found through `MERGESTORY_HOME`.

The rules for the file:

- It holds one JSON object. A `"$schema"` key is ignored, so your editor can use one.
- Sections are nested objects. `publish.s3.bucket` is `{"publish": {"s3": {"bucket": "my-videos"}}}`.
- **Every key is checked.** A key that does not exist is an error, and the message suggests the key you
  probably meant (`Unrecognized key "visibilty" (did you mean "visibility"?)`). A wrong value is an error
  too. A misspelt privacy setting never leaves the default in place without a word.
- **No secrets.** A key whose name looks like a secret is refused. That means a name with `api_key` (also
  spelt `apiKey` or `api-key`), `token`, `secret`, `password` or `credential` in it. The only exceptions are
  `llm.maxInputTokens` and `llm.maxOutputTokens`. Secrets come from environment variables only. See
  [Secrets](#secrets).
- `mergestory doctor` shows a problem in the file as a failed `config` check.

An example:

```json
{
  "budgetUsd": 0.5,
  "publish": {
    "provider": "s3",
    "s3": { "bucket": "my-videos", "endpoint": "https://<account-id>.r2.cloudflarestorage.com" }
  },
  "privacy": { "excludePaths": ["internal/", "*.generated.ts"] }
}
```

### Values in environment variables

A variable with an empty value counts as not set. For a true or false setting, `1`, `true`, `yes` and `on`
(in any case) mean true, and `0`, `false`, `no` and `off` mean false. Any other word is an error that names
the variable.

## Settings

Each table lists the key, its default, what it does, and the flag and the environment variable that set it,
in that order. `none` means that the setting has no flag, or no variable.

### General

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `style` | `hybrid` | How technical the narration is: `technical` (modules, functions, data flow), `product` (what behaves differently and why it matters, with few code scenes) or `hybrid`. | `--style`, `MERGESTORY_STYLE` |
| `language` | `en` | The narration language, as a tag of 2 to 16 characters such as `en`. The free Kokoro voice and the offline storyboard are English only. The check that removes claims such as "all tests pass" reads English only. | `--language`, `MERGESTORY_LANGUAGE` |
| `theme` | `dark` | The color theme of the video: `dark` or `light`. | `--theme`, `MERGESTORY_THEME` |
| `quality` | `standard` | `draft`, `standard` or `high`. See [Quality presets](#quality-presets). | `--quality`, `MERGESTORY_QUALITY` |
| `maxDurationSec` | `150` | The longest video, in whole seconds, from 20 to 600. Before narration, scenes and lines are dropped, least important first, until the estimated length fits. The mission and review scenes always stay. The real voice may run a little over, and a warning says so. | `--max-duration`, `MERGESTORY_MAX_DURATION` |
| `targetDurationSec` | `null` | A fixed target length, in whole seconds, from 20 to 600. With `null` the engine picks a length that fits the size of the change. | `--duration`, none |
| `captions` | `true` | Draw captions into the video. The `captions.vtt` file is written either way. | `--no-captions`, none |
| `budgetUsd` | `0.25` | The most one run may spend, in US dollars, from 0 to 100. See [Budget](#budget). | `--budget`, `MERGESTORY_BUDGET_USD` |
| `home` | `null` | The folder for runs, cache, jobs, models, plugins and sign-in data. `null` means `~/.mergestory`. | none, `MERGESTORY_HOME` |
| `outDir` | `null` | The folder for the run files. `null` means `$MERGESTORY_HOME/runs/<run id>`. A relative path is read from the current folder. It must be outside the repository being explained. | `--out`, none |

### Model for the storyboard (`llm`)

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `llm.provider` | `none` | Who writes the storyboard: `none` (the free offline storyboard, or one you pass with `--storyboard`), `anthropic`, `openai` or `openai-compatible`. | `--llm`, `MERGESTORY_LLM_PROVIDER` |
| `llm.model` | `null` | The model name. `null` picks the cheap default of the provider: `claude-haiku-5-5` for `anthropic` and `gpt-6-luna` for `openai`. `openai-compatible` has no default, so you must give a name. | `--model`, `MERGESTORY_LLM_MODEL` |
| `llm.baseUrl` | `null` | The address of an OpenAI-compatible server, for example `http://localhost:11434/v1` for Ollama. Needed for `openai-compatible`. The `openai` provider sends its key only to `https://api.openai.com/v1` and refuses any other address; for another server, use `openai-compatible` with `MERGESTORY_LLM_API_KEY`. Plain `http` is accepted only for this machine and private networks, never with a user name or password in the URL. | `--llm-base-url`, `MERGESTORY_LLM_BASE_URL` |
| `llm.effort` | `medium` | `low`, `medium` or `high`. How much effort the model puts in, for models that have the setting. Lower is faster and cheaper. | none, `MERGESTORY_LLM_EFFORT` |
| `llm.maxInputTokens` | `24000` | The size limit of the evidence pack sent to the model, from 2000 to 200000 tokens. Smaller is cheaper. | none, none |
| `llm.maxOutputTokens` | `12000` | The size limit of the model's answer, from 1000 to 64000 tokens. | none, none |
| `llm.repairAttempts` | `1` | How many times the model gets the errors of the checker back to fix its storyboard, from 0 to 3. If the storyboard still has errors, the offline storyboard is used instead. | none, none |
| `llm.timeoutMs` | `240000` | How long to wait for an answer, from 5000 to 900000 milliseconds. A request that times out is not sent again, because the provider may still bill it. The cost report cannot count such a request. | none, none |

### Speech (`tts`)

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `tts.provider` | `auto` | `auto`, `kokoro`, `say`, `openai`, `elevenlabs` or `none`. `auto` only ever picks a free local voice. For English it is always Kokoro: the first run installs it once (about 400 MB, then the voice model) and stops with `TTS_FAILED` if the install fails. For other languages, and on Windows, it is Kokoro if installed, then the macOS `say` voice, then captions only. An explicit `kokoro` is also installed when missing; the other choices never install anything. | `--tts`, `MERGESTORY_TTS_PROVIDER` |
| `tts.voice` | `null` | The voice name. `null` uses the voice of the provider: `af_heart` for Kokoro, a built-in English voice for macOS `say` (`Samantha` when it is installed), `marin` for OpenAI, and a ready-made voice for ElevenLabs. To use another ElevenLabs voice, give its voice ID. | `--voice`, `MERGESTORY_TTS_VOICE` |
| `tts.model` | `null` | The speech model. `null` uses `gpt-4o-mini-tts` for OpenAI and `eleven_flash_v2_5` for ElevenLabs. | none, `MERGESTORY_TTS_MODEL` |
| `tts.speed` | `1` | The speaking speed, from 0.5 to 2. | none, none |

### Publishing (`publish`)

See [hosting.md](hosting.md) for storage set-ups and [youtube.md](youtube.md) for YouTube.

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `publish.provider` | `local` | Where the video goes: `local`, `s3`, `youtube` or `none`. | `--publish`, `MERGESTORY_PUBLISH_PROVIDER` |
| `publish.visibility` | `private` | Who can open an S3 link: `private` (signed, 7 days at most), `protected` (permanent, behind your sign-in proxy) or `public` (permanent, open to anyone). | `--visibility`, `MERGESTORY_VISIBILITY` |
| `publish.linkExpirySec` | `604800` | How long a private S3 link works, from 60 seconds to 604800 (7 days). With temporary credentials it can be shorter, and MergeStory warns you. | none, `MERGESTORY_LINK_EXPIRY_SEC` |
| `publish.allowPublicForPrivateRepos` | `false` | Allows a link that anyone can open (a `public` S3 link, or a YouTube video that is not `private`) for a repository that is private, or whose privacy MergeStory cannot tell. Leave it off unless anyone with the link may watch. | none, none |
| `publish.localDir` | `null` | The folder for the `local` publisher. `null` means `publish/` in the run folder. MergeStory only overwrites files that an earlier run wrote. A folder that holds other files is refused. | none, none |

**S3-compatible storage** (`publish.s3`):

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `publish.s3.bucket` | `null` | The bucket name. Needed for `s3`. | none, `MERGESTORY_S3_BUCKET` |
| `publish.s3.region` | `auto` | The region. `auto` is right for Cloudflare R2. Backblaze B2 takes it from the endpoint. For Amazon S3, name the region or set `AWS_REGION`. | none, `MERGESTORY_S3_REGION` |
| `publish.s3.endpoint` | `null` | The address of the storage service. Leave it empty for Amazon S3. | none, `MERGESTORY_S3_ENDPOINT` |
| `publish.s3.prefix` | `mergestory` | The folder in the bucket. Each run uses `<prefix>/v/<random token>/`, with no repository or user name in it. | none, `MERGESTORY_S3_PREFIX` |
| `publish.s3.publicBaseUrl` | `null` | The address that serves the bucket, for permanent links. Needed for `protected` and `public`. | none, `MERGESTORY_S3_PUBLIC_BASE_URL` |
| `publish.s3.forcePathStyle` | `false` | Use path-style addresses. Self-hosted servers and Google Cloud Storage need this. | none, `MERGESTORY_S3_FORCE_PATH_STYLE` |
| `publish.s3.verifyProtection` | `true` | For `protected` links: before any upload, check that the address asks for a sign-in. Turn it off only for an address this machine cannot reach. `mergestory doctor` warns while it is off. | none, `MERGESTORY_S3_VERIFY_PROTECTION` |

**YouTube** (`publish.youtube`):

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `publish.youtube.privacyStatus` | `unlisted` | `private`, `unlisted` or `public`. MergeStory always sends it, because YouTube makes a video public when it is left out. | none, `MERGESTORY_YOUTUBE_PRIVACY` |
| `publish.youtube.categoryId` | `"28"` | The YouTube category as a string of 1 to 3 digits. 28 is Science & Technology. | none, none |
| `publish.youtube.playlistId` | `null` | Adds each video to this playlist. It needs the broader YouTube permission. | none, `MERGESTORY_YOUTUBE_PLAYLIST_ID` |
| `publish.youtube.uploadCaptions` | `false` | Also upload `captions.vtt` as a caption track. It needs the broader YouTube permission. | none, none |
| `publish.youtube.setThumbnail` | `true` | Use the poster image as the thumbnail. YouTube allows this only on verified channels. | none, none |

### GitHub (`github`)

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `github.comment` | `false` | Post, or update, one comment with the video link on the pull request. | `--comment`, none |
| `github.updateDescription` | `false` | Add, or update, a section with the link in the pull request description. | `--update-description`, none |
| `github.apiUrl` | `https://api.github.com` | The REST API of your GitHub Enterprise Server. GitHub Actions sets the variable for you. | none, `GITHUB_API_URL` |
| `github.useGhCli` | `true` | Use the login of the `gh` command when no token variable is set. | none, none |

**The GitHub token.** MergeStory uses `GITHUB_TOKEN`, then `GH_TOKEN`, then the login of `gh auth token`
for that host. Without any of them it asks GitHub without logging in, which works for public repositories
at 60 requests an hour. A token from the environment is only sent to `api.github.com` and to the host in
`github.apiUrl`, so a pull request URL can never send it to another server. Reading needs access to the
repository's contents and pull requests. `--comment` and `--update-description` also need permission to
write pull requests.

### Privacy (`privacy`)

See [Privacy options](#privacy-options) for what these do.

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `privacy.maskEmails` | `true` | Mask e-mail addresses on screen, in narration, in captions, on the watch page and in what goes to a model. | none, none |
| `privacy.excludePaths` | `[]` | A list of path patterns whose content is never shown or sent anywhere. | none, none |
| `privacy.llmContext` | `full` | What a model receives: `full` (key hunks of code) or `minimal` (metadata, paths and symbol names only). | none, none |

### Rendering (`render`)

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `render.concurrency` | `null` | How many browser pages render at once, from 1 to 16. `null` uses half the CPUs, limited by memory and by 6. | none, none |
| `render.browserPath` | `null` | The path of a Chrome, Chromium or Edge to render with. | none, `MERGESTORY_BROWSER_PATH` |
| `render.ffmpegPath` | `null` | The path of `ffmpeg`. | none, `MERGESTORY_FFMPEG_PATH` |
| `render.ffprobePath` | `null` | The path of `ffprobe`. | none, `MERGESTORY_FFPROBE_PATH` |
| `render.reuseStaticFrames` | `true` | Skip capturing a frame that is identical to the one before it. This is why most videos render quickly. | none, none |
| `render.musicPath` | `null` | A background music file. It is mixed in at a low level and lowered while someone speaks. | `--music`, none |
| `render.normalizeLoudness` | `true` | Bring the narration to a standard loudness: -16 LUFS, with a true peak of at most -1.5 dBTP. This keeps the video as loud as other online video, without clipping. | none, none |

A path you set is never replaced silently: if it does not exist, MergeStory stops with an error and does
not look for another browser. Without a setting, MergeStory looks for a browser in Playwright's cache
(`PLAYWRIGHT_BROWSERS_PATH` moves it), then for Chrome, Chromium or Edge on the machine. It looks for
FFmpeg on the `PATH` and in the usual install folders.

### Cache and prices

| Key | Default | What it does | Flag, environment variable |
|---|---|---|---|
| `cache.enabled` | `true` | Use and fill the cache of speech clips, model answers and file contents. `mergestory cache clear` empties it. | `--no-cache`, none |
| `pricing` | `{}` | Prices that replace or add to the built-in price list. See [Pricing overrides](#pricing-overrides). | none, none |

## Secrets

Secrets come from environment variables only. MergeStory has no flag for a secret, so one never ends up in
your shell history, and the config file refuses secret-like keys.

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | `--llm anthropic` |
| `OPENAI_API_KEY` | `--llm openai` and `--tts openai` |
| `MERGESTORY_LLM_API_KEY` | `--llm openai-compatible`, when your server needs a key. It is optional. |
| `ELEVENLABS_API_KEY` | `--tts elevenlabs` |
| `GITHUB_TOKEN`, `GH_TOKEN` | Reading private pull requests, and writing comments. |
| `MERGESTORY_S3_ACCESS_KEY_ID`, `MERGESTORY_S3_SECRET_ACCESS_KEY` | Uploading to S3-compatible storage. Set both or neither. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | The usual AWS variables. When the two `MERGESTORY_S3_` keys are not set, the AWS credential chain is used: these variables, a profile, single sign-on or a role. |
| `MERGESTORY_API_TOKEN` | `mergestory serve`. The name can be changed with `--token-env`. |
| `MERGESTORY_YOUTUBE_CLIENT_ID`, `MERGESTORY_YOUTUBE_CLIENT_SECRET`, `MERGESTORY_YOUTUBE_REFRESH_TOKEN` | Uploading to YouTube from CI. See [youtube.md](youtube.md). |

The moment MergeStory reads one of these, it registers the value with its redactor, so the value is
masked in logs, results, job files and error messages. The programs it starts (git, `gh` and the installer of
the free voice) get an environment without them.

## Other environment variables

| Variable | What it does |
|---|---|
| `MERGESTORY_HOME` | The MergeStory home folder. The default is `~/.mergestory`. |
| `MERGESTORY_CONFIG` | The config file to use. See [The config file](#the-config-file). |
| `MERGESTORY_LOG_LEVEL`, `MERGESTORY_LOG_FORMAT` | The same as `--log-level` and `--log-format`. |
| `MERGESTORY_KOKORO_DTYPE` | The precision of the free voice model: `q8` (small, about 90 MB) or `fp32` (full, about 330 MB). The default is `fp32` on Apple Silicon and `q8` elsewhere. |
| `GITHUB_API_URL` | The same as `github.apiUrl`. |
| `ANTHROPIC_BASE_URL` | Sends Anthropic requests to a gateway instead of `api.anthropic.com`. It must use `https`, unless the host is on this machine or a private network. MergeStory counts a gateway on this machine as free, so its budget check does not cover what that gateway forwards. |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | The region of an Amazon S3 bucket, when `publish.s3.region` is `auto`. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where to look for a browser that Playwright installed. |
| `NO_COLOR`, `FORCE_COLOR` | Turn terminal colors off or on. |

## Quality presets

`quality` picks the size, the frame rate and the encoder settings of the video.

| Preset | Size | Frames per second | Encoder quality (CRF) | Encoder speed |
|---|---|---|---|---|
| `draft` | 1280 x 720 | 24 | 28 | `veryfast` |
| `standard` | 1920 x 1080 | 30 | 23 | `medium` |
| `high` | 1920 x 1080 | 60 | 20 | `slow` |

CRF is the quality setting of the H.264 encoder. A lower number means better quality and a bigger file.
Use `draft` to check a storyboard quickly, or on a small machine.

## Privacy options

Some protections are always on, and a setting cannot turn them off:

- **Sensitive files are never shown or sent.** This covers `.env` files (not `.env.example`), private keys
  and certificates, cloud and tool credential files, Terraform state and variable files, kubeconfig files and
  similar. Their names can still appear in the list of changed files, but their content never does. Everything
  else is shown as it is, because explaining the real code is the point.
- **Secrets are masked.** Code lines, captions, narration and on-screen text are scanned for keys and tokens
  before rendering and before any model call. This includes `Authorization` header values (`Bearer` and
  `Basic`) and key headers such as `X-Api-Key`.

These settings change what else is hidden:

- `privacy.excludePaths` adds your own paths to the sensitive ones. The patterns follow the rules of
  `.gitignore`, with the differences named below:
  - A pattern with no `/` in it matches a file or folder name at any depth (`*.generated.ts`, `secrets`).
  - A pattern with a `/` at the start or in the middle starts at the root of the repository (`/build`,
    `config/prod.yaml`, `src/internal/`).
  - A `/` at the end means a folder only. On its own it does not tie the pattern to the root: `internal/`
    hides `internal/a.ts` and `pkg/internal/a.ts`, but not a file named `internal`.
  - A match on a folder covers everything inside it.
  - `*` matches any characters except `/`, and `?` matches one character except `/`.
  - `**/` at the start of a pattern or right after a `/` matches zero or more whole folders:
    `**/generated/**` hides `src/generated/api.ts`, but not `src/autogenerated/api.ts`. Any other `**`
    matches any characters including `/`, also inside a name: `src/**.test.ts` hides `src/a/b.test.ts`. In
    `.gitignore`, such a `**` stays inside one name.
  - Every other character matches itself. Unlike in `.gitignore`, `#` does not start a comment, `!` does not
    undo a pattern, and `[` does not start a set of characters, so `app/[slug]/` hides that folder.
  - Case is ignored, because this is a privacy control and it errs on the side of hiding more.
  - `\` counts as `/`. A leading `./` and spaces around a pattern are ignored. A pattern that is blank or
    only `/` hides nothing.
- `privacy.maskEmails` keeps e-mail addresses out of everything people see. It is on by default.
- `privacy.llmContext` set to `minimal` keeps code away from a model. The model then gets only metadata,
  paths and symbol names, and writes a storyboard without code scenes.

See [SECURITY.md](../SECURITY.md) for the whole picture.

## Pricing overrides

MergeStory knows the prices of the models it uses by default. Providers change prices, and you may use another
model, so you can set your own prices. They replace the built-in ones.

A key is `<provider>:<model>`, or `<provider>:*` for every model of a provider. The provider is `anthropic`,
`openai`, `openai-compatible` or `elevenlabs`. For a language model, a name with a date at the end
(`-20261001`, `@20261001` or `-2026-10-01`) also matches the price of the name without the date.

```json
{
  "pricing": {
    "openai-compatible:acme-large": { "kind": "llm", "inputPerMTok": 0.4, "outputPerMTok": 1.6 },
    "openai:gpt-4o-mini-tts": { "kind": "tts", "perMChars": 18 },
    "elevenlabs:*": { "kind": "tts", "perMChars": 80 }
  }
}
```

- `kind: "llm"` takes `inputPerMTok` and `outputPerMTok`: US dollars per million input and output tokens.
- `kind: "tts"` takes `perMChars`: US dollars per million characters of text.
- Other fields are errors, and so are negative numbers.

## Budget

`budgetUsd` is the most one run may spend. It is checked before every paid call, so a run never goes over:

- MergeStory estimates the cost of a call from its size and the price, and assumes that a model answer uses
  all of `llm.maxOutputTokens`. If the run's total would pass the budget, the call is not made and the run
  ends with the error `BUDGET_EXCEEDED` (exit code 4).
- A model call that fails the checker is sent back for repair, and each repair is checked too. When the
  budget has no room left for a repair, the offline storyboard takes over.
- Speech is checked before each request, from the number of characters.
- A cached answer or clip costs nothing. Local speech (Kokoro, macOS `say`) costs nothing. A model server on
  this machine or on a private network counts as free.
- Storage is recorded as 0, because your storage provider bills you and MergeStory does not.
- `--dry-run` shows the estimate and adds a warning when it is over the budget.
- Every paid call is listed in `cost.records` of the result. `estimated: true` means that the cost comes from
  a price list and not from a bill.

**A model with no known price.** MergeStory does not guess low. For a language model, it counts the call at
the highest listed rate: $10 per million input tokens and $50 per million output tokens. So an unlisted model
can never slip past the budget. A warning names the model, once. For speech, an unlisted OpenAI model counts
at $30 per million characters, and an unlisted ElevenLabs model or other provider counts at $80. Add the
real price to `pricing` to get an accurate figure.

## Where files go

Everything MergeStory writes is under the home folder, `~/.mergestory` or `$MERGESTORY_HOME`. Nothing is
written inside the repository being explained.

| Folder | What it holds |
|---|---|
| `runs/<run id>/` | One folder per run. See [cli.md](cli.md#run-folders). |
| `cache/` | Speech clips, model answers and file contents. |
| `jobs/<job id>/` | The state of background jobs. |
| `models/` | Downloaded models, such as the Kokoro speech model. |
| `plugins/` | The free voice, installed by the first English run or by `mergestory setup kokoro`. |
| `credentials/` | The YouTube sign-in. The folder is private (mode 0700) and the file is readable by you only (mode 0600). |
| `config.json` | Your config file, if you made one. |
| `kokoro-install.lock` | Only there while the free voice is being installed, so two installs never run at once. |

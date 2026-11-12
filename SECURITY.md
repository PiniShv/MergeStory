# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability
reporting ("Report a vulnerability" on the Security tab of this repository). We aim to reply
within a few days and will credit reporters who want it.

## How MergeStory handles your code

A MergeStory video is meant to show your code: the real files, functions and lines, and how the
implementation works. The protections below only hide credentials and personal data, and control
who can open a video. They never water down the explanation.

MergeStory reads pull requests and repository content, which may be private. Its defaults are
built so that nothing from your code or the change leaves your machine unless you configure it.

### Your code and your repository

- **No telemetry.** MergeStory never contacts a service you did not configure, with one exception:
  the first English run downloads the free voice once, from the npm registry (`registry.npmjs.org`,
  or the one your npm settings name) and `huggingface.co`. This sends nothing from the change. `--tts say` or `--tts none` (or
  `MERGESTORY_TTS_PROVIDER`) avoids it.
- **Reads only.** It never changes your repository, your working tree or your git state. It never
  writes into the repository it explains: a run folder inside that repository is refused. It writes
  to a pull request only when you pass `--comment` or `--update-description`.
- **Git runs only in a repository of your own.** The settings of a repository can name programs for
  git to run. MergeStory reads a repository only when a `.git` entry names it, as in a normal clone or
  work tree. Git never checks out an entry with that name, so those settings are yours. MergeStory
  does not run inside a bare repository (a work tree of one is fine), or in a repository that sits
  inside a checked-out folder. The same goes for a repository in MergeStory's work folder, where a
  coding agent may write without asking. That folder is recognised by what it is on disk, also under
  a second name. Not covered: unusual mount setups that only an administrator can create. A `.git`
  folder that arrived another way, for example inside an archive, is trusted as your own git
  commands trust it.
- **Remote providers are opt-in.** The default storyboard is written by your coding agent or built
  offline, and the default voice runs locally. A remote LLM or speech service is used only when you
  select it. Each run reports what was sent and where (`egress` in the result, and the dry-run plan).
  `privacy.llmContext` set to `minimal` keeps code away from a model.
- **Sensitive files stay hidden.** `.env` files, private keys, credentials files, Terraform state and
  any path in `privacy.excludePaths` are never shown in a video and never sent to a provider.
  Everything else is shown as it is, because explaining the real code is the point.
- **Secrets are masked.** Code, captions, narration and on-screen text are scanned for keys and
  tokens, which are replaced before rendering and before any provider call. E-mail addresses are
  masked too.
- **Rendering is offline.** The browser page that draws the video has no network access. Fonts are
  built in, so the output does not depend on the machine.
- **The browser keeps its sandbox where it can.** The browser that draws the video runs with its own
  sandbox, so a flaw in how it reads an image from the change does not give access to your machine. A
  browser cannot start with the sandbox as root, which is common in containers, and some systems refuse it
  to a normal user (Ubuntu 23.10 and later, with a downloaded Chromium). There MergeStory starts the browser
  without the sandbox and says so. Run it as a normal user with Google Chrome when you can. See
  [Running in a container](docs/hosting.md#running-in-a-container).

### Credentials and settings

- **Credentials come from environment variables only.** They are never written to logs, job
  files, results or URLs, and no flag takes a secret. Config files that contain secret-like keys are
  rejected. The programs MergeStory starts (git, `gh`, the installer of the free voice) run without
  your keys and tokens.
- **The config file has a fixed place.** MergeStory reads it only from `MERGESTORY_CONFIG`,
  or from `$MERGESTORY_HOME/config.json` (by default `~/.mergestory/config.json`).
  It never reads one from the current folder, because that is often the repository being explained, and
  a file there could point MergeStory at other programs, servers or API hosts. Every key in the file is
  checked, and an unknown key is an error.
- **Some commands are safe to pre-approve for a coding agent:** `mergestory --version`,
  `mergestory doctor --json` (exactly so: with `--online` it contacts your storage) and every
  `mergestory agent ...` command. A coding agent can be steered by text in a pull request. So whatever
  arguments it adds to an `agent` command:
  - The command reads the current repository (through git), its work folder and MergeStory's own
    files: the settings, the cache and the voice.
  - It writes only in the MergeStory home (the work folder, the run folder, the cache and the one-time
    voice install) and in the system's temporary folder. During that one install, npm also fills its
    own cache.
  - It starts only the programs MergeStory itself uses: git, `gh`, FFmpeg, a browser, the local voice
    and, once, npm to install that voice. No argument can name a program.
  - It never uploads, comments or spends money.
  - It contacts two kinds of host only: GitHub, to read a pull request of the current repository, and
    the hosts of the one-time voice download, which sends nothing from the change.

  `agent render` always runs without a model, with a local voice and without an upload or a comment,
  whatever the environment or the config file says. The promise is for the plain command: a variable
  set in front of it, such as `MERGESTORY_CONFIG=<file>`, changes what it does, so do not pre-approve
  that form. The general commands (`analyze`, `validate`, `generate`, `publish`) have flags that name
  files, folders and hosts, so approve each of them when it runs.
- **Tokens go only where they belong.** A GitHub token from the environment is only sent to
  `api.github.com` or to the host you set in `github.apiUrl`, so a pull request URL can never send it to
  another server. A model address with a user name or password in it is refused, and so is plain `http`
  to a public host.
- **The free voice is installed with care.** The first English run (or `mergestory setup kokoro`)
  installs exact package versions from a lockfile with a hash for every package, skips install scripts, and checks the speech
  model files against known SHA-256 digests. The installer gets no API keys.

### Sharing a video

- **Private links by default.** Uploaded videos use unguessable object keys (a 128-bit random token,
  with no repository or user name) and signed links that expire after 7 days at most. A link that
  anyone has can be opened until it expires, so treat it like a password.
- **Protected links.** `--visibility protected` makes permanent links on your own domain, behind an
  access proxy such as Cloudflare Access. Before it uploads anything, MergeStory sends one anonymous
  request to that address and checks that it asks for a sign-in. If the address is open, or if
  MergeStory cannot tell, nothing is uploaded. The check proves that there is a sign-in step. It cannot
  see who is allowed in, so read your access policy. The pull request comment says that the link needs a
  team sign-in and shows no preview image. See [docs/hosting.md](docs/hosting.md).
- **Public links need an opt-in.** A link that anyone can open is a `public` S3 link, or a YouTube video
  that is not private. It is blocked for a private repository, and for a repository whose privacy
  MergeStory cannot tell, unless you set `publish.allowPublicForPrivateRepos`.
- **YouTube.** `--publish youtube` always sends the privacy setting, `unlisted` by default, because
  YouTube makes a video public when it is left out. A video that others can open is refused for a
  private repository unless you choose `private` or opt in. The description holds the pull request
  link only for public repositories. Uploads do not notify subscribers. The saved sign-in is readable
  by you only, and MergeStory refuses to read it if other users can. Tokens stay in memory and are
  never logged. See [docs/youtube.md](docs/youtube.md).
- **Share later.** You can render a video, watch it on your machine, and upload it only when you are
  happy: `mergestory publish <run>`. Only the video, the poster and the captions of the run folder are
  uploaded, and a file that leads outside the folder is refused. Before MergeStory makes a link that
  anyone can open, it asks GitHub again whether the repository is public. The note in the run folder
  is not believed on its own.

### Untrusted text

- **Pull request text is data.** It is labelled as untrusted in prompts. Model output must match a
  strict schema and pass the grounding checks. Text is checked for web addresses and for names that
  are not in the change.
- **Output is escaped.** The watch page is one HTML file with a strict content security policy. It loads
  nothing from other sites, tells search engines to stay away and sends no referrer. All text is
  escaped. Pull request comments are cleaned too: no mentions, no HTML and no live links.
- **Your terminal is protected.** Text from a pull request, a commit or a file name is cleaned of control
  characters before it is printed, so it cannot rewrite your screen.

### The HTTP API

- **It is local by default.** `mergestory serve` binds to 127.0.0.1 and requires a bearer token of at
  least 16 characters on any other address. On a loopback address it checks the `Host` header, so a web
  page cannot reach it through a name that points at your machine. It sends no CORS headers.
- **Local repositories are opt-in.** A path is accepted only inside a folder you allow with
  `--allow-root`, and the whole repository must be inside it.
- **It takes no secrets.** The server uses its own environment, and a request cannot choose a model
  server, a screenshot file or a YouTube upload. Requests are limited in size and in time.

See [docs/api.md](docs/api.md#safety-rules).

### What to keep in mind

- Masking looks for patterns. It is eager on purpose, but it cannot know every kind of secret. Watch the
  video before you share it outside your team, and do not keep secrets in code.
- MergeStory never runs your tests or your code. Test results in a video are the ones you reported, and
  the video says who reported them.
- A model server on this machine counts as free in the budget check, and MergeStory cannot see what such
  a server forwards to another service.
- The video explains a change. It does not replace code review.

## Supported versions

Security fixes go into the latest release.

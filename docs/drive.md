# Publishing to Google Drive

MergeStory can upload the finished video to your own Google Drive and give you a normal Drive link.
It talks to the Google Drive API directly, with a Google Cloud project that you or your organization
own. Nothing goes through a MergeStory server, and there is no shared account.

```bash
mergestory setup drive                        # once: sign in to Google in the browser
mergestory generate owner/repo#123 --publish drive
mergestory publish <run> --publish drive --visibility protected --comment
```

The video goes into a folder named `MergeStory` in your Drive. The facts here were checked in
November 2026. Where something may change, this page says "check the current Google docs".

## When to use Google Drive

- **Teams on Google Workspace.** With `--visibility protected`, everyone in your organization can
  open the link after they sign in, and nobody else can. You need no storage bucket and no sign-in
  proxy.
- **Private code.** A protected or private link is allowed for a private repository.
- **Not for public sharing at scale.** A public Drive link works, but YouTube or S3 suit videos for
  everyone better.

## Privacy defaults

`publish.visibility` (or `--visibility`) decides who can open the link:

| Visibility | What MergeStory sets in Drive | Who can open the link |
|---|---|---|
| `private` (default) | nothing | Only you. |
| `protected` | a `domain` permission, role `reader` | Anyone in your Google Workspace organization who has the link, after they sign in. |
| `public` | an `anyone` permission, role `reader` | Anyone who has the link. |

In both shared cases the file cannot be found through search (`allowFileDiscovery: false`), and Google
sends no e-mail.

`protected` needs a Google Workspace account. With a `gmail.com` account MergeStory stops before the
upload and asks you to use `private`, or `public` for public code. Another personal account (made
with a different e-mail address) is not recognised before the upload: Drive then refuses to share,
and the video stays private, as described below.

A Workspace can share every new file with the whole organization by default. MergeStory turns that
off for its folder and its videos, so only the visibility you chose applies. If a share fails, it asks
Drive who can open the file and reports that, or stops when Drive cannot say.

MergeStory uploads only into a `MergeStory` folder that you own, in the top level of your Drive, and
that nobody else can open. Files in a shared folder take on its sharing, so MergeStory makes a new
folder when the old one is shared.

If Drive refuses to share the file (for example because an administrator turned link sharing off),
the upload still counts. The video stays private in your Drive, the result says `private`, and a
warning tells you why. You can share it yourself in Drive.

### The private-repository guard

Only `public` meets the guard. If the repository is private, or MergeStory cannot tell, a public
link is refused with `PRIVACY_BLOCKED` before anything is sent to Google. Use `protected` or
`private`, or set `publish.allowPublicForPrivateRepos` to `true` if anyone with the link may watch
the video.

`protected` and `private` are allowed for a private repository: only your colleagues, or only you,
can open the link. For the same reason the file description holds the pull request link for every
repository.

## Set up Google Cloud

This is done once per organization, by someone who may create projects. Menu names change often;
check the current Google docs if a name below is not found.

1. **Create a Google Cloud project** in the Google Cloud console, inside your organization.
2. **Turn on the API.** In *APIs & Services*, open *Library*, find **Google Drive API** and enable it.
3. **Set up the consent screen** in *Google Auth Platform*. Enter an app name and the e-mail
   addresses Google asks for. Choose the audience **Internal**: only people in your organization can
   sign in, Google shows no "unverified app" screen, and sign-ins do not end after 7 days.
4. **Add the permission.** Under *Data Access*, add `https://www.googleapis.com/auth/drive.file`.
   Google lists it as non-sensitive.
5. **Create the OAuth client.** In *Google Auth Platform*, open *Clients*, choose *Create client* and
   pick the application type **Desktop app**. Give it any name.
6. **Copy the client id and the client secret.** The console shows the full secret only once.

### The one permission

MergeStory asks only for `drive.file`. With it, MergeStory can reach **only the files and folders
that it created itself**. It cannot see or change anything else in your Drive. This is also why
MergeStory makes its own `MergeStory` folder: it cannot write into a folder that already exists.

## For an organization

Give every laptop the same client id and secret through environment variables, for example in the
`env` block of Claude Code's managed settings:

```json
{
  "env": {
    "MERGESTORY_DRIVE_CLIENT_ID": "123-abc.apps.googleusercontent.com",
    "MERGESTORY_DRIVE_CLIENT_SECRET": "GOCSPX-example",
    "MERGESTORY_PUBLISH_PROVIDER": "drive",
    "MERGESTORY_VISIBILITY": "protected"
  }
}
```

- Google does not treat the client id and secret of a *Desktop app* client as confidential: they are
  part of every copy of the app. Sharing them inside the organization is the normal way to use them.
- The **refresh token is personal**. Each person signs in once with `mergestory setup drive`, and the
  token stays on their laptop. It never goes into managed settings.
- With `MERGESTORY_PUBLISH_PROVIDER=drive`, `mergestory publish <run> --comment` uploads to Drive
  without a `--publish` flag.
- Values in Claude Code's managed settings reach **only the shells that Claude Code starts**, and only
  in sessions started after the change. They do not reach a person's own terminal. So with the
  MergeStory skill, the coding agent runs `mergestory setup drive` itself, and the person only picks
  the account and clicks Allow in the browser. Someone who runs `mergestory` in their own terminal
  exports the same variables there.

## Sign in: `mergestory setup drive`

```bash
mergestory setup drive
```

What happens:

1. MergeStory shows the permission it will ask for, and why.
2. It takes the client id and secret from `MERGESTORY_DRIVE_CLIENT_ID` and
   `MERGESTORY_DRIVE_CLIENT_SECRET`, or asks you to type them (hidden).
3. It starts a short-lived listener on `127.0.0.1` on a random port, prints the Google sign-in
   address and tries to open it in your browser.
4. Google asks which account to use: pick your company account. You allow the permission. MergeStory checks a random `state` value, trades the code for
   tokens (with PKCE), and waits at most 5 minutes.
5. The refresh token is saved to `~/.mergestory/credentials/drive.json` (under `$MERGESTORY_HOME` if
   you set it). The folder has mode 0700 and the file mode 0600. MergeStory **refuses to read the
   file if other users can read it**.

`mergestory doctor --online` shows the organization of the account you signed in with.

**Without a terminal**, for example when a coding agent runs the command for you, the sign-in still
runs when both the client id and the client secret come from the environment, so nothing has to be
typed, and the `CI` variable is not set. You finish the sign-in in the browser. In every other case
it refuses and says what to do. Both the refusal and the interactive prompt say which of the two
variables are set, by name only, so a missing variable is easy to see. If the agent runs in a
sandbox, it needs to open the browser and to listen on `127.0.0.1` for this one command.

For CI, sign in on your own machine and store the values as the secrets
`MERGESTORY_DRIVE_CLIENT_ID`, `MERGESTORY_DRIVE_CLIENT_SECRET` and `MERGESTORY_DRIVE_REFRESH_TOKEN`.
The setup command prints the commands for that. Environment values win over the file, value by value.

To sign out, delete the file, and remove the app's access in your Google Account settings.

## What a colleague sees

The pull request comment links to the file in Drive and says "Watch on Google Drive". With
`protected`, a colleague who is signed in to the organization's Google account opens the video in
Drive's player. Someone outside the organization cannot open it. With
`private`, only you can open it.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `publish.provider` | `local` | `drive` uploads to Google Drive. Environment: `MERGESTORY_PUBLISH_PROVIDER`. |
| `publish.visibility` | `private` | `private`, `protected` or `public`, as above. Environment: `MERGESTORY_VISIBILITY`. |
| `publish.allowPublicForPrivateRepos` | `false` | Allows a public link for a private repository. |

What goes into the file:

- **Name:** `<title> (<change label>).mp4`, without control characters, `/` or `\`, at most 150
  characters before the extension.
- **Description:** the summary, the pull request link, the chapters with their start times, the
  review checklist and two fixed lines. Plain text, at most 3,000 characters.
- Only the video is uploaded. The captions are already drawn into it.

## What leaves your machine

- The video file, its name and its description go to `www.googleapis.com`.
- Before the upload, MergeStory looks for its `MergeStory` folder, and creates it when it is missing.
- For `protected`, MergeStory asks Google for the e-mail address of the account and keeps only the
  part after `@` (the organization domain). The address is never shown or stored.
- To share, MergeStory adds one permission to the file.
- The sign-in talks to `accounts.google.com` and `oauth2.googleapis.com`.
- Nothing else is sent, and there is no telemetry. Each run lists its transfers in the `egress` part
  of the result. Access tokens only live in memory.

`mergestory doctor` says whether you are signed in and which permission the sign-in has. With
`--online` it also shows the organization domain of the account.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "No Google Drive sign-in was found" | You have not signed in on this machine. | Run `mergestory setup drive`. |
| "Protected links need a Google Workspace account" | The account is a personal Google account, which belongs to no organization. | Use `--visibility private`, or `public` for public code. |
| "The video is in the MergeStory folder of your Google Drive, but it could not be shared" | An administrator does not allow this kind of sharing, or Google refused the permission. | Share the file yourself in Drive, or ask the administrator about the Drive sharing settings. |
| "Google no longer accepts the saved Google Drive sign-in" | The sign-in expired or was revoked. | Run `mergestory setup drive` again. |
| "The Google Drive API is not turned on" | The API is not enabled for the project that owns the client. | Enable Google Drive API for that project, wait a minute, and try again. |
| "Google rejected the OAuth client id or secret" | A wrong id or secret, or a client that is not a *Desktop app*. | Check `MERGESTORY_DRIVE_CLIENT_ID` and `MERGESTORY_DRIVE_CLIENT_SECRET`. |
| "Signing in to Google Drive needs a person at a terminal" | There is no terminal and not both client values are in the environment, or `CI` is set. | Run setup in a terminal, or set both client values. |
| `PRIVACY_BLOCKED` | A public link for a private repository (or one MergeStory cannot tell). | Use `protected` or `private`. |

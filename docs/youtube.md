# Publishing to YouTube

MergeStory can upload the finished video to your own YouTube channel and give you a normal YouTube
link. It talks to the YouTube Data API directly, with a Google Cloud project that you own. Nothing
goes through a MergeStory server, and there is no shared account.

```bash
mergestory setup youtube                      # once, on a machine with a browser
mergestory generate owner/repo#123 --publish youtube
```

To review a video before it leaves your machine, render it first and upload it later with
`mergestory publish <run> --publish youtube`.

Google changes its consoles, quotas and rules from time to time. The facts here were checked in
November 2026. Where something may change, this page says "check the current Google docs".

## When to use YouTube

- **Public or open-source projects.** A public repository can have a public or unlisted video.
- **Teams that accept YouTube for sharing.** An *unlisted* video has a link that anyone who has it
  can open. It does not show up in search or on your channel page.
- **Not the default for private code.** For a private repository MergeStory blocks every video that
  other people could open, unless you choose `private` (see below). If your code is private and your
  team needs to share the video, the S3-compatible publisher with expiring links is usually a better
  fit.

## Privacy defaults

| Setting | Who can watch |
|---|---|
| `private` | Only you, unless you share it from YouTube Studio. |
| `unlisted` (default) | Anyone who has the link. |
| `public` | Anyone. The video can be found in search. |

MergeStory always sends the privacy status explicitly. When it is left out, YouTube makes the
video public. After the upload, MergeStory compares the status that YouTube reports with the one it
asked for, and prints a warning when they differ (for example when account settings force
`private`). Since 2 November 2026 Google no longer forces uploads from unverified API projects to
private; check the current Google docs.

### The private-repository guard

If the repository is private, or MergeStory cannot tell, **and** `privacyStatus` is not `private`,
the upload is refused with `PRIVACY_BLOCKED` before anything is sent to Google. Two ways out:

1. Set `publish.youtube.privacyStatus` to `private`. Only you can watch the video, unless you share
   it from YouTube Studio.
2. Set `publish.allowPublicForPrivateRepos` to `true`, if anyone with the link may watch the video.

Other privacy choices:

- The video description shows the pull request link **only for public repositories**. For a private
  repository MergeStory adds no link and no repository name; the description holds the summary,
  the chapters and the checklist.
- Uploads do not notify your subscribers (`notifySubscribers=false`).
- The videos are not marked as made for kids, and embedding is allowed.
- MergeStory does not set YouTube's "altered or synthetic content" label. Read YouTube's current
  policy on that label. If your video uses a cloned voice, or the voice of a real person, set the
  label yourself in YouTube Studio.

## Set up Google Cloud

You need a Google Cloud project, the YouTube Data API turned on, and an OAuth client of the type
"Desktop app". Menu names change often; check the current Google docs if a name below is not found.

1. **Create or choose a Google Cloud project** in the Google Cloud console.
2. **Turn on the API.** In *APIs & Services*, open *Library*, find **YouTube Data API v3** and
   enable it for the project.
3. **Set up the consent screen** in *Google Auth Platform*. Google asks for an app name, a support
   e-mail address, an audience and a contact e-mail address. For the audience:

   | Audience | What it means |
   |---|---|
   | **Internal** | For projects that belong to a Google Workspace or Cloud Identity organization. Only people in the organization can sign in. Google shows no "unverified app" screen. **Best choice if you can use it.** |
   | **External**, status *Testing* | You list the test users (up to 100). **Google ends each sign-in after 7 days**, so the saved sign-in stops working every week. Fine for trying things out on a laptop, not for CI. |
   | **External**, status *In production* (click **Publish app**) | Sign-ins last. The app is not verified, so people see a warning screen and have to continue past it. Google limits an unverified app to 100 new users over the life of the project. |

   Under *Data Access*, add the permission that MergeStory asks for (see
   [Permissions](#permissions)).
4. **Create the OAuth client.** In *Google Auth Platform*, open *Clients*, choose *Create client*
   and pick the application type **Desktop app**. Give it any name. Leave the other options at their
   defaults.
5. **Copy the client secret straight away.** The console shows the full secret only once. Never put
   it in a config file or in git.
6. **Check the account.** The Google account that you sign in with must have a YouTube channel.
   Service accounts do not work with YouTube.

## Sign in: `mergestory setup youtube`

```bash
mergestory setup youtube
```

Run it in a normal terminal on your own machine. It needs a person and a browser, so it refuses to
run when it has no terminal (for example in CI).

What happens:

1. MergeStory shows the permissions it will ask for, and why.
2. It takes the client id and secret from `MERGESTORY_YOUTUBE_CLIENT_ID` and
   `MERGESTORY_YOUTUBE_CLIENT_SECRET`, or asks you to type them. What you type is hidden. They are
   never command-line flags, so they do not end up in your shell history.
3. It starts a short-lived listener on `127.0.0.1` (your own machine only) on a random port,
   prints the Google sign-in address and tries to open it in your browser. If nothing opens, copy
   the address into a browser yourself.
4. You sign in and allow the permissions. Google shows its permission screen every time.
5. Google sends the browser back to the listener with a one-time code. MergeStory checks a random
   `state` value, trades the code for tokens (with PKCE), and closes the listener. It waits at most
   5 minutes.
6. The refresh token is saved to `~/.mergestory/credentials/youtube.json` (under
   `$MERGESTORY_HOME` if you set it). The folder is private (mode 0700) and the file can only be
   read by you (mode 0600). MergeStory **refuses to read the file if other users can read it**, and
   tells you to run `chmod 600` on it.

The token itself is never printed. To sign out, delete the file, and remove the app's access in your
Google Account settings.

### Permissions

The settings decide which permission MergeStory asks for, so it asks for as little as it needs:

| Settings | Permission asked for | What Google calls it |
|---|---|---|
| Upload and thumbnail only (the default) | `youtube.upload` | "Manage your YouTube videos" |
| `uploadCaptions` is on, or `playlistId` is set | `youtube.force-ssl` | "See, edit, and permanently delete your YouTube videos, ratings, comments and captions" |

`youtube.upload` covers the upload and the thumbnail. Captions and playlists need `youtube.force-ssl`,
which is broader and covers everything MergeStory does. Google words it with "delete", but MergeStory
only uploads and never deletes. If you turn captions or a playlist on later, run
`mergestory setup youtube` again. Until then MergeStory skips those steps with a warning.

## Use it in CI

Interactive sign-in only works on a machine with a browser. Sign in there once, then give CI the
saved values as secrets:

| Secret | Value |
|---|---|
| `MERGESTORY_YOUTUBE_CLIENT_ID` | the OAuth client id |
| `MERGESTORY_YOUTUBE_CLIENT_SECRET` | the OAuth client secret |
| `MERGESTORY_YOUTUBE_REFRESH_TOKEN` | the `refresh_token` from the credentials file |

With the GitHub CLI and `jq` (bash or zsh), the values go from the file into the secrets without
being printed:

```bash
gh secret set MERGESTORY_YOUTUBE_REFRESH_TOKEN < <(jq -r .refresh_token ~/.mergestory/credentials/youtube.json)
gh secret set MERGESTORY_YOUTUBE_CLIENT_ID < <(jq -r .client_id ~/.mergestory/credentials/youtube.json)
gh secret set MERGESTORY_YOUTUBE_CLIENT_SECRET < <(jq -r .client_secret ~/.mergestory/credentials/youtube.json)
```

In CI, set all three. The credentials file is only read when the client id or the refresh token is
missing from the environment, and environment values win over the file value by value.

```yaml
env:
  MERGESTORY_PUBLISH_PROVIDER: youtube
  MERGESTORY_YOUTUBE_PRIVACY: unlisted
  MERGESTORY_YOUTUBE_CLIENT_ID: ${{ secrets.MERGESTORY_YOUTUBE_CLIENT_ID }}
  MERGESTORY_YOUTUBE_CLIENT_SECRET: ${{ secrets.MERGESTORY_YOUTUBE_CLIENT_SECRET }}
  MERGESTORY_YOUTUBE_REFRESH_TOKEN: ${{ secrets.MERGESTORY_YOUTUBE_REFRESH_TOKEN }}
```

A refresh token stops working when you revoke access, when it has not been used for 6 months, when
the consent screen is *External* and in *Testing* (after 7 days), or when Google's limit of 100
refresh tokens per account and client is reached (the oldest one is dropped). Check the current Google
docs for the full list. When that happens, run `mergestory setup youtube` again and update the
secret.

## Settings

Put these in your config file (`~/.mergestory/config.json`, or the file named by `MERGESTORY_CONFIG`). Secrets never go in the config file.

```json
{
  "publish": {
    "provider": "youtube",
    "youtube": {
      "privacyStatus": "unlisted",
      "categoryId": "28",
      "playlistId": null,
      "uploadCaptions": false,
      "setThumbnail": true
    }
  }
}
```

| Setting | Default | What it does |
|---|---|---|
| `publish.youtube.privacyStatus` | `unlisted` | `private`, `unlisted` or `public`. Environment: `MERGESTORY_YOUTUBE_PRIVACY`. |
| `publish.youtube.categoryId` | `28` | YouTube category id (28 is Science & Technology). YouTube refuses an unknown id. |
| `publish.youtube.playlistId` | none | Adds each video to this playlist. Needs `youtube.force-ssl`. Environment: `MERGESTORY_YOUTUBE_PLAYLIST_ID`. |
| `publish.youtube.uploadCaptions` | `false` | Also uploads `captions.vtt` as a caption track. Needs `youtube.force-ssl`. The captions drawn into the video are always there; this only adds the track. |
| `publish.youtube.setThumbnail` | `true` | Uses the poster image as the thumbnail. YouTube only allows custom thumbnails on verified channels. |
| `publish.allowPublicForPrivateRepos` | `false` | Allows a video that others can open for a private repository. |

The thumbnail, the caption track and the playlist entry are optional. If one of them fails, the video
stays on YouTube and MergeStory prints a warning.

### What goes into the video details

- **Title:** the title of the video, at most 100 characters.
- **Description:** the summary, the chapters, the review checklist, the pull request link (public
  repositories only) and two fixed lines: "Made with MergeStory - every change has a story." and
  "This video explains the change; it does not replace code review." At most 5,000 bytes.
- **Tags:** a few short, generic tags.
- **Language:** the narration language.

YouTube refuses the characters `<` and `>` in titles and descriptions, so MergeStory swaps them for
the look-alike marks `‹` and `›`.

**Chapters.** YouTube only makes chapters from timestamps in the description when the first one is
`00:00`, there are at least three, and every chapter lasts at least 10 seconds. MergeStory checks
this, using the real length of the video. When the rules are met, it writes the chapters with
timestamps. When they are not, it writes a plain list without timestamps, so YouTube does not show
broken chapters.

## Quota and limits

Numbers checked in November 2026. Check the current Google docs for the latest.

- **Uploads:** a project can upload **100 videos a day**. Uploads have their own quota bucket, and
  each upload costs 1 unit of it.
- **Everything else** shares **10,000 units a day**: setting a thumbnail costs 50 units, adding a
  caption track costs 400 units, and adding a playlist entry costs 50 units.
- A video with a thumbnail, captions and a playlist entry uses about 500 units, so about 20 such
  videos fit into one day. Without captions the 100-uploads limit comes first. Captions are off by
  default for this reason.
- Quotas reset at midnight Pacific Time. Every request counts, even a refused one.
- The cost report shows each call and the quota it used. The money cost is always zero.
- To raise the quota, Google asks you to complete its audit and quota extension form.

Channel limits that are not about MergeStory:

- A channel that is not verified can only upload videos up to 15 minutes long. MergeStory videos are
  at most 10 minutes long, so this does not matter.
- Custom thumbnails need a verified channel.
- YouTube limits how many videos a channel can upload per day, whatever the quota. Google does not
  publish the number.

## What leaves your machine

- The video file, and the details above (title, description, tags), go to `www.googleapis.com`.
  The thumbnail and the caption track go there too when they are on.
- The sign-in talks to `accounts.google.com` and `oauth2.googleapis.com`.
- Nothing else is sent, and there is no telemetry. Each run lists its transfers in the `egress`
  part of the result.
- Access tokens only live in memory. MergeStory never logs a token or puts one in an address.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| `PRIVACY_BLOCKED` | The repository is private (or MergeStory cannot tell) and the video would not be private. | Set `publish.youtube.privacyStatus` to `private`, or set `publish.allowPublicForPrivateRepos` to `true` if anyone with the link may watch. |
| "Google no longer accepts the saved YouTube sign-in" | The refresh token expired or was revoked. With an *External* app in *Testing* it expires after 7 days. | Run `mergestory setup youtube` again. To stop it from coming back, publish the app or use an *Internal* app. |
| "Google rejected the OAuth client id or secret" | A wrong id or secret, or a client that is not a *Desktop app*. | Check `MERGESTORY_YOUTUBE_CLIENT_ID` and `MERGESTORY_YOUTUBE_CLIENT_SECRET`, or run setup again. |
| "The YouTube Data API is not turned on" | The API is not enabled for the project that owns the client. | Enable YouTube Data API v3 for that project, wait a minute, and try again. |
| "The daily YouTube quota ... is used up" | The project used its quota for the day. | Wait until midnight Pacific Time. Turn captions and playlists off to save quota. |
| "The YouTube channel has reached its daily upload limit" | The channel hit its own daily limit. | Wait 24 hours. Verifying the channel raises the limit. |
| "The Google account ... has no YouTube channel" | The account you signed in with has no channel. | Create a channel for it, then run setup again. |
| "YouTube refused the request (forbidden)" | The sign-in lacks a permission, the account does not own the channel, or the channel is not verified for thumbnails. | Run setup again with the needed settings turned on, and check the channel in YouTube Studio. |
| "The saved YouTube sign-in does not have the permission" or "Skipped the captions" | Captions and playlists need `youtube.force-ssl`, and the sign-in was made without it. | Turn the setting on, then run `mergestory setup youtube` again. |
| "The YouTube credentials file can be read by other users" | The file's mode is too open. | Run `chmod 600` on the file (and `chmod 700` on its folder), or run setup again. |
| "Signing in to YouTube needs a person at a terminal" | There is no terminal, for example in CI. | Run setup on your own machine, then use the CI secrets above. |
| Google shows an error page with `redirect_uri_mismatch` | The OAuth client is not of the type *Desktop app*. | Create a new client of the type *Desktop app* and use its id and secret. |
| "The sign-in timed out" | The browser sign-in was not finished within 5 minutes. | Run setup again and finish the sign-in. |
| "Google did not return a refresh token" | Google did not hand one out. | Remove MergeStory's access in your Google Account settings, then run setup again. |
| "YouTube set the video to ... although ... was requested" | Account or channel settings changed the privacy status. | Open the link in the warning (YouTube Studio) and check the video. |
| Chapters do not show up | The rules for chapters are not met (first at `00:00`, at least three, each at least 10 seconds). | MergeStory then writes a plain list. Make the chapters longer, or turn automatic chapters on in YouTube Studio. |
| People see an "unverified app" warning | The app is *External* and not verified. | They can continue past it. Use an *Internal* app to avoid the screen. |

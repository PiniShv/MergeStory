# Hosting your videos

By default a video stays on your machine. This guide shows how to share it: with a link that
expires, with a permanent link behind your team's sign-in, or on YouTube.

The settings below follow each provider's own documentation. MergeStory's tests run against a
local fake S3 server, so if a provider behaves differently today, check its current docs.

## Pick an option

| You want | Use | Link | Who can watch |
|---|---|---|---|
| To try MergeStory | [Local](#local-the-default) | a file on your disk | you |
| To share a video for a few days | [R2 with private links](#cloudflare-r2-with-private-links) or [AWS S3](#amazon-s3) | signed, 7 days at most | anyone with the link, until it expires |
| To share with your team, with links that last | [R2 + Cloudflare Access](#cloudflare-r2-with-your-teams-sign-in-protected-links) | permanent | people who sign in |
| To keep everything on your own servers | [Self-hosted S3](#self-hosted-s3-servers) | signed, or permanent behind your proxy | depends on your setup |
| Another S3 service | [Backblaze B2](#backblaze-b2) or [Google Cloud Storage](#google-cloud-storage) | signed, or permanent | anyone with the link, or your team |
| To post on your channel | [YouTube](#youtube) | a YouTube link | depends on the privacy setting |

## The three kinds of link

`publish.visibility` (flag `--visibility`) decides who can open an S3 link.

| Visibility | What it is | Needs a public base URL | Allowed for a private repository |
|---|---|---|---|
| `private` (default) | A signed link. It stops working after at most 7 days. | no | yes |
| `protected` | A permanent link on your own domain. An access proxy such as Cloudflare Access asks people to sign in first. | yes | yes, that is what it is for |
| `public` | A permanent link that anyone can open. | yes | no, unless `publish.allowPublicForPrivateRepos` is `true` |

A video of private code is never put behind a public link by accident. When MergeStory cannot
tell whether the repository is private, it treats it as private.

## Settings

A flag beats an environment variable, and an environment variable beats the config file (`~/.mergestory/config.json`, or the file named by `MERGESTORY_CONFIG`). MergeStory never reads a config file from the current folder on its own.
Keys and tokens never go into the config file: MergeStory refuses a config file that contains
them.

| Setting | Environment variable | Default |
|---|---|---|
| `publish.provider` (`local`, `s3`, `youtube`, `none`) | `MERGESTORY_PUBLISH_PROVIDER` | `local` |
| `publish.visibility` (`private`, `protected`, `public`) | `MERGESTORY_VISIBILITY` | `private` |
| `publish.linkExpirySec` (60 to 604800) | `MERGESTORY_LINK_EXPIRY_SEC` | 604800 (7 days) |
| `publish.allowPublicForPrivateRepos` | config file only | `false` |
| `publish.s3.bucket` | `MERGESTORY_S3_BUCKET` | none |
| `publish.s3.endpoint` | `MERGESTORY_S3_ENDPOINT` | none (Amazon S3) |
| `publish.s3.region` | `MERGESTORY_S3_REGION` | `auto` |
| `publish.s3.forcePathStyle` | `MERGESTORY_S3_FORCE_PATH_STYLE` | `false` |
| `publish.s3.publicBaseUrl` | `MERGESTORY_S3_PUBLIC_BASE_URL` | none |
| `publish.s3.verifyProtection` | `MERGESTORY_S3_VERIFY_PROTECTION` | `true` |
| `publish.s3.prefix` | `MERGESTORY_S3_PREFIX` | `mergestory` |
| Access key and secret | `MERGESTORY_S3_ACCESS_KEY_ID` and `MERGESTORY_S3_SECRET_ACCESS_KEY` (or the usual `AWS_*` variables, a profile or a role) | none |

Every run uploads to its own folder, `<prefix>/v/<128-bit random token>/`. The folder name holds
no repository, branch or user name. The video, poster, captions and watch page all live in it.

You can render first and share later. Look at the local video, then:

```bash
mergestory publish <run-id> --publish s3 --visibility protected --comment
```

Check your setup at any time. Without `--online` nothing is sent over the network.

```bash
mergestory doctor
```

```bash
mergestory doctor --online
```

With `--online`, MergeStory also asks the storage service about your bucket (it needs permission to
list the bucket, so a key that can only read and write files may get a warning here although uploads
work), and for protected links it runs the sign-in check described below.

## Local (the default)

Nothing to set up. The video, poster, captions and a watch page are copied to the `publish` folder of
the run, or to `publish.localDir` if you set it. Nothing leaves your machine, and no one else can
open the files.

## Cloudflare R2 with private links

Private links need no domain. They are signed links on the R2 storage address, and they expire.

1. In the Cloudflare dashboard, create an R2 bucket.
2. Create an R2 API token that is limited to this one bucket and can read and write objects. Copy
   the access key ID and the secret access key that Cloudflare shows you.
3. Find your account ID. The storage address is `https://<account-id>.r2.cloudflarestorage.com`.
   For a bucket with a jurisdiction, use the address that has it in its name, for example
   `https://<account-id>.eu.r2.cloudflarestorage.com`.
4. Set:

   ```bash
   export MERGESTORY_PUBLISH_PROVIDER=s3
   export MERGESTORY_S3_BUCKET=<bucket>
   export MERGESTORY_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   export MERGESTORY_S3_REGION=auto
   export MERGESTORY_S3_ACCESS_KEY_ID=<access key id>
   export MERGESTORY_S3_SECRET_ACCESS_KEY=<secret access key>
   ```

Things to know:

- Signed links only work on the storage address (`r2.cloudflarestorage.com`). They do not work on a
  custom domain.
- R2 allows 1 second to 7 days. MergeStory allows 60 seconds to 7 days, and uses 7 days unless you
  set `publish.linkExpirySec`.
- An expired link answers 403. Treat a signed link like a password: anyone who has it can watch
  until it expires.
- Do not use the `r2.dev` address for sharing. Cloudflare says it is not meant for production use.

## Cloudflare R2 with your team's sign-in (protected links)

Use this when your team should watch the videos and the links should not expire. People open a
link on your own domain, sign in with your identity provider, and watch. The order of the steps
matters.

1. **What you need.** The domain must be a zone in the same Cloudflare account as the bucket. Cloudflare
   Access needs an identity provider: a service such as Google or GitHub sign-in, or Cloudflare's
   own one-time PIN login.

2. **Create the Access application first, before you connect the domain.** If you connect the
   domain first, the bucket is public on that domain until the application exists.
   In the dashboard: Zero Trust, Access controls, Applications, Create new application,
   Self-hosted and private, then add a public hostname such as `videos.example.com`.
   Add a policy with the action Allow. Applications deny everyone who does not match an Allow
   policy. A common rule is Include, Emails ending in `@example.com`. You can also include an
   identity provider group, if your provider sends groups.

3. **Connect the custom domain to the bucket.** In the dashboard: R2 object storage, your bucket,
   Settings, Custom Domains, Add. Enter the same hostname, review the DNS record and connect it.
   The status goes from Initializing to Active within minutes. On the command line:

   ```bash
   npx wrangler r2 bucket domain add <bucket> --domain videos.example.com --zone-id <zone-id>
   ```

4. **Turn off the r2.dev address.** If you leave it on, the bucket stays public there. Access, the
   cache, the web application firewall and bot protection do not work on `r2.dev` at all. In the
   dashboard: bucket Settings, Public Development URL, Disable. Or:

   ```bash
   npx wrangler r2 bucket dev-url disable <bucket>
   ```

5. **Test it.** Open `https://videos.example.com/anything` in a browser. You should see the sign-in page.
   After you sign in with an account that matches your policy, files open. If you see a block page
   after signing in, no Allow policy matches your email or group. From a terminal, a request with no
   login gets a redirect:

   ```bash
   curl -sI https://videos.example.com/anything
   ```

   The answer should be `302`, with a `location` header on `cloudflareaccess.com`. (If you turned on
   managed OAuth for the application, it is a `401` with a `www-authenticate` header instead.)

6. **Tell MergeStory.** The storage settings are the same as for private links. Add the visibility
   and your domain:

   ```bash
   export MERGESTORY_VISIBILITY=protected
   export MERGESTORY_S3_PUBLIC_BASE_URL=https://videos.example.com
   ```

   Then check everything, including the sign-in:

   ```bash
   mergestory doctor --online
   ```

Uploads do not go through your domain. They use the storage address and your R2 token, so Access
never sees them.

### How MergeStory checks the sign-in

Before it uploads anything for a protected link, MergeStory sends one anonymous request to your
domain. The request asks for a file that does not exist, in the same folder where the videos will go.
It sends no cookies and no credentials and waits at most 10 seconds. It follows a redirect only
inside the same host (such as http to https), never to another host. It is a point-in-time check of
the address you gave it.

| What the address answers | Verdict |
|---|---|
| A redirect to a sign-in page (Cloudflare Access, Google, Microsoft Entra, Okta, Auth0, GitHub login, or another sign-in or OAuth address) | protected |
| 401 with a sign-in challenge (`WWW-Authenticate`), including Cloudflare Access with managed OAuth | protected |
| 403 with a sign-in page, a Cloudflare Access page, or a signed-link message from CloudFront | protected |
| 200, or a plain 404 for the missing file | not protected: the upload is blocked |
| Anything else: a bare 401 or 403, CloudFront's usual 403 for missing files, a bot check, a server error, a redirect elsewhere, no answer | unknown: the upload is blocked |

When the upload is blocked, the error says what the address answered, and how to fix it. Nothing
has been uploaded at that point.

What the check cannot do:

- It proves that there is a sign-in step. It cannot see who is allowed in. Read your Access policy
  to be sure that it names the right people.
- It cannot see that the same bucket is also reachable on another address, such as `r2.dev` or a
  second custom domain. Turn those off, as in step 4.
- A domain that only works on a VPN, or that this machine cannot reach, cannot be checked. If you
  are sure that the domain needs a sign-in, set `publish.s3.verifyProtection` to `false`
  (`MERGESTORY_S3_VERIFY_PROTECTION=false`). `mergestory doctor` then warns you every time, because
  the safety check is off.

### What your team sees

- The comment on the pull request says "The link needs a team sign-in." It has no preview image,
  because GitHub cannot sign in to load one.
- MergeStory marks the files as private for shared caches, so a cache in front of the bucket does not
  keep a copy.
- People who are not in your Access policy cannot sign in. For a one-off share with someone outside,
  use a private link instead. Signed links are what Cloudflare suggests for anonymous recipients.

## Amazon S3

Private links need only a bucket and a key.

```bash
export MERGESTORY_PUBLISH_PROVIDER=s3
export MERGESTORY_S3_BUCKET=<bucket>
export MERGESTORY_S3_REGION=<region>
```

Leave the endpoint empty. Use the keys `MERGESTORY_S3_ACCESS_KEY_ID` and
`MERGESTORY_S3_SECRET_ACCESS_KEY`, or the usual AWS ways: the `AWS_*` variables, a profile, single
sign-on or a role.

- The key needs permission to write objects (`s3:PutObject`) and read them (`s3:GetObject`) in the
  bucket. Signed links do not need the bucket to be public. Keep "Block Public Access" on.
- A signed link is valid for at most 7 days. With temporary credentials, such as a role session, it
  cannot outlive the credentials. MergeStory shortens the link and warns you.
- MergeStory never sets an ACL. New buckets have ACLs turned off, so a request that sets one fails.

For permanent public links, put a CloudFront distribution in front of the bucket and set the
public base URL to its address:

```bash
export MERGESTORY_VISIBILITY=public
export MERGESTORY_S3_PUBLIC_BASE_URL=https://<your distribution or domain>
```

A bucket policy that allows `s3:GetObject` for a folder also works, but you must switch off parts of
Block Public Access for that bucket. For private repositories, public links stay blocked unless you
set `publish.allowPublicForPrivateRepos`.

For protected links on AWS, you need a real sign-in step in front of the distribution. A typical
CloudFront and S3 setup answers 403 for a missing file, also when the files are public, so
MergeStory cannot tell it from a protected one and reports "unknown".

## Self-hosted S3 servers

MergeStory works with S3-compatible servers you run yourself, such as Garage or SeaweedFS.

```bash
export MERGESTORY_PUBLISH_PROVIDER=s3
export MERGESTORY_S3_BUCKET=<bucket>
export MERGESTORY_S3_ENDPOINT=http://<host>:<port>
export MERGESTORY_S3_REGION=us-east-1
export MERGESTORY_S3_FORCE_PATH_STYLE=true
export MERGESTORY_S3_ACCESS_KEY_ID=<access key id>
export MERGESTORY_S3_SECRET_ACCESS_KEY=<secret access key>
```

- Use path-style addresses (`forcePathStyle`). Most self-hosted servers expect them.
- Use `us-east-1` as the region unless your server needs another name.
- Signed links work if your server supports signed (presigned) links. If viewers cannot reach the
  server directly, put a reverse proxy with a sign-in in front of it and use protected links.
- **Check MinIO before you choose it.** As of 2026-11-03 the `minio/minio` repository is archived on GitHub,
  and a 2026 security advisory (CVE-2026-40344) describes an authentication bypass in its upload
  handling. Check the project status before you pick it. SeaweedFS, RustFS and VersityGW were still
  maintained at that date.

## Backblaze B2

```bash
export MERGESTORY_PUBLISH_PROVIDER=s3
export MERGESTORY_S3_BUCKET=<bucket>
export MERGESTORY_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
export MERGESTORY_S3_ACCESS_KEY_ID=<application key id>
export MERGESTORY_S3_SECRET_ACCESS_KEY=<application key>
```

- The endpoint is on the bucket's details page, for example `https://s3.us-west-004.backblazeb2.com`.
  B2 needs the region that is in that address. If you leave the region on `auto`, MergeStory takes it
  from the address.
- Use an application key. B2 does not accept the master key on its S3 API.
- B2 accepts HTTPS only.
- Signed links work too. B2 does not state a longest lifetime, and MergeStory never asks for more than
  7 days.
- A public bucket gives permanent links. With visibility `public`, set the public base URL to
  `https://f<NNN>.backblazeb2.com/file/<bucket>`. Copy the `f<NNN>` part from a file's details in
  the B2 console. To create a public bucket, B2 needs a verified email address and a payment
  history (or a small card fee) on your account.

## Google Cloud Storage

MergeStory uses the S3-compatible interface of Cloud Storage, with HMAC keys. HMAC keys are separate
from service account JSON keys.

1. Create an HMAC key for a service account. The command prints an access ID and a secret:

```bash
gcloud storage hmac create <service-account-email>
```

2. Set:

```bash
export MERGESTORY_PUBLISH_PROVIDER=s3
export MERGESTORY_S3_BUCKET=<bucket>
export MERGESTORY_S3_ENDPOINT=https://storage.googleapis.com
export MERGESTORY_S3_REGION=auto
export MERGESTORY_S3_FORCE_PATH_STYLE=true
export MERGESTORY_S3_ACCESS_KEY_ID=<hmac access id>
export MERGESTORY_S3_SECRET_ACCESS_KEY=<hmac secret>
```

- Use path-style addresses. The other style cannot be used with bucket names that contain dots.
- A new HMAC key can take up to 60 seconds to start working.
- Signed links last up to 7 days.
- For permanent public links, give `allUsers` the role `roles/storage.objectViewer` on the bucket and
  use `https://storage.googleapis.com/<bucket>` as the public base URL. This fails when the bucket is
  under public access prevention, which is the right outcome for private data.
- An unfinished multipart upload and its parts stay in the bucket, and you pay for them as storage.
  Add a lifecycle rule that aborts stale uploads (see below).
- A policy of your organisation can block HMAC keys.

## YouTube

`--publish youtube` uploads the video to your own YouTube channel instead of a bucket. MergeStory
always sends the privacy setting, `publish.youtube.privacyStatus`. The default is `unlisted`: only
people with the link can watch. YouTube makes a video public when no setting is sent, so MergeStory
never leaves it out. You sign in once with `mergestory setup youtube` (it needs a browser), and
`mergestory doctor` tells you whether the sign-in is in place. The Google Cloud project and the
sign-in are explained in [youtube.md](youtube.md).

## What it costs

Storage for one video is tiny. A 2-minute video at 1080p is about 10 MB.

Cloudflare R2 charges $0.015 per GB-month of storage. The first 10 GB-month are free each month, and
R2 has no egress fees, so watching a video costs nothing extra.

| Videos you keep | Storage | R2 per month |
|---|---|---|
| 100 | about 1 GB | $0 (inside the free 10 GB-month) |
| 1,000 | about 10 GB | $0 (at the free limit) |
| 10,000 | about 100 GB | about $1.35 |

| Option | What you pay |
|---|---|
| Local | nothing |
| Cloudflare R2 | the table above. Cloudflare Access is a separate Cloudflare service: check its plan and price for the number of people who sign in. |
| Amazon S3, Backblaze B2, Google Cloud Storage | the price list of the provider. Some providers also charge for each GB that viewers download. |
| Self-hosted server | your own hardware and time |
| YouTube | no storage fee. The default quota allows 100 uploads per day for one Google Cloud project. |

MergeStory records storage as $0 in the cost report, because the provider bills you and not
MergeStory. Every run lists what was uploaded and to which host.

## Running in a container

The browser that draws the video starts with its sandbox on. It cannot do that as root, so when
MergeStory runs as root (the default in many container images), it starts the browser without the
sandbox. It logs that at debug level. This is a weaker setup. Run the container as a normal user when you can.

Some systems refuse the sandbox to a normal user too. Ubuntu 23.10 and later, for example, block the user
namespaces that a downloaded Chromium needs. MergeStory then starts the browser without the sandbox and prints a
warning. Google Chrome installed from its package can usually use the sandbox there: set
`MERGESTORY_BROWSER_PATH` to it.

## Delete old videos

Links expire, but the files stay in the bucket until you delete them. Deleting the files is the way to
make a permanent link stop working for good.

If an upload fails after some files were sent, MergeStory tries to delete those files again. That needs
permission to delete objects. When the deletion fails too, the error names the folder to check
(`<bucket>/<prefix>/v/<id>/`). Delete it yourself.

Every video is under `<prefix>/v/`, and the default prefix is `mergestory`. Add a lifecycle rule to your
bucket that deletes objects with the prefix `mergestory/` after, say, 30 days.

- Cloudflare R2, Amazon S3 and Google Cloud Storage all have lifecycle rules. Check whether your
  provider has them too.
- R2 stops unfinished multipart uploads on its own after 7 days. On Google Cloud Storage they stay
  until you add a rule.

## CORS

You do not need CORS in the normal case. The video, captions, poster and watch page share one
address and one folder, so the browser treats them as one site.

CORS matters only if you embed the video in another site, or serve the watch page from another
domain. A caption file on another domain needs `crossorigin="anonymous"` on the video and an
`Access-Control-Allow-Origin` header on both the captions and the video. A minimal rule for a player on
`https://player.example`, in the format of the S3 `PutBucketCors` call (R2 and B2 accept the same
shape):

```json
[
  {
    "AllowedOrigins": ["https://player.example"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

On an R2 custom domain, change the rule and then purge the cache for that hostname. R2 returns the
CORS headers only for requests that carry an `Origin` header.

## Problems and fixes

| What you see | Why | Fix |
|---|---|---|
| "Protected links are blocked: ... is not behind a sign-in" | The address answered 200 or 404 to an anonymous request | Create the Access application, as in step 2 above. Or use `--visibility private`. |
| "... could not confirm that ... needs a sign-in" | The answer proves nothing, for example a 403 from CloudFront, a redirect elsewhere, or no answer | Read what it saw in the hint. Check the domain and the policy. For a domain this machine cannot reach, set `MERGESTORY_S3_VERIFY_PROTECTION=false`. |
| The same error with an `r2.dev` address | Access does not work on `r2.dev` | Connect a custom domain to the bucket. |
| The same error with the storage address (`r2.cloudflarestorage.com`) | No access proxy sits in front of the storage API | Use your custom domain as the public base URL. |
| "Protected links need a public base URL" | `publish.s3.publicBaseUrl` is not set | Set `MERGESTORY_S3_PUBLIC_BASE_URL` to your domain. |
| "the storage service rejected the credentials" | Wrong key or secret, or a wrong region | Check both. On B2 and AWS the region must match the bucket. |
| "access to the bucket was denied" | The key cannot write or read objects | Give it write and read permission on the bucket. |
| "the bucket is in a different region or at a different endpoint" | Region or endpoint does not match the bucket | Set `MERGESTORY_S3_REGION` and `MERGESTORY_S3_ENDPOINT`. |
| A signed link answers 403 later | It expired, or it was opened on a custom domain (R2) | Publish again, or use the storage address for signed links. |
| "This machine does not allow the browser sandbox" | The system blocks the sandbox for this browser | Use Google Chrome installed from its package (`MERGESTORY_BROWSER_PATH`). See [Running in a container](#running-in-a-container). |
| `mergestory doctor --online` warns about the bucket check (HTTP 403) | The key may only allow reading and writing files, and the check needs permission to list the bucket | If uploads work, you can ignore it. |

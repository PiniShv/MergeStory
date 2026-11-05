# 4. Free and private by default

Status: accepted

## Context

A video for every pull request only works if each one costs almost nothing, and if teams can trust
the tool with private code.

## Decision

- No remote LLM by default. The storyboard comes from the calling agent or the offline generator.
  A remote LLM is used only when selected, starting with the cheapest capable model.
- `tts: auto` only picks free local voices (Kokoro, macOS `say`), or captions only.
- Publishing is local by default. S3-compatible upload is opt-in; links are presigned and expire;
  object keys contain only a random token; public links for private repositories need an opt-in.
- A per-run budget (default $0.25) is checked before every paid call.
- Every run reports its cost and every outbound transfer (host, purpose, size, content kind).
- Sensitive files are never shown or sent; secrets and e-mail addresses are masked everywhere.
- The heavy local voice (Kokoro) is an optional plugin, not a dependency, to keep installs small
  and the dependency tree short.

## Consequences

- The first run needs no account and no key.
- Teams that want an LLM-written storyboard or a cloud voice opt in with one setting.

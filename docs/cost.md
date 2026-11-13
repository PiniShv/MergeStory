# What MergeStory costs

**$0 per video from MergeStory.** By default MergeStory calls no paid service. Other things can still cost you
money: see [What can still cost money](#what-can-still-cost-money).

▶ [Watch the 70-second film on what it costs.](https://www.youtube.com/watch?v=6X5-zCe8PbU) It shows the default
settings.

## Step by step

| Step | Default | Cost |
|---|---|---|
| Storyboard (the script) | Written by the coding agent you already use, from MergeStory's evidence pack. Without an agent, built offline from the analysis. | No MergeStory charge. Your agent reads the evidence pack and writes the script: extra usage, billed by its provider if you pay per token. |
| Voice | Kokoro, an open neural voice for English with 82 million parameters. It runs on your own CPU. Installed once: about 400 MB, then the voice model. Other languages use macOS `say` or captions only. | No fee. Uses your machine's time, power and disk. |
| Rendering | Your own browser draws each frame from a JSON plan. FFmpeg encodes. Same input, same video. | No fee. Uses your machine, or your CI minutes in CI. |
| Checks | Every claim and line reference is checked on your machine before rendering. | $0 |
| Sharing | Local by default. YouTube or Google Drive on your own account. Or object storage. | Local: nothing. YouTube: no storage fee. Drive: your storage quota. R2 and S3: billed by the provider for storage and requests, and S3 also for data transfer out. See [hosting.md](hosting.md#what-it-costs). |

## Why it is so cheap

**The agent already knows the change.** The expensive part of a video is understanding the change. The coding
agent that made or reviews the change already understands it, so it writes the storyboard. No second model
reads the whole change again. Writing the storyboard is still extra usage in your session: the agent reads
MergeStory's instructions and evidence pack, often more than 10,000 tokens. If you pay for your agent per
token, its provider bills that usage, and it can cost more than an opt-in model. MergeStory adds no API call
of its own.

**Everything else is ordinary local software.** The voice is an open model on your CPU. The renderer is the
browser you already have. FFmpeg encodes the video. There is no render farm, no cloud GPU, no account and
no key for your first video.

**Checks run locally.** Grounding is plain code, not another model call. It confirms that every narration
line cites evidence and that every line reference points at real code in your repository.

**Paid services are opt-in.** Each one is a single setting, and the default is the cheapest capable model.

**Sharing can cost a little.** YouTube has no storage fee. Google Drive uses your storage quota. Object storage
bills storage and requests, and Amazon S3 also bills data transfer out. Keeping the video local costs nothing.

## When you want more

You can let a model write the storyboard, or use a cloud voice. Both are opt-in. These are the built-in
prices, checked 2026-11. They are estimates: providers change prices, and your provider's bill is the final word.

| Opt-in | Setting | Price |
|---|---|---|
| Storyboard by Claude Haiku 5.5 (the Anthropic default) | `--llm anthropic` | $0.10 per million input tokens, $0.50 per million output tokens |
| Storyboard by `gpt-6-luna` (the OpenAI default) | `--llm openai` | the same: $0.10 and $0.50 |
| OpenAI voice `gpt-4o-mini-tts` | `--tts openai` | $18 per million characters |
| ElevenLabs Flash | `--tts elevenlabs` | $40 per million characters |
| ElevenLabs v3 and Multilingual v2 | `--tts elevenlabs` with `MERGESTORY_TTS_MODEL` | $80 per million characters |

OpenAI plans to remove `gpt-4o-mini-tts` from its API on 2027-01-06. MergeStory warns about it from
December 2026.

### A worked example

Each call sends the instructions (about 4,000 tokens) and an evidence pack of at most `llm.maxInputTokens`
(default 24,000 tokens). The answer is at most `llm.maxOutputTokens` (default 12,000 tokens). One call at
these limits:

```
Claude Haiku 5.5:  28,000 x $0.10 / 1,000,000  = $0.0028
                   12,000 x $0.50 / 1,000,000  = $0.0060
                                         total = $0.0088
```

Under one cent. A smaller change sends and gets back less, so it costs less. When the checker finds a
problem, MergeStory asks the model once more to repair the storyboard (`llm.repairAttempts`, default 1). That
call also sends the first answer back, so it comes to about $0.010 at the limits. The worst case for the
script is about $0.02. The same limits on Claude Sonnet 5.5 ($2 and $10 per million) come to about $0.18 for
one call.

A 2-minute narration is roughly 1,600 characters:

```
OpenAI gpt-4o-mini-tts:  1,600 x $18 / 1,000,000 = $0.029
ElevenLabs Flash:        1,600 x $40 / 1,000,000 = $0.064
ElevenLabs v3:           1,600 x $80 / 1,000,000 = $0.128
```

So Haiku for the script and `gpt-4o-mini-tts` for the voice is about $0.05 for a 2-minute video at the
worst case, and usually less. A cached answer or clip costs nothing on the next run.

## The budget

A run may spend **$0.25** by default. MergeStory checks the budget before every paid call. If a call would
take the run over, it is not made. For the first model call or for speech, the run stops with
`BUDGET_EXCEEDED` (exit code 4). For a repair, the offline storyboard takes over and the run goes on.

| How | Setting |
|---|---|
| Flag | `--budget 0.25` |
| Environment variable | `MERGESTORY_BUDGET_USD` |
| Config file | `"budgetUsd": 0.25` (from 0 to 100) |

A flag wins over the variable, and the variable wins over the file. A model with no known price is counted at
the highest listed rate ($10 per million input tokens and $50 per million output tokens), so it is not counted
as cheap. See [Budget](configuration.md#budget) for every rule.

The budget is per run, not per day or month. It is a safeguard, not a guarantee of your final bill. It uses
estimates from list prices, and it covers only MergeStory's own model and voice calls. It does not cover
storage, CI minutes or your coding agent's usage. A model server or gateway on this machine or a private
network counts as $0, even when it forwards to a paid service. To cap your real bill, set a spending limit or
alert with each provider.

## See the cost

- **Before.** `mergestory generate . --dry-run` prints the plan with an estimated cost and what a real run
  would send. It renders and publishes nothing.
- **After.** Every run prints a `Cost` line: the total, a split between model and speech, whether it comes
  from list prices, and the budget. It also prints a `Sent` line with each outbound transfer (host, purpose,
  size), or says that nothing left the machine.
- **In the result.** `result.json` in the run folder holds the same `cost`: `totalUsd`, `budgetUsd` and one
  record per call, with its provider, model, tokens or characters, `costUsd` and `estimated`. Free and cached
  calls show a cost of 0.
- **Your own prices.** Providers change prices. Add a `pricing` section to the config file to replace or add
  one. See [Pricing overrides](configuration.md#pricing-overrides).

## What can still cost money

MergeStory itself charges nothing, and a default run calls no paid service. Other things can still cost
money. Their providers bill you, not MergeStory, and the `Cost` line does not include them.

- **Your coding agent.** It reads MergeStory's instructions and evidence pack (often more than 10,000
  tokens) and writes the storyboard in your session. If you pay for your agent per token, its provider bills that usage, and it can
  cost more than an opt-in model.
- **Models and voices you turn on.** `--llm anthropic` or `openai`, and `--tts openai` or `elevenlabs`, are
  billed to your own account by that provider. MergeStory counts them, but only as estimates.
- **Storage and delivery.** Amazon S3 bills storage, requests and data transfer out. Cloudflare R2 bills
  storage and operations above its free tier. Google Drive uses your storage quota. The cost report does
  not include storage.
- **CI minutes.** GitHub can bill Actions minutes for private repositories. See
  [GitHub Actions](github-actions.md#what-it-costs).
- **Your machine.** Rendering and the voice use your CPU, power and network. The first English video
  downloads the voice once (about 400 MB, then the voice model).
- **A model server you run.** One on this machine or on a private network counts as 0, even when it forwards
  to a paid service, because MergeStory cannot see what you pay.

The prices on this page are estimates from list prices checked 2026-11. Providers change prices. Your
provider's bill is the final word. The [budget](#the-budget) is a safeguard, not a guarantee of your final bill.
To cap your real bill, set a spending limit or alert with each provider.

MergeStory is provided "as is", without warranties, and the license limits liability. See sections 7 and 8 of
the [Apache-2.0 license](../LICENSE).

## Related

- [Configuration](configuration.md)
- [Hosting your videos](hosting.md), [YouTube](youtube.md) and [Google Drive](drive.md)
- [Decision 4: cheap and private by default](decisions/0004-cheap-and-private-defaults.md)

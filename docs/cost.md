# What MergeStory costs

**$0 per video.** By default MergeStory calls no paid service at all.

▶ [Watch the 70-second film: $0. By design.](https://www.youtube.com/watch?v=6X5-zCe8PbU)

## Step by step

| Step | Default | Cost |
|---|---|---|
| Storyboard (the script) | Written by the coding agent you already use, from MergeStory's evidence pack. Without an agent, built offline from the analysis. | $0 extra |
| Voice | Kokoro, an open neural voice for English with 82 million parameters. It runs on your own CPU. Installed once: about 400 MB, then the voice model. Other languages use macOS `say` or captions only. | $0 |
| Rendering | Your own browser draws each frame from a JSON plan. FFmpeg encodes. Same input, same video. | $0 |
| Checks | Every claim and line reference is checked on your machine before rendering. | $0 |
| Sharing | Local by default. YouTube or Google Drive on your own account. Or object storage. | $0 on your own channel or Drive. A fraction of a cent per month on Cloudflare R2 or S3. |

## Why it is so cheap

**The agent already knows the change.** The expensive part of a video is understanding the change and
writing the story. The coding agent that made or reviews the change has already done that, so it writes
the storyboard. No second model reads the whole change again. The agent's own usage is part of the session
you already run. MergeStory adds no API bill on top.

**Everything else is ordinary local software.** The voice is an open model on your CPU. The renderer is the
browser you already have. FFmpeg encodes the video. There is no render farm, no cloud GPU, no account and
no key for your first video.

**Checks run locally.** Grounding is plain code, not another model call. It confirms that every narration
line cites evidence and that every line reference points at real code in your repository.

**Paid services are opt-in.** Each one is a single setting, and the default is the cheapest capable model.

**Sharing costs almost nothing.** Your own YouTube channel and your own Google Drive are free. Object storage
for a short video costs a fraction of a cent per month.

## When you want more

You can let a model write the storyboard, or use a cloud voice. Both are opt-in. These are the built-in
prices, checked 2026-11.

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
the highest listed rate ($10 per million input tokens and $50 per million output tokens), so the budget still
holds. See [Budget](configuration.md#budget) for every rule.

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

## What is not counted

- Your own machine's time and power. Rendering and the free voice use your CPU.
- Your coding agent's own usage. It is part of the session you already run.
- Storage. Your storage provider bills you for it, and MergeStory records it as 0.

## Related

- [Configuration](configuration.md)
- [Hosting your videos](hosting.md), [YouTube](youtube.md) and [Google Drive](drive.md)
- [Decision 4: free and private by default](decisions/0004-cheap-and-private-defaults.md)

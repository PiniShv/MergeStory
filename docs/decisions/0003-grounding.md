# 3. Every storyboard passes one grounding validator

Status: accepted

## Context

A wrong explanation is worse than none. Storyboards come from three sources (a coding agent, an
LLM, or the offline generator), and none of them can be trusted blindly.

## Decision

- The analyzer assigns an id to every citable fact (files, hunks, symbols, risks, PR text, task,
  notes, test results).
- Storyboards may not contain code. They point at line ranges, and the engine reads the real lines.
- One validator checks every storyboard: evidence ids exist, narration is cited, line ranges are
  valid and changed, simulated visuals are backed by evidence, and claims about tests or performance
  need supplied evidence. Many problems are fixed automatically; the rest are reported with paths.
- Simulated visuals are labelled on screen, and the watch page lists every claim with its sources.

## Consequences

- An agent or a model can still choose a weak story, but it cannot show code that does not exist
  or claim results nobody measured.
- The validator's error messages are part of the product: agents use them to fix storyboards.

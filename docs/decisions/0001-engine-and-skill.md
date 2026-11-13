# 1. The engine is the product; the skill is an adapter

Status: accepted

## Context

MergeStory must work for coding agents, CI pipelines, other tools and people at a terminal. Agents
change fast and each has its own conventions. Video logic tied to one agent would not survive.

## Decision

- All logic (analysis, storyboard, grounding, narration, rendering, publishing, GitHub) lives in
  the engine, `packages/engine`, exposed as a CLI, an HTTP API and a library.
- The Agent Skill, `plugins/mergestory/skills/mergestory`, only explains when and how to call the CLI, gathers what
  the agent knows (task, decisions, test results it actually ran), and reports the result.
- The skill follows the open Agent Skills format with only the six standard frontmatter keys, so
  one copy works across agents.
- The engine accepts a storyboard written by the caller (`--storyboard`). An agent can write it
  from the engine's evidence pack with no extra MergeStory call (its own usage still counts); the
  engine validates it like any other storyboard.

## Consequences

- The engine never depends on an agent or a model vendor.
- The skill can stay short and rarely changes; behaviour changes ship with the engine.
- Agents that write their own storyboard need no extra API key and send no code to a second model.

# Own usage collector

Status: built. Agent 0.5.0 ran it in shadow, agent 0.6.0 made it the only
usage collector, 2026-11-23. It replaced the previous third-party collector,
which the agent ran through `npx` and node. This file replaces the two-part
design doc used during the build. Git history has the full version.

## What it does

```
apps/agent/src/collectors/
  usage.ts            UsageCollector: runs each parser, dedupes, prices, groups
  pricing.ts          embedded price table, daily refresh from GET /v1/prices
  parsers/
    types.ts          UsageRecord: one request, counts and model only
    claude.ts         Claude Code transcripts
```

- `UsageCollector.collectRange(dates)` reads every parser's records from the
  day before the first date onward. It keeps the earliest copy of each
  request (key per agent), and that copy's UTC day decides where the request
  counts. Dedupe runs before the date filter. A streamed reply can write its
  lines on both sides of midnight; filtering first counted it on the later day
  when only that day was asked for (found on 2026-11-22, 211,255 tokens).
- Each request is priced on its own (`pricing.ts`), so the 200k tier and the
  5-minute / 1-hour cache-write split are right. A model with no price is sent
  with `unpriced: true`, never as free. `isFreeTier` comes only from
  `FREE_TIER_AGENTS`.
- Events group by `(UTC date, agent, model)` into the existing `UsageEvent`
  shape. `cacheCreateTokens` is 5m plus 1h writes.
- `CodeburnCollector` reads the same deduped Claude pass for enrichment, and
  per-project cost is the sum of priced requests per project.

## Claude Code parser

- Roots: `CLAUDE_CONFIG_DIR` (comma list, the folder or its `projects/`),
  else `~/.config/claude/projects` and `~/.claude/projects`.
- Records: `type === 'assistant'` lines with `message.usage`. Key is
  `message.id:requestId`, else `uuid`. `<synthetic>` models are skipped.
- Files last written before the window are skipped (transcripts are
  append-only). Bad lines are counted, never fatal.

## Other agents

Codex, Gemini CLI, Qwen and Copilot CLI have no parser yet, so laptops do not
collect them. `burnwatch status` prints "not collected" for each. Prod had no
laptop rows for any of them after 2026-07-10. Copilot still comes in at org
level through the Copilot integration. A new parser implements `AgentParser`
and is added to `PARSERS` in `usage.ts`, with a fixture built from a real
sample (key names and value types, never values).

## Cutover (agent 0.6.0)

- Days are UTC. The previous collector used the laptop's local day.
- The server keeps the first rows sent for a day. So an upgraded device
  stores `ownCollectorFrom` = the UTC day of its last sync, and never re-sends
  days before it. The previous collector had sent up to the day before that
  one. A new device has no cutover and backfills with `--days N`.
- For a non-UTC user, a few hours around the boundary day are counted twice or
  not at all, once (for IST, 5.5 hours).
- `referenceDiff` left the payload schema. 0.5.x agents still send it; the
  API strips it.
- `/devices` shows "Update agent" below 0.6.0 (`UPDATE_AGENT_VERSION`),
  separate from `AGENT_FIELDS_VERSION` (0.4.0).

## Parity before cutover

Run on this machine against the previous collector, 2026-11-23: every closed
UTC day it had (2026-11-17 to 2026-11-22) matched exactly on all four token
counts per model, and cost matched to the cent. The one shadow-mode mismatch
(2026-11-22, local day) was the dedupe order bug above, fixed in 0.6.0.

## Guard

CI fails if the previous collector's name appears anywhere in the repo.

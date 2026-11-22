# Own usage collector: design, part 1 of 2

Status: decisions locked 2026-11-23. Nothing built. Roadmap: `tasks/ROLLOUT-ROADMAP.md:43`
("Own usage collector", decided by the user 2026-11-22). Follows the style of
`tasks/R2-B5-AGENT-VERSIONS-DESIGN.md`.

Part 1: goal, what the third-party collector gives us today, what is on a real
machine, pricing.
Part 2 (`tasks/AGENT-OWN-COLLECTOR-DESIGN-PART2.md`): per-agent parsers, the
parity check, migration and rollout, the name cleanup, public-launch items,
tests, scope, size, open decisions, build order.

Naming rule for this doc: the third-party tool is named **ccusage** only where
the text must say what is being replaced. Everywhere else it is "the reference
collector". The new code is BurnWatch's own and is never named after it (see
Part 2, "Name cleanup"). This doc itself is reworded or deleted in the final
cleanup phase.

## Goal

The agent today gets token counts and cost by running
`npx ccusage@latest daily --json` (`apps/agent/src/collectors/ccusage.ts:143`).
That needs node and npx on the laptop, the network at run time, and whatever
version `@latest` resolves to that day. Replace it with a collector built into
the agent, so `burnwatch` is one self-contained binary we can give to
employees and to the public.

The end state:

- `apps/agent/src/collectors/usage.ts` exports `UsageCollector`, with one
  parser per agent under `collectors/parsers/` (`claude.ts`, `qwen.ts`,
  `gemini.ts`, `codex.ts`, `copilot.ts`).
- Prices come from a table embedded in the binary and refreshed from our API.
- No spawn, no node, no npx, no `npxPath` in config.
- `git grep -il ccusage` and `git ls-files | grep -i ccusage` both print
  nothing.

## What exists today

| Piece | Where | Today |
|---|---|---|
| Collector interface | `apps/agent/src/collectors/base.ts:3-6` | `UsageCollector { isAvailable(); collect(date) }`. The new collector implements it, plus `collectRange`. |
| Spawn | `collectors/ccusage.ts:28-64`, args at `:143` | `npx ccusage@latest daily --json --since YYYYMMDD --until YYYYMMDD`, 120 s timeout (`:144`). |
| PATH fix for launchd/systemd | `ccusage.ts:19-26` | Puts npx's own folder on PATH so `#!/usr/bin/env node` resolves. Goes away with the spawn. |
| Windows spawn | `ccusage.ts:30-37` | `shell: true` on win32 so `npx.cmd` resolves. Goes away. |
| Agent label map | `ccusage.ts:8-15` | `claude`, `qwen`, `gemini cli`/`gemini`, `codex`, `copilot`. Anything else (for example `antigravity`) is dropped. |
| "all" rows | `ccusage.ts:97-114` | Uses `metadata.agents` when it has one agent, else guesses from the first model name (`gpt` means codex, `:112`). |
| Event mapping | `ccusage.ts:66-95` | One `UsageEvent` per `modelBreakdowns` entry; `totalTokens` is the sum of the four counts (`:69-70`). With no breakdown, one row named after the first model or the agent (`:86`). |
| Free-tier flag | `ccusage.ts:17, 80, 93` | `isFreeTier = agent is qwen OR cost === 0`. A paid model with no price is therefore stored as "free". |
| Availability | `ccusage.ts:119-124` | True only if `~/.claude/projects` or `~/.qwen` exists. A Codex-only or Gemini-only machine reports "not available" and syncs nothing. |
| Range call | `ccusage.ts:170-193` | One spawn for the whole range, events bucketed by the tool's own `period`. |
| Shared types | `packages/shared/src/types.ts:4-31` | `CcusageOutput`, `CcusageModelBreakdown`, `CcusageDailyEntry`. |
| Event schema | `packages/shared/src/schemas.ts:16-27` | `UsageEventSchema`: agent, date, modelName, four token counts, totalTokens, `costUsd` ("API-equivalent cost"), `isFreeTier`. The `.describe()` text feeds `/privacy`. |
| Free-tier list | `schemas.ts:5-10` | `FREE_TIER_AGENTS = {qwen}`, a mirror of `ccusage.ts:17`. |
| Config | `types.ts:109`, `commands/register.ts:19-27, 54, 114` | `npxPath` found with `which`/`where` at register and stored. |
| Sync wiring | `commands/sync.ts:85-126` | Builds both collectors, runs the reference collector first, then passes its per-day Claude cost to codeburn. |
| Status | `commands/status.ts:14, 23` | Prints `ccusage:   available`. |
| Server write | `packages/db/src/usage.ts:41, 52-54` | Key `{userId, date, agent, modelName, deviceId, source}`. For `source: 'agent'` it is `$setOnInsert`: **first write wins**, a re-sync never changes a stored row. |
| Snapshot | `packages/db/src/snapshot.ts:33-52` | Per agent, agent-sourced rows beat the Copilot org pull. |
| Ingest | `apps/api/src/routes/usage/submit.ts:84-90, 108, 127` | Upsert events, rebuild the day's snapshot, store `agentVersion`. |

### How sync uses the reference cost

`sync.ts:7-11` sums the Claude `costUsd` per day. `sync.ts:109-113` passes it
to `CodeburnCollector.collectRange`, which splits it across projects and
branches by each project's share of the day's tokens
(`codeburn.ts:169-175, 306-312`). The comment at `codeburn.ts:309-311` already
notes that a flat token weight overcharges projects on cheaper models.

### What codeburn already parses

`collectors/codeburn.ts` already reads every Claude Code JSONL file under
`~/.claude/projects`, recursing into subfolders (`:13-25`), and for each
assistant line (`:218`) takes:

- the four token counts off `message.usage` (`:224-232`)
- `version` (`:237`), `entrypoint`, `attributionSkill`, `isSidechain` (`:240`)
- `cwd` mapped to a repo root and remote (`:242-262`), `gitBranch` (`:264`)
- tool, shell and MCP use from `message.content` (`:276-291`)
- the day from `timestamp.slice(0, 10)`, which is the **UTC** date (`:208-210`)

It does **not** read `message.model` and does **not** dedupe. Each streamed
response is written to the transcript several times with the same
`message.id` and `requestId`, and codeburn counts every copy. On this machine
that is 9,971 assistant lines for 4,773 distinct requests, so `callCount`,
token totals and the per-project token weights it computes are about 2x real
(see "What is on this machine"). Shares come out roughly right because every
project is inflated alike, but `callCount` and `cacheHitRate` inputs are not.

The new Claude parser does one deduped pass and feeds both the usage events
and the enrichment. That fixes codeburn's counts as a side effect.

## What the reference collector reads

Source: the cached package `~/.npm/_npx/<hash>/node_modules/ccusage`, version
**20.0.51**. It is now a 4.5 MB native binary behind an npm wrapper
(`@ccusage/ccusage-<platform>` optional dependencies). Paths below come from
its README and from the strings in that binary. They are what to verify, not a
spec.

| Agent | Our name | Location | Format |
|---|---|---|---|
| Claude Code | `claude` | `$CLAUDE_CONFIG_DIR` (comma list), else `~/.config/claude/projects` and `~/.claude/projects` | JSONL, one line per transcript entry. Usage on `message.usage`. |
| Codex | `codex` | `$CODEX_HOME`, else `~/.codex`, folders `sessions/` and `archived_sessions/` | JSONL session logs with token-count events; some files compressed (`.zst` appears in the binary). |
| Gemini CLI | `gemini` | `$GEMINI_DATA_DIR`, else `~/.gemini/tmp/...` | Session JSON with `messages` and per-message `tokens` {`prompt`/`input`, `candidates`/`output`, `cached`, `thoughts`, `tool`, `total`}. |
| Qwen Code | `qwen` | `$QWEN_DATA_DIR`, else `~/.qwen/.../chats/*.jsonl` | JSONL, assistant lines with Gemini-style `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`, `totalTokenCount`). |
| Copilot CLI | `copilot` | `${COPILOT_HOME:-~/.copilot}/session-state/<session-id>/events.jsonl`, or an OpenTelemetry file export (`COPILOT_OTEL_FILE_EXPORTER_PATH`) | JSONL events; OTel attributes `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, `reasoning.output_tokens`, `gen_ai.response.model`. |

It also reads 14 other tools (OpenCode, Amp, Antigravity, ...). Our label map
drops them (`ccusage.ts:8-15`), so they never reached BurnWatch.

Its Claude handling, from the binary: dedupe on message id plus request id;
reads `isSidechain`, `isApiErrorMessage`, `cache_creation.ephemeral_5m_input_tokens`
and `ephemeral_1h_input_tokens`, `usage.iterations`, and skips `<synthetic>`
model lines.

**Date bucketing:** its `timezone` option defaults to the system zone. We do
not pass one (`ccusage.ts:143`), so it buckets by the laptop's local day,
while codeburn and the server use UTC days. On this machine (IST, +05:30):

| Day | Local buckets: tokens / cost | UTC buckets: tokens / cost |
|---|---|---|
| 2026-11-17 | 104.1M / $46.21 | 152.2M / $68.83 |
| 2026-11-19 | 166.2M / $63.99 | 175.8M / $65.37 |
| 2026-11-22 | 133.2M / $57.53 | 87.7M / $39.47 |

So today the usage rows and the enrichment for "the same day" cover different
24-hour windows for anyone not on UTC, and the per-project cost split mixes
them. The new collector uses UTC for both (Part 2, Decision 3).

## What is on this machine

Checked 2026-11-23. Paths and shapes only.

| Agent | Path | Present | Shape |
|---|---|---|---|
| Claude Code | `~/.claude/projects` | Yes. 229 JSONL files (36 under `<session>/subagents/`), 188 MB, oldest file 2026-11-17. | See below. |
| Claude Code alt | `~/.config/claude/projects` | No | |
| Qwen | `~/.qwen` | No | |
| Gemini CLI | `~/.gemini/tmp` | No. `~/.gemini` holds only Antigravity data (`antigravity/conversations/*.pb`, protobuf) and config. | Not a Gemini CLI log. |
| Codex | `~/.codex` | No | |
| Copilot CLI | `~/.copilot` | Only `mcp-config.json`; no `session-state/`. | |

So only the Claude parser can be checked against real data here. The other
four need samples from other machines (Part 2, Decision 4).

Claude transcript shape on this machine:

- Entry types: `assistant`, `user`, `system`, `attachment`, `session-owner`,
  `api-request*`, `cost-state`, `permission-mode` and about 15 more. Only
  `assistant` carries usage.
- Every assistant line has `message.id`, `requestId`, `timestamp` (ISO, `Z`),
  `message.model`, `message.usage`.
- `message.usage` keys: `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `service_tier` (all `standard`), `speed` (all `standard`), `iterations`,
  `server_tool_use`, `inference_geo`.
- 7,775 of 9,973 assistant lines have 1-hour cache writes. These are priced
  differently from 5-minute writes, so the split matters for cost.
- Duplicates: 3,430 `(message.id, requestId)` groups repeat, all with
  identical usage, never split across the main and subagent files.
- 2,191 assistant lines are sidechain (subagent) lines, all in the
  `subagents/` files.
- Models: `claude-opus-5-5`, `claude-haiku-5-5`, `claude-sonnet-5-5`,
  `claude-fable-5-2`.

### Parity spike (done for this doc)

A 30-line script did "dedupe on `(message.id, requestId)`, bucket by UTC
`timestamp[:10]`, sum the four counts" and was compared with the reference
collector run with `--offline -z Etc/UTC`:

| UTC day | Reference tokens | Spike tokens | Raw, no dedupe (codeburn today) |
|---|---|---|---|
| 2026-11-17 | 152,246,194 | 152,246,194 | 334,843,619 |
| 2026-11-18 | 128,283,812 | 128,283,812 | 247,371,591 |
| 2026-11-19 | 175,829,743 | 175,829,743 | 373,326,697 |
| 2026-11-20 | 104,800,867 | 104,800,867 | 217,140,646 |
| 2026-11-21 | 95,385,270 | 95,385,270 | 192,094,915 |
| 2026-11-22 | 87,692,876 | 87,824,659 | 205,595,423 |

Exact on every closed day. 2026-11-22 UTC was still open while this ran
(transcripts written between the two runs), so it differs by 131,783 tokens.
Per-model splits match the reference `modelBreakdowns` too. Tokens for Claude
are a solved problem; cost is not (next section).

## Pricing

### Where the reference collector gets cost

From the binary and README (`README.md:181, 229-237` in the package):

- A LiteLLM price file (`model_prices_and_context_window.json`) is **embedded
  at build time**, pinned to a LiteLLM commit, refreshed by a scheduled
  workflow in that project.
- At run time it **fetches the current LiteLLM file** ("Refreshing model
  pricing from LiteLLM...") unless `--offline` is passed, and falls back to the
  embedded copy on failure. It can also read models.dev pricing.
- Price fields it reads per model: input, output, cache creation, cache read,
  each with an "above 200k tokens" variant, plus `fastMultiplier` and
  `flexMultiplier`.
- A model with no price is excluded from cost and a warning is printed. In
  JSON that reaches us as `cost: 0`, which `ccusage.ts:80, 93` turns into
  `isFreeTier: true`. So "we don't know the price" is stored as "free" today.

We call it without `--offline`, so every sync makes a network call to GitHub
for prices, and old and new agents price the same day the same way only by
accident of timing.

### What the spike could not reproduce

Opus 5.5 per-day cost from the reference collector, checked against the token
components (input, output, 5-minute writes, 1-hour writes, reads) under fixed
price ratios (output 5x input, 5-minute write 1.25x, 1-hour write 2x or 1.25x,
read 0.1x), gives an implied input price that moves between $2.62 and $3.09
per million tokens from day to day. A fixed table would give one number. The
days with more tokens in requests over 200k prompt tokens are not
consistently the higher ones, so this is not explained by a simple 200k tier
either. Conclusion: we do not know the exact price function the reference
applies for this model. Build order step 2 reads the pinned LiteLLM entry and
the reference pricing code, and the parity check (Part 2) is the gate. No
prices are guessed in this doc.

### Our design

**Table.** `packages/shared/src/prices.json`, generated by
`scripts/update-prices.ts` from a pinned LiteLLM commit (MIT licence; keep the
attribution in the file header), filtered to models whose provider is one we
collect (Anthropic, OpenAI, Google, Qwen/Alibaba, plus the Copilot model ids).
Shape per model:

```ts
type ModelPrice = {
  input: number            // USD per token
  output: number
  cacheWrite5m: number     // Anthropic 5-minute cache write
  cacheWrite1h?: number    // Anthropic 1-hour cache write
  cacheRead: number
  above200k?: { input: number; output: number; cacheWrite5m?: number; cacheWrite1h?: number; cacheRead?: number }
}
type PriceTable = { version: string; source: string; models: Record<string, ModelPrice>; aliases: Record<string, string> }
```

`version` is the LiteLLM commit plus our date, for example
`2026-11-23+litellm.abc1234`. `aliases` maps dated or provider-prefixed names
(`claude-haiku-4-5-20251001`, `anthropic/claude-...`) to one key.

**Embedded.** Bun inlines the JSON import into the binary. A filtered table is
well under 100 KB.

**Refresh (Decision 1).** `GET /v1/prices` on our API serves the same file
from `packages/shared`, with `ETag` = `version`. The agent fetches it at most
once a day during sync, caches it at `~/.burnwatch/prices.json`, and uses the
newer of cache and embedded. If the fetch fails it uses what it has; a sync
never fails on prices. Updating prices is then a web release, not an agent
release, and old binaries pick it up.

**Cost per request, not per day.** Price each deduped request, then sum. This
is the only way to get the 200k tier and the 5m/1h split right, because both
are per request. For Claude:

```
prompt = input + cacheWrite5m + cacheWrite1h + cacheRead
p = (prompt > 200_000 && m.above200k) ? { ...m, ...m.above200k } : m
cost = input*p.input + output*p.output + w5*p.cacheWrite5m
     + w1*(p.cacheWrite1h ?? p.cacheWrite5m) + read*p.cacheRead
```

When `cache_creation` is missing (older transcripts), all of
`cache_creation_input_tokens` is a 5-minute write. Whether the 200k threshold
counts cache tokens must match the pinned LiteLLM convention; the parity check
settles it.

`speed` and `service_tier` are `standard` on every line here. Model a
multiplier only when a non-standard value shows up in real data; until then a
non-standard value is logged once per sync as "priced at standard rate".

**Other agents.** Gemini and Qwen `thoughts` tokens are billed as output, so
they go into `outputTokens`. `cached` tokens are cache reads. There are no
cache writes. Codex reasoning tokens are already inside output. Copilot CLI
usage is priced from the table as API-equivalent cost, the same meaning
`costUsd` has today (`schemas.ts:25`).

**Unknown models.** A model with no price (after alias lookup) is **unpriced**,
not free:

- `costUsd: 0` stays valid for the current schema.
- New optional field `unpriced: true` on the event (`UsageEventSchema`, with a
  `.describe()` for `/privacy`).
- `isFreeTier` means only "this agent is free" (`FREE_TIER_AGENTS`), never
  "cost was 0".
- Sync prints `Unpriced: <model> (<n> tokens)` once per model.
- Server: an unpriced row is left out of spend totals the way free-tier rows
  are, and the dashboard can show "n tokens on unpriced models". Server-side
  re-pricing of unpriced rows when the table catches up is out of scope
  (Decision 2).

**Caveats to state in the code and on `/privacy`:**

- Cost is API list price, not what a Max or Team seat pays.
- 1M-context and over-200k pricing apply only to models the table says have
  them, and only per request.
- Batch, priority, fast or regional pricing is not modelled until seen.

Continued in `tasks/AGENT-OWN-COLLECTOR-DESIGN-PART2.md`.

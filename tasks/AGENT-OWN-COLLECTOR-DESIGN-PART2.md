# Own usage collector: design, part 2 of 2

Status: decisions locked 2026-11-23. Part 1 (`tasks/AGENT-OWN-COLLECTOR-DESIGN-PART1.md`)
covers the goal, what the third-party collector (ccusage) gives us today, what
is on a real machine, and pricing. In this part it is "the reference
collector", except in the name-cleanup inventory, which has to list the word.

## Shape of the new code

```
apps/agent/src/collectors/
  usage.ts            UsageCollector: finds parsers, runs them, prices, buckets
  pricing.ts          load embedded + cached table, price one request
  parsers/
    types.ts          UsageRecord (one deduped request)
    claude.ts         also yields the fields codeburn needs
    qwen.ts  gemini.ts  codex.ts  copilot.ts
```

```ts
type UsageRecord = {
  agent: AgentName
  model: string
  at: string                    // ISO timestamp, UTC
  input: number; output: number
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number
  key: string                   // dedupe key, per agent
}
interface AgentParser {
  agent: AgentName
  roots(): string[]                         // env var first, then defaults
  read(roots: string[], since: string, until: string): AsyncIterable<UsageRecord>
}
```

`UsageCollector.collectRange(dates)` runs every parser whose roots exist,
drops records outside the UTC dates, dedupes on `key`, prices each record,
then groups by `(date, agent, model)` into today's `UsageEvent` shape
(`schemas.ts:16-27`). `cacheCreateTokens` = 5m + 1h writes, so the payload
and server are unchanged apart from the optional `unpriced` flag.

Claude: `claude.ts` is the one transcript reader. `CodeburnCollector` stops
walking files itself and takes the parser's deduped assistant entries, so the
50 MB guard (`codeburn.ts:11`), repo lookup and tool counts stay where they
are, and the per-project cost becomes the sum of priced requests per project
instead of a token-share split (`codeburn.ts:306-312`). `sync.ts:7-11` and
the `claudeCostByDate` argument are deleted.

## Per-agent parsers

### Rules for all

- **Dates are UTC.** A record's date is `at.slice(0, 10)` of an ISO UTC
  timestamp. Same as codeburn (`codeburn.ts:208-210`) and the server's
  `YYYY-MM-DD` keys. Timestamps without a zone are read as UTC and counted
  in the sync summary. (Decision 3.)
- **File pre-filter.** Skip files whose mtime is before the first requested
  date. A file is only appended to, so an old mtime means nothing new.
- **Streaming.** Read line by line (`readline`, as codeburn does). Bad lines
  are skipped and counted, never fatal.
- **No content leaves the machine.** Parsers return counts and model names
  only. No prompt text, no file paths.
- **Env overrides.** Honour the same env vars the reference collector does
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_DATA_DIR`, `QWEN_DATA_DIR`,
  `COPILOT_HOME`) so a user's custom location keeps working.

### Claude Code (verified on this machine)

- Roots: each entry of `CLAUDE_CONFIG_DIR` (comma list; accept the folder or
  its `projects/`), else `~/.config/claude/projects` and `~/.claude/projects`.
  Today's agent only looks at `~/.claude/projects` (`ccusage.ts:121`,
  `codeburn.ts:153`), so XDG installs gain data.
- Records: `type === 'assistant'` with `message.usage`.
- **Dedupe:** key `message.id + ':' + requestId`. Keep the first line seen.
  Duplicates here carry identical usage (Part 1), so first or last gives the
  same total. A line missing either id is kept, keyed by `uuid`.
- Skip `message.model === '<synthetic>'` (local error and limit notices; no
  API call). `limitNotice` (`codeburn.ts:78-83`) still reads them for the
  enrichment.
- **Sidechains/subagents:** subagent transcripts are separate files under
  `<session>/subagents/` with `isSidechain: true`. They are real API calls and
  count. They never share a key with the main file (checked), and dedupe
  covers it if a future version replays them. Counted once, as the reference
  does.
- Cache writes: `cache_creation.ephemeral_5m_input_tokens` and `_1h_`; when
  absent, all of `cache_creation_input_tokens` is 5m.

### Qwen, Gemini CLI, Codex, Copilot CLI (not verifiable here)

None has local data on this machine (Part 1). Formats in the table in Part 1
come from the reference collector's README and binary, not from files we
have seen. For each:

1. Get a real sample from a volunteer machine: run
   `burnwatch compare --dump-shape <agent>` (Build order step 7), which prints
   key names, counts and value types, never values.
2. Write the parser and a fixture built from that shape.
3. Pass parity on that machine.

Known points to handle:

- **Qwen**: `usageMetadata` per assistant line; `promptTokenCount` includes
  cached tokens, so `input = prompt - cached`; `thoughtsTokenCount` goes into
  output. Free tier (`FREE_TIER_AGENTS`), so cost is 0 by rule, not unpriced.
- **Gemini CLI**: one JSON file per session that is rewritten, not appended.
  Dedupe on session id plus message id; same input/cached/thoughts split as
  Qwen. Antigravity data under `~/.gemini/antigravity` is a different product
  in protobuf; not read (it is not read today either, `ccusage.ts:8-15`).
- **Codex**: token-count events can be cumulative per session. Take the delta
  between consecutive events, not each event's total. Read `archived_sessions`
  too. If `.zst` files are real, Bun has no zstd in the standard library;
  skip them with a count until a sample shows they matter.
- **Copilot CLI**: `session-state/<id>/events.jsonl`. The OTel file export is
  opt-in and rare; skip it. Copilot usage is also pulled at org level
  (`source: 'copilot-org'`), and `snapshot.ts:33-52` lets agent rows win, so a
  wrong local parser would replace correct org numbers. Ship Copilot last.

**Recommendation (Decision 4):** cut over per agent. Each agent switches to
our parser when it passes parity on at least one real machine. Until then,
during phases 1 and 2 only, that agent's rows still come from the reference
collector. At the cleanup phase, any agent still unverified is **dropped**
(reported as "not collected" by `status`), not kept behind npx, because the
end state has no reference collector at all.

## Parity check

Temporary. Deleted in the cleanup phase.

**Command:** `burnwatch compare --days N [--agent a]`, file
`apps/agent/src/commands/compare.ts`, with the reference collector moved to
`apps/agent/src/collectors/reference.ts` (class `ReferenceCollector`) in
phase 1 so no new code carries the old name. `compare` passes
`--timezone UTC` (and `--offline` to take network timing out) to the
reference, so both sides bucket the same days.

Output, one row per `(date, agent, model)` plus a total per agent:

```
date        agent   model             tokens ref / own      cost ref / own     diff
2026-11-20  claude  claude-opus-5-5   104,532,594 / same    $46.70 / $46.71    +0.02%
```

Exit code 1 when any row is over threshold, so it can run in CI against
fixtures and by hand on volunteer machines.

**Acceptance for cutover of an agent:**

- Tokens: **exact** per `(date, agent, model)` on every closed day in the
  window. The Claude spike already meets this (Part 1).
- Cost: within **0.5% per agent per day**, and within **$0.01** on any day
  under $2. A gap above that needs a written cause (for example "reference
  prices 1h writes as 5m") before cutover, and the cause is decided in our
  favour only if it matches the provider's published pricing.
- Window: 14 closed days, or all days the machine has if fewer, on at least
  one machine per agent, plus Windows for Claude.
- Unpriced: zero unpriced tokens for models the reference prices.

## Migration and rollout

### Phase 0: groundwork, no behaviour change (web release)

- `packages/shared/src/prices.json`, `scripts/update-prices.ts`,
  `GET /v1/prices`.
- Optional `unpriced` on `UsageEventSchema`, with `.describe()`.
- Rename the reference collector to `reference.ts` / `ReferenceCollector`;
  the shared `Ccusage*` types move into `reference.ts` as private types
  (`RefDailyEntry` etc.), since only that file uses them.

### Phase 1: shadow, agent **0.5.0**

- New `UsageCollector` runs on every sync next to the reference collector.
- The reference still writes. Our numbers are computed and compared, not
  sent.
- Sync prints one line per day when they differ over threshold, and keeps the
  last diff in config (`lastCompare`), shown by `status`.
- Optional (Decision 5): send a small `referenceDiff` summary (per agent:
  tokens and cost from both) on the payload, so we see parity from every
  device without asking people to run `compare`.
- Codeburn switches to the deduped Claude pass in this release. Its
  `callCount` drops by about half; changelog says so.

### Phase 2: cutover, agent **0.6.0**

- Our collector writes events. The reference runs only for agents not yet
  verified, and only if npx is found.
- Date bucketing moves from the laptop's local day to UTC.
- `register` no longer looks for npx. Setup page and INSTALL drop node.
- **History and the boundary (Decision 6).** The server is first-write-wins
  per `(user, device, date, agent, model)` (`usage.ts:52-54`). Re-sending old
  days from the new collector would add rows for model names or days that
  differ and leave the rest, so a day would mix both sources and double
  count. So: on the first 0.6.0 sync of a device that has synced before
  (`lastSyncAt` set), store `ownCollectorFrom` = today's UTC date in config.
  Days before it are not re-sent (enrichment included). A new device has no
  cutover and backfills normally with `--days N`. One-time effect for a
  non-UTC user: a few hours around the boundary day are counted twice or not
  at all (for IST, 5.5 hours). Logged in the changelog.
- No server backfill or re-pricing of old rows. Old rows keep their
  reference-collector cost. Claude Code deletes transcripts after its cleanup
  period (this machine has nothing before 2026-11-17), so a full re-derive is
  not possible anyway.

### Phase 3: cleanup, agent **0.7.0** plus a web release

Done when `git grep -il ccusage` and `git ls-files | grep -i ccusage` both
print nothing. Steps:

- Delete `collectors/reference.ts`, its test, `test/fixtures/ccusage-daily.json`,
  `commands/compare.ts`, `withCommandDirOnPath`, `runCommand`.
- Drop `npxPath` from `DeviceConfig` (`types.ts:109`) and `register.ts:19-27,
  54, 114`. Old config files that still have the key are ignored (`loadConfig`
  does no strict parse).
- `status` prints one line per agent: `claude: 412 files`, `codex: not
  found`, plus the price table version.
- Remove `referenceDiff` from the schema if Decision 5 added it.
- Reword every doc hit (Decision 7) and this design doc (Decision 8).
- Add the grep to CI (`ci.yml`) so the name does not come back.

Git history cannot be rewritten: old commits keep the name.

### Server compatibility with older agents

- Agents 0.4.x and 0.5.x keep sending reference-collector rows. Nothing on
  the server depends on which collector produced a row, and the only new
  payload field (`unpriced`) is optional. No server change blocks an old
  agent.
- The reference collector's `isFreeTier: cost === 0` rows from old agents
  stay as they are; only 0.6.0+ rows use the strict meaning.
- After cleanup, a 0.4/0.5 agent still runs npx on its laptop. It keeps
  working as long as the reference tool does.

### Effect on B5 (versions) and A3 (funnel)

- **B5** (`/devices`): `agentVersion` already tells which collector a device
  uses: below 0.6.0 means the reference collector and a node dependency.
  Recommend raising the "Update agent" badge threshold to 0.6.0 at cutover
  (Decision 9). `AGENT_FIELDS_VERSION` (`packages/shared/src/versions.ts:6`)
  stays 0.4.0: it gates Claude Code version fields, which do not change.
- **A3** (funnel): "first sync" is the first `dailySnapshots` day with
  tokens > 0. A device that cannot run npx (no node, launchd PATH, Windows
  `npx.cmd`, see `tasks/todo.md:165`) never gets there. The device to first
  sync drop (4 to 2 in the A3 design) should shrink after 0.6.0. Worth
  checking a month after cutover; no A3 change needed.

## Public-launch items this unblocks or needs

Separate roadmap items. Listed so they are not forgotten.

1. **macOS signing and notarization.** Releases build on `ubuntu-latest`
   with no signing (`.github/workflows/release.yml:13`). An unsigned or
   ad-hoc signed binary gets a new identity on every update, so the Files and
   Folders grant for `~/Desktop` (the agent 0.4.1 warning) is lost on each
   upgrade. A Developer ID signature plus notarization gives it a stable
   identity; needs a macOS runner. This is likely part of the open privacy
   issue, not all of it.
2. **Windows SmartScreen.** Needs Authenticode signing (OV/EV certificate or
   Azure Trusted Signing). Until then first run shows "unknown publisher".
3. **Install script.** `scripts/install.sh` and `install.ps1` already verify
   checksums. After cutover they no longer need to mention node.
4. **Auto-update.** `burnwatch update` re-runs the install command
   (`apps/agent/src/lib/update.ts:1-11`); nothing runs it automatically. A
   daily "newer version exists" line during sync is the minimum.

## Tests

- `parsers/claude.test.ts`: dedupe on id plus request id; first copy kept;
  `<synthetic>` skipped; sidechain file counted once; 5m/1h split and the
  missing `cache_creation` fallback; UTC date at 23:59:59Z vs 00:00:00Z;
  `CLAUDE_CONFIG_DIR` comma list; mtime pre-filter.
- `pricing.test.ts`: per-request price; above-200k tier applied per request,
  not per day; alias lookup; unknown model gives `unpriced`, not free; cached
  table newer than embedded wins; failed fetch keeps embedded.
- One test per other parser from a shape-derived fixture (Qwen input minus
  cached, Codex cumulative deltas, Gemini rewritten file dedupe).
- `usage.test.ts`: group by `(date, agent, model)`; `totalTokens` is the sum
  of four; `isFreeTier` only from `FREE_TIER_AGENTS`.
- `codeburn.test.ts`: callCount counts requests, not lines; project cost is
  summed from priced requests and the parts add up to the day.
- `sync.test.ts`: `ownCollectorFrom` skips earlier days for an upgraded
  device and not for a new one.
- API: `GET /v1/prices` returns the file and honours `If-None-Match`;
  `unpriced` rows stay out of spend totals.
- CI: `git grep -il ccusage` empty (phase 3 only).
- Manual: `burnwatch compare --days 14` on macOS and Windows before 0.6.0.

## Scope

In: the five agents in `AgentNameSchema`; price table and endpoint; parity
command; the three agent releases; doc and setup page changes; the name
cleanup.

Out:

- New agents (OpenCode, Antigravity, Amp...). `AgentNameSchema` stays five.
- Server-side re-pricing of stored rows.
- Backfill of history from before cutover.
- Seat-plan cost (Max, Team): cost stays API list price.
- Signing, notarization, SmartScreen, auto-update (separate items above).
- Activity and top-session fields codeburn leaves empty (`codeburn.ts:329-333`).

## Size

| Part | Estimate |
|---|---|
| Price table, generator script, endpoint | 1 day |
| Claude parser, pricing, `UsageCollector`, codeburn on the shared pass | 2 days |
| `compare` command and shadow mode (0.5.0) | 1 day |
| Qwen, Gemini, Codex, Copilot parsers | 0.5 to 1 day each once a sample exists; the samples are the real wait |
| Cutover (0.6.0), docs, setup page | 1 day |
| Cleanup (0.7.0), CI grep | 0.5 day |

About 8 to 10 working days of build, spread over the time it takes to get
samples and two weeks of shadow data.

## Decisions (locked 2026-11-23)

All ten accepted as recommended. The enrichment double-count fix ships first as agent v0.4.2, before phase 0.

1. **Price refresh.** Embedded table plus `GET /v1/prices` with a daily
   cached fetch, or embedded only. *Recommend:* embedded plus endpoint. Old
   binaries stay right, a price change is a web release, and a failed fetch
   never blocks a sync.
2. **Who prices.** Agent prices per request, or the server prices from daily
   tokens. *Recommend:* agent. The 200k tier and the 5m/1h split are per
   request and lost in daily sums. Server re-pricing stays out of scope.
3. **Day boundary.** UTC or local. *Recommend:* UTC. The server, codeburn and
   the dates in `sync.ts:13-31` already use UTC; local is what makes usage
   and enrichment disagree today.
4. **Unverified agents.** Keep the reference collector for them, or drop
   them. *Recommend:* per-agent cutover; keep the reference only through
   phase 2; drop any agent still unverified at cleanup and show it as "not
   collected".
5. **Parity data from the field.** Send a `referenceDiff` summary on the
   payload in 0.5.0, or rely on `compare` run by hand. *Recommend:* send it.
   It is counts and dollars only, it needs a `/privacy` entry, and it is
   removed in cleanup.
6. **History at cutover.** Device-level `ownCollectorFrom` date, or a server
   rule that replaces a device's rows for a day when a 0.6.0 agent submits.
   *Recommend:* the cutover date. It keeps first-write-wins, needs no server
   change, and never replaces a full old day with a partial one rebuilt from
   transcripts Claude Code has already cleaned up.
7. **Old docs that name the tool.** `CHANGELOG.md` entries and `tasks/*.md`
   design docs: reword or keep as history. *Recommend:* reword to "the
   previous third-party collector" (the user asked for no hits anywhere).
   `docs/audits/2026-06-23-review.md`, `ccusage.md` and `chatgpt-content.md`
   at the repo root: delete the root files (scratch output), reword the
   audit.
8. **This design doc.** *Recommend:* when cleanup lands, replace both parts
   with a short `tasks/AGENT-OWN-COLLECTOR-DESIGN.md` that describes the
   built collector and calls the old one "the previous third-party
   collector".
9. **B5 badge.** Raise the "Update agent" threshold to 0.6.0 at cutover.
   *Recommend:* yes, as a separate setting from `AGENT_FIELDS_VERSION`.
10. **Unknown `speed` or `service_tier`.** Price at standard and log, or mark
    unpriced. *Recommend:* standard and log once; revisit when a real
    non-standard value shows up.

## Name cleanup inventory

`git grep -ic ccusage` on 2026-11-23, 22 files, plus three file names:

| File | Hits | Action |
|---|---|---|
| `tasks/TICKETS.md` | 33 | Reword |
| `apps/agent/src/collectors/ccusage.test.ts` | 27 | Rename to `reference.test.ts` in phase 0, delete in phase 3 |
| `apps/agent/src/collectors/ccusage.ts` | 13 | Same, as `reference.ts` |
| `docs/audits/2026-06-23-review.md` | 12 | Reword |
| `chatgpt-content.md` | 9 | Delete or reword |
| `apps/agent/src/commands/sync.ts` | 9 | Rewritten in phases 1 and 2 |
| `packages/shared/src/types.ts` | 7 | Types move out in phase 0 |
| `tasks/R1-B1-FREE-TIER-DESIGN.md` | 3 | Reword |
| `docs/ARCHITECTURE.md` | 3 | Rewrite the collector section |
| `apps/agent/src/commands/status.ts` | 3 | Per-agent lines |
| `tasks/R0.3-AGENT-PRIVACY-DESIGN.md` | 2 | Reword |
| `docs/INSTALL.md` | 2 | Rewrite lines 113 and 297 |
| `ccusage.md` | 2 | Delete (pasted terminal output) |
| `apps/agent/src/collectors/codeburn.ts` | 2 | Comments go with the cost split |
| `apps/agent/src/collectors/codeburn.test.ts` | 2 | Same |
| `tasks/todo.md` | 1 | Reword |
| `tasks/ROLLOUT-ROADMAP.md` | 1 | Reword when the row is marked built |
| `tasks/R0.1-SEATS-DESIGN.md` | 1 | Reword |
| `packages/shared/src/schemas.ts` | 1 | Comment on `FREE_TIER_AGENTS` |
| `packages/shared/src/schemas.test.ts` | 1 | Comment at line 80 |
| `packages/db/src/snapshot.ts` | 1 | Comment at line 35 |
| `apps/dashboard/src/components/SetupSteps.tsx` | 1 | Line 156 |
| `CHANGELOG.md` | 0 today | New entries for 0.5.0 to 0.7.0 must not use the name |
| *File names*: `collectors/ccusage.ts`, `ccusage.test.ts`, `test/fixtures/ccusage-daily.json`, `ccusage.md` | | Renamed or deleted as above |

`/privacy` and CI have no hits today. `/privacy` gains the `unpriced` (and,
if Decision 5, `referenceDiff`) descriptions.

## Build order

1. Phase 0 rename: `ccusage.ts` to `reference.ts`, types out of
   `packages/shared`, tests green. No behaviour change.
2. Read the pinned LiteLLM entries for the models in Part 1 and the reference
   pricing code; write `prices.json` and `scripts/update-prices.ts`.
3. `GET /v1/prices`, `unpriced` on the schema and `/privacy`. Web release.
4. `parsers/claude.ts`, `pricing.ts`, `usage.ts` with tests.
5. Codeburn on the shared Claude pass; per-project cost from priced requests.
6. `burnwatch compare`; run 14 days here; fix until Claude passes.
7. `compare --dump-shape`; ship 0.5.0 (shadow, optional `referenceDiff`).
8. Get samples; write Qwen, Gemini, Codex, then Copilot parsers; parity each.
9. Two weeks of shadow data from the field.
10. 0.6.0: our collector writes, UTC days, `ownCollectorFrom`, setup page and
    INSTALL without node; raise the B5 badge.
11. 0.7.0 plus web release: delete the reference collector, `compare`,
    `npxPath`; reword docs; CI grep; replace this doc.

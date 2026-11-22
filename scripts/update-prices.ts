/**
 * Regenerates packages/shared/src/prices.json from LiteLLM's
 * model_prices_and_context_window.json at a pinned commit.
 *
 *   bun scripts/update-prices.ts
 *
 * To take newer prices, change LITELLM_COMMIT and re-run. The table ships
 * inside the agent binary and from GET /v1/prices, so a price change is a web
 * release (own-collector design, Decision 1).
 *
 * LiteLLM is MIT licensed (https://github.com/BerriAI/litellm); the
 * attribution travels in the table's `source` field.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PriceTableSchema, type ModelPrice, type PriceTable } from '../packages/shared/src/schemas.js'

const LITELLM_COMMIT = '18fe30f31d0b94683efa3b494e8da920f6b02f47' // 2026-11-22
const URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_COMMIT}/model_prices_and_context_window.json`
const OUT = join(import.meta.dirname, '..', 'packages', 'shared', 'src', 'prices.json')

// Providers of the agents we collect: Claude Code, Codex, Gemini CLI, Qwen
// Code, Copilot CLI. Order is priority when two strip to the same bare name.
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'dashscope', 'github_copilot']
const MODES = new Set(['chat', 'responses'])
// Models seen in real transcripts (design Part 1); the run fails without them.
const REQUIRED = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']

type Entry = Record<string, unknown>

// A missing, zero or non-numeric price is unknown, never $0.
function price(e: Entry, field: string): number | undefined {
  const v = e[field]
  return typeof v === 'number' && v > 0 ? v : undefined
}

function toModelPrice(e: Entry): ModelPrice | null {
  const input = price(e, 'input_cost_per_token')
  const output = price(e, 'output_cost_per_token')
  if (input === undefined || output === undefined) return null
  const p: ModelPrice = {
    input,
    output,
    cacheWrite5m: price(e, 'cache_creation_input_token_cost'),
    cacheWrite1h: price(e, 'cache_creation_input_token_cost_above_1hr'),
    cacheRead: price(e, 'cache_read_input_token_cost'),
  }
  const hiIn = price(e, 'input_cost_per_token_above_200k_tokens')
  const hiOut = price(e, 'output_cost_per_token_above_200k_tokens')
  if (hiIn !== undefined && hiOut !== undefined) {
    p.above200k = {
      input: hiIn,
      output: hiOut,
      cacheWrite5m: price(e, 'cache_creation_input_token_cost_above_200k_tokens'),
      cacheWrite1h: price(e, 'cache_creation_input_token_cost_above_1hr_above_200k_tokens'),
      cacheRead: price(e, 'cache_read_input_token_cost_above_200k_tokens'),
    }
  }
  // Drop undefined keys so the JSON carries only known prices.
  return JSON.parse(JSON.stringify(p))
}

function buildTable(raw: Record<string, Entry>, commit: string, today: string): PriceTable {
  const models: Record<string, ModelPrice> = {}
  const aliases: Record<string, string> = {}

  for (const provider of PROVIDERS) {
    for (const [key, entry] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.litellm_provider !== provider || !MODES.has(String(entry.mode))) continue
      const p = toModelPrice(entry)
      if (!p) continue
      const bare = key.startsWith(`${provider}/`) ? key.slice(provider.length + 1) : key
      if (models[bare]) {
        // A higher-priority provider owns the bare name; keep this one exact.
        if (!models[key]) models[key] = p
        continue
      }
      models[bare] = p
      if (bare !== key) aliases[key] = bare
    }
  }

  // A dated name priced exactly like its undated base is an alias, not a model.
  for (const name of Object.keys(models)) {
    const base = name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    if (base === name || !models[base]) continue
    if (JSON.stringify(models[base]) !== JSON.stringify(models[name])) continue
    delete models[name]
    aliases[name] = base
    for (const [a, target] of Object.entries(aliases)) if (target === name) aliases[a] = base
  }

  const sorted = <T>(o: Record<string, T>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  return PriceTableSchema.parse({
    version: `${today}+litellm.${commit.slice(0, 7)}`,
    source: `LiteLLM model_prices_and_context_window.json at commit ${commit}, MIT licence, https://github.com/BerriAI/litellm`,
    models: sorted(models),
    aliases: sorted(aliases),
  })
}

async function main() {
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`GET ${URL}: ${res.status}`)
  const raw = (await res.json()) as Record<string, Entry>
  const table = buildTable(raw, LITELLM_COMMIT, new Date().toISOString().slice(0, 10))

  for (const m of REQUIRED) if (!table.models[m]) throw new Error(`required model missing: ${m}`)
  for (const [a, target] of Object.entries(table.aliases)) {
    if (!table.models[target]) throw new Error(`alias ${a} points at missing ${target}`)
  }

  // One model per line: small, and a price change is a one-line diff.
  const lines = (o: Record<string, unknown>) =>
    Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')
  const json = `{
  "version": ${JSON.stringify(table.version)},
  "source": ${JSON.stringify(table.source)},
  "models": {
${lines(table.models)}
  },
  "aliases": {
${lines(table.aliases)}
  }
}
`
  writeFileSync(OUT, json)
  console.log(`${Object.keys(table.models).length} models, ${Object.keys(table.aliases).length} aliases, ${json.length} bytes -> ${OUT}`)
}

await main()

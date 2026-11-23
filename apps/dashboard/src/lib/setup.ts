import type { SetupItem, TeamSetup } from '@burn-watch/shared'

export const SETUP_SOURCES: { source: SetupItem['source']; label: string }[] = [
  { source: 'local', label: 'Add to .mcp.json' },
  { source: 'plugin', label: 'Install plugin' },
  { source: 'claude.ai', label: 'Connect in claude.ai' },
]

/** Plain text a lead can paste into a ticket or the repo README. */
export function setupChecklist(card: TeamSetup): string {
  const lines = SETUP_SOURCES.map(({ source, label }) => {
    const keys = card.items.filter((i) => i.source === source).map((i) => i.key)
    return keys.length ? `${label}: ${keys.join(', ')}` : null
  }).filter(Boolean)
  return [`Recommended setup for ${card.teamName}`, ...lines, 'Skills: needs agent 0.6 or later'].join('\n')
}


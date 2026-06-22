import type { AgentSummary } from '@burn-watch/shared'
import { formatCost, formatTokens } from '@/lib/format'

const AGENT_CONFIG: Record<string, { label: string; color: string }> = {
  claude: { label: 'Claude', color: '#d97706' },
  qwen: { label: 'Qwen', color: '#06b6d4' },
  gemini: { label: 'Gemini', color: '#3b82f6' },
  codex: { label: 'Codex', color: '#10b981' },
  copilot: { label: 'GitHub Copilot', color: '#6366f1' },
}

export function AgentBreakdown({ agents }: { agents: AgentSummary[] }) {
  if (agents.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No agent data</p>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
      {agents.map((a) => {
        const cfg = AGENT_CONFIG[a.agent] ?? { label: a.agent, color: '#888888' }
        return (
          <div
            key={a.agent}
            style={{
              background: 'var(--bg)',
              border: `1px solid ${cfg.color}33`,
              borderRadius: '8px',
              padding: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: cfg.color }} />
              <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{cfg.label}</span>
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: a.isFreeTier ? cfg.color : 'var(--text)' }}>
              {a.isFreeTier ? formatTokens(a.tokens) : formatCost(a.costUsd)}
            </div>
            {a.isFreeTier ? (
              <div style={{ fontSize: '0.75rem', color: cfg.color, marginTop: '0.25rem' }}>free tier · volume only</div>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.25rem' }}>{formatTokens(a.tokens)} tokens</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

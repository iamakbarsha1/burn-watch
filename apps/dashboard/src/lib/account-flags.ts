import type { ClaudeAccountFlag } from '@burn-watch/shared'

// R2 B6. Facts, not verdicts: neutral wording. Governance and My usage share it.
export const FLAG_LABEL: Record<ClaudeAccountFlag, string> = {
  shared: 'Shared account',
  'outside-org': 'Outside company org',
  several: 'Several accounts',
  'seat-no-use': 'Seat, not seen on company org',
  'use-no-seat': 'On company org, no seat',
}

import { describe, it, expect } from 'vitest'
import { buildSystemdService, buildSystemdTimer } from './cron-linux.js'

describe('buildSystemdService', () => {
  it('runs the resolved argv as a oneshot ExecStart', () => {
    const unit = buildSystemdService(['/opt/burnwatch', 'sync'])
    expect(unit).toContain('Type=oneshot')
    expect(unit).toContain('ExecStart=/opt/burnwatch sync')
  })

  it('quotes an argument containing whitespace', () => {
    const unit = buildSystemdService(['/opt/burn watch', 'sync'])
    expect(unit).toContain('ExecStart="/opt/burn watch" sync')
  })

  it('escapes a quote inside a quoted argument', () => {
    const unit = buildSystemdService(['/opt/burn"watch dir', 'sync'])
    expect(unit).toContain('ExecStart="/opt/burn\\"watch dir" sync')
  })
})

describe('buildSystemdTimer', () => {
  it('fires daily at 18:00 and persists across a missed boot', () => {
    const timer = buildSystemdTimer()
    expect(timer).toContain('OnCalendar=*-*-* 18:00:00')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('WantedBy=timers.target')
  })
})

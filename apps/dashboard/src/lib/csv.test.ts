import { describe, it, expect } from 'vitest'
import { parseInviteCsv, splitCsvLine } from './csv'

describe('splitCsvLine', () => {
  it('handles quotes, escaped quotes and trailing blanks', () => {
    expect(splitCsvLine('a@b.c, "Team, One" ,')).toEqual(['a@b.c', 'Team, One', ''])
    expect(splitCsvLine('"say ""hi"""')).toEqual(['say "hi"'])
  })
})

describe('parseInviteCsv', () => {
  it('reads a header in any order and skips blank lines', () => {
    const csv = 'Team,Email,Role\r\nPlatform,a@b.c,manager\n\n,d@e.f,\n'
    expect(parseInviteCsv(csv)).toEqual([
      { email: 'a@b.c', role: 'manager', team: 'Platform' },
      { email: 'd@e.f', role: undefined, team: undefined },
    ])
  })

  it('reads email, role, team in order without a header', () => {
    expect(parseInviteCsv('a@b.c,admin\nx@y.z')).toEqual([
      { email: 'a@b.c', role: 'admin', team: undefined },
      { email: 'x@y.z', role: undefined, team: undefined },
    ])
  })

  it('leaves role and team unset when the header has no such column', () => {
    expect(parseInviteCsv('email\na@b.c')).toEqual([{ email: 'a@b.c', role: undefined, team: undefined }])
  })

  it('is empty for blank input', () => {
    expect(parseInviteCsv('\n \n')).toEqual([])
  })
})

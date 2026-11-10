import { describe, it, expect } from 'vitest'
import { buildTaskXml, buildTaskXmlBuffer } from './cron-windows.js'

describe('buildTaskXml', () => {
  it('fires daily at 18:00', () => {
    const xml = buildTaskXml(['C:\\burnwatch\\burnwatch.exe', 'sync'])
    expect(xml).toContain('<StartBoundary>2024-01-01T18:00:00</StartBoundary>')
    expect(xml).toContain('<DaysInterval>1</DaysInterval>')
  })

  it('splits the resolved argv into Command and Arguments', () => {
    const xml = buildTaskXml(['C:\\burnwatch\\burnwatch.exe', 'sync'])
    expect(xml).toContain('<Command>C:\\burnwatch\\burnwatch.exe</Command>')
    expect(xml).toContain('<Arguments>sync</Arguments>')
  })

  it('quotes an argument containing whitespace', () => {
    const xml = buildTaskXml(['C:\\burnwatch.exe', 'C:\\Program Files\\burnwatch\\entry.js', 'sync'])
    expect(xml).toContain('<Arguments>"C:\\Program Files\\burnwatch\\entry.js" sync</Arguments>')
  })

  it('escapes a quote inside a quoted argument', () => {
    const xml = buildTaskXml(['C:\\burnwatch.exe', 'C:\\has "quote" dir\\entry.js', 'sync'])
    expect(xml).toContain('<Arguments>"C:\\has ""quote"" dir\\entry.js" sync</Arguments>')
  })

  it('escapes XML metacharacters in the command path', () => {
    const xml = buildTaskXml(['C:\\a&b\\burnwatch.exe', 'sync'])
    expect(xml).toContain('<Command>C:\\a&amp;b\\burnwatch.exe</Command>')
  })
})

describe('buildTaskXmlBuffer', () => {
  // Without these two bytes schtasks fails with "(1,2)::ERROR: one root
  // element" on a real Windows host, and nothing gets scheduled.
  it('starts with a UTF-16LE byte order mark', () => {
    const buf = buildTaskXmlBuffer(['C:\\burnwatch\\burnwatch.exe', 'sync'])
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe])
  })

  it('decodes back to the XML', () => {
    const buf = buildTaskXmlBuffer(['C:\\burnwatch\\burnwatch.exe', 'sync'])
    expect(buf.toString('utf16le').slice(1)).toBe(
      buildTaskXml(['C:\\burnwatch\\burnwatch.exe', 'sync']),
    )
  })
})

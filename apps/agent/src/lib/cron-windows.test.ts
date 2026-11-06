import { describe, it, expect } from 'vitest'
import { buildTaskXml } from './cron-windows.js'

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

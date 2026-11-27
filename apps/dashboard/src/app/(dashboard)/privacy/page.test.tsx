import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PrivacyPage from './page'

const html = renderToStaticMarkup(PrivacyPage())

describe('PrivacyPage', () => {
  it('says what BurnWatch will never do, in plain words', () => {
    expect(html).toContain('What BurnWatch will never do')
    for (const line of [
      'Rank people against each other.',
      'Give anyone a number that rates them.',
      'Show one person&#x27;s usage to a manager.',
      'Read your prompts or your code.',
    ]) {
      expect(html).toContain(line)
    }
  })

  it('points to Who viewed my data', () => {
    expect(html).toContain('under Who viewed my data on My usage')
  })

  it('lists what an admin sees about one person, and that an admin can delete them', () => {
    expect(html).toContain('What an admin sees about you')
    expect(html).toContain('Whether your agent has sent anything in the last 7 days, per laptop on Devices and overall on Admin. Not when.')
    expect(html).toContain('Admins never see your cost, tokens or active days anywhere else')
    expect(html).toContain('An admin can delete you.')
  })

  it('has no ranking or rating words', () => {
    expect(html).not.toMatch(/leaderboard|score|streak|violation/i)
  })
})

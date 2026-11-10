import { describe, it, expect } from 'vitest'
import { detectOs } from './os'

describe('detectOs', () => {
  it('reads macOS off a Safari and a Chrome user agent', () => {
    expect(
      detectOs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('macos')
    expect(
      detectOs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('macos')
  })

  it('reads Windows', () => {
    expect(
      detectOs(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('windows')
  })

  it('reads Linux', () => {
    expect(
      detectOs(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('linux')
  })

  it('does not call Android Linux — the agent does not run on a phone', () => {
    expect(
      detectOs(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      ),
    ).toBeNull()
  })

  it('returns null for anything it cannot place, so the caller keeps its default', () => {
    expect(detectOs('')).toBeNull()
    expect(detectOs('curl/8.4.0')).toBeNull()
  })
})

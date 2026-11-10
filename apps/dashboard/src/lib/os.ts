/** The three platforms the agent builds and schedules on. */
export type Os = 'macos' | 'linux' | 'windows'

export const OS_ORDER: readonly Os[] = ['macos', 'linux', 'windows']

export const OS_LABELS: Record<Os, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
}

/**
 * Which tab the setup page should open on, from a browser user-agent string.
 *
 * Returns null when nothing matches, so the caller keeps whatever default it
 * rendered on the server rather than guessing wrong.
 */
export function detectOs(userAgent: string): Os | null {
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macos'
  // Android reports Linux too, and the agent does not run on a phone.
  if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) return 'linux'
  return null
}

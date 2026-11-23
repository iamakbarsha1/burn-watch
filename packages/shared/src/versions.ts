/**
 * R2 B5. The first agent that sends `agentVersion` on submit and the Claude
 * Code version counts. A device below it shows "unknown" for Claude Code.
 * Raise it when a later agent adds fields R2 needs.
 */
export const AGENT_FIELDS_VERSION = '0.4.0'

/**
 * The oldest agent /devices does not flag with "Update agent". 0.6.0 is the
 * first that collects usage itself instead of running a third-party tool
 * through node. Separate from AGENT_FIELDS_VERSION, which gates fields.
 */
export const UPDATE_AGENT_VERSION = '0.6.0'

/** Sign of a vs b, numeric per digit run: 2.1.330 > 2.1.99, 2.10.0 > 2.9.9. */
export const compareVersions = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** Highest version among the keys of a count map, or null when there are none. */
export function highestVersion(versions: Record<string, number> | undefined): string | null {
  const keys = Object.keys(versions ?? {})
  return keys.length ? keys.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a)) : null
}

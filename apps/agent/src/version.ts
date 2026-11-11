/**
 * Single source for the agent version.
 *
 * It was three literals — `package.json`, the commander `.version()` and the
 * `agentVersion` field `register` sends. The third is the one that matters:
 * the `devices` table stores whatever it is told, so a stale copy mislabels
 * every machine that registers with it, and the dashboard's "stale agent"
 * column reads from exactly that field.
 */
export const AGENT_VERSION = '0.2.2'

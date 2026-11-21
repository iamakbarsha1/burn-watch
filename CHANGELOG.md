# Changelog

Two release lines, tagged separately:

- **Web** (`web-vX.Y.Z`): dashboard and API. Deploys on merge to `main`.
- **Agent** (`vX.Y.Z`): the `burnwatch` binary. A `v*` tag builds the binaries,
  and `burnwatch update` installs them.

A feature bumps the minor version, a fix bumps the patch.

## web-v0.2.0 (2026-11-22)

- New "What BurnWatch knows about me" page at `/privacy` ("My data" in the
  sidebar). It lists every field the agent can send, read from the shared
  schema, and shows who can see each one: you, your team's manager, or admins.
  It also lists what is never collected.

## Agent v0.4.0 (2026-11-22)

- Sends repository names and normalised Git remotes, never absolute paths.
- New optional transcript fields: branches, Claude Code versions, entry points,
  skills, subagent messages, permission modes, hashed account IDs.

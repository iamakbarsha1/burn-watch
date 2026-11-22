import { execFile } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, relative, sep } from 'path'

/** stdout of a command, or null when it is missing, fails or runs past 5 s. */
export type Run = (cmd: string, args: string[]) => Promise<string | null>

export const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })

// Only plain host names go to `ssh -G`: a value starting with `-` would be read as an option.
const SAFE_HOST = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * `ssh -G` prints the config ssh would use, so an alias such as
 * `github.com-work` comes back as its real `hostname`. One call per host per
 * collector; an alias ssh cannot resolve is kept as it is.
 */
export function sshHostResolver(runner: Run = run): (host: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  return (host) => {
    let hit = cache.get(host)
    if (!hit) {
      hit = runner('ssh', ['-G', host]).then((out) => /^hostname\s+(\S+)/m.exec(out ?? '')?.[1] ?? host)
      cache.set(host, hit)
    }
    return hit
  }
}

/**
 * `host/owner/repo`, lowercased, with user, token, port and `.git` dropped.
 * Null for a local remote (a path) or anything unparseable.
 */
export async function normaliseRemote(
  url: string,
  resolveHost: (host: string) => Promise<string>,
): Promise<string | null> {
  const raw = url.trim()
  let host: string
  let path: string
  let ssh: boolean
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return null
    }
    if (u.protocol === 'file:' || !u.hostname) return null
    host = u.hostname
    path = u.pathname
    ssh = u.protocol === 'ssh:' || u.protocol === 'git+ssh:'
  } else {
    // scp form `[user@]host:path`: git reads it only with no `/` before the
    // colon, and one letter before it is a Windows drive.
    const m = /^(?:[^@/]+@)?([^:/]{2,}):(.+)$/.exec(raw)
    if (!m) return null
    host = m[1]
    path = m[2]
    ssh = true
  }
  if (ssh && SAFE_HOST.test(host)) host = await resolveHost(host)
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const remote = `${host}/${path}`.toLowerCase()
  return path && remote.length <= 300 ? remote : null
}

/**
 * Whether `dir` holds a `.git`. `existsSync` reports a folder macOS privacy
 * (TCC) will not let us read as absent, so a blocked repo looked like no repo.
 */
export function probeGit(dir: string, stat: (path: string) => unknown = statSync): 'repo' | 'none' | 'denied' {
  try {
    stat(join(dir, '.git'))
    return 'repo'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'none'
  }
}

/** The top folder a privacy block applies to: `~/Desktop` for anything under it. */
export function protectedFolder(root: string, home: string = homedir()): string {
  const rel = relative(home, root)
  if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return `~/${rel.split(sep)[0]}`
  return sep + (root.split(sep).filter(Boolean)[0] ?? '')
}

export interface RepoIdentity {
  /** Sent as `path`: never a path. */
  name: string
  remote: string | null
  /** Set when the OS refused to let us look: the folder to grant access to. Never sent. */
  denied?: string
}

/** Name and remote for a checkout root from `projectRoot`. */
export async function repoIdentity(
  root: string,
  runner: Run,
  resolveHost: (host: string) => Promise<string>,
  home: string = homedir(),
  stat?: (path: string) => unknown,
): Promise<RepoIdentity> {
  const git = probeGit(root, stat)
  const url = git === 'repo' ? await runner('git', ['-C', root, 'remote', 'get-url', 'origin']) : null
  const remote = url ? await normaliseRemote(url, resolveHost) : null
  // The home folder's basename is the user's login name.
  const name = remote?.split('/').pop() ?? (root === home ? '~' : basename(root) || '~')
  return git === 'denied' ? { name, remote, denied: protectedFolder(root, home) } : { name, remote }
}

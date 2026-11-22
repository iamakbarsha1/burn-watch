import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normaliseRemote, probeGit, protectedFolder, repoIdentity, sshHostResolver, type Run } from './repo.js'

// ssh config on a fake machine: one alias for github.com.
const fakeSsh: Run = async (cmd, args) =>
  cmd === 'ssh' && args[1] === 'github.com-work' ? 'user git\nhostname github.com\nport 22' : null
const resolve = sshHostResolver(fakeSsh)

describe('normaliseRemote', () => {
  it.each([
    ['git@github.com:Org/Repo.git', 'github.com/org/repo'],
    ['ssh://git@github.com:2222/org/repo.git', 'github.com/org/repo'],
    ['https://ghp_token@github.com/org/repo', 'github.com/org/repo'],
    ['https://user:pass@gitlab.com/group/sub/repo.git/', 'gitlab.com/group/sub/repo'],
    ['git://example.org/org/repo/', 'example.org/org/repo'],
    ['git@github.com-work:org/repo.git', 'github.com/org/repo'],
    ['ssh://git@github.com-work/org/repo.git', 'github.com/org/repo'],
    ['git@no-such-alias:org/repo.git', 'no-such-alias/org/repo'],
  ])('%s gives %s', async (url, expected) => {
    expect(await normaliseRemote(url, resolve)).toBe(expected)
  })

  it.each(['/srv/git/repo.git', 'file:///srv/git/repo.git', 'C:\\git\\repo', 'C:/git/repo', '../repo'])(
    'local remote %s gives null',
    async (url) => {
      expect(await normaliseRemote(url, resolve)).toBeNull()
    },
  )

  it('never hands ssh a value it would read as an option', async () => {
    const seen: string[][] = []
    const spy = sshHostResolver(async (_cmd, args) => (seen.push(args), null))
    await normaliseRemote('-oProxyCommand=x:org/repo', spy)
    expect(seen).toEqual([])
  })

  it('asks ssh once per host', async () => {
    let calls = 0
    const counting = sshHostResolver(async () => (calls++, 'hostname github.com'))
    await normaliseRemote('git@alias:a/b', counting)
    await normaliseRemote('git@alias:c/d', counting)
    expect(calls).toBe(1)
  })
})

describe('repoIdentity', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'burnwatch-repo-'))
  const git = (out: string | null): Run => async (cmd) => (cmd === 'git' ? out : null)

  it('names a repo after its remote', async () => {
    const dir = tmp()
    const root = join(dir, 'local-name')
    mkdirSync(join(root, '.git'), { recursive: true })
    expect(await repoIdentity(root, git('git@github.com:org/real-name.git'), resolve)).toEqual({
      name: 'real-name',
      remote: 'github.com/org/real-name',
    })
    rmSync(dir, { recursive: true })
  })

  it('falls back to the folder name with no remote, or with git missing', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    // git missing and "no origin" both come back from the runner as null.
    expect(await repoIdentity(join(dir, 'repo'), git(null), resolve)).toEqual({ name: 'repo', remote: null })
    rmSync(dir, { recursive: true })
  })

  it('names a folder that is gone by its basename, without running git', async () => {
    let ran = false
    const id = await repoIdentity('/gone/away/project', async () => ((ran = true), 'x'), resolve)
    expect(id).toEqual({ name: 'project', remote: null })
    expect(ran).toBe(false)
  })

  it('reports the home folder as ~, never the login name', async () => {
    expect(await repoIdentity('/home/someone', git(null), resolve, '/home/someone')).toEqual({ name: '~', remote: null })
  })
})

describe('probeGit', () => {
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code })
  }

  it('tells a repo, a plain folder and a folder macOS blocks apart', () => {
    expect(probeGit('/r', () => ({}))).toBe('repo')
    expect(probeGit('/r', failWith('ENOENT'))).toBe('none')
    expect(probeGit('/r', failWith('ENOTDIR'))).toBe('none')
    expect(probeGit('/r', failWith('EPERM'))).toBe('denied')
    expect(probeGit('/r', failWith('EACCES'))).toBe('denied')
  })

  it('names the top folder to grant, under home or not', () => {
    expect(protectedFolder('/Users/a/Desktop/code/repo', '/Users/a')).toBe('~/Desktop')
    expect(protectedFolder('/Volumes/Drive/repo', '/Users/a')).toBe('/Volumes')
  })

  it('keeps the folder-name fallback for a blocked repo, without running git, and records the folder', async () => {
    let ran = false
    const eperm = failWith('EPERM')
    const id = await repoIdentity('/Users/a/Desktop/code/burn-watch', async () => ((ran = true), 'x'), resolve, '/Users/a', eperm)
    expect(id).toEqual({ name: 'burn-watch', remote: null, denied: '~/Desktop' })
    expect(ran).toBe(false)
  })
})

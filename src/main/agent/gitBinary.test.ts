import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeGitExecutable, XCODE_SELECT_LINK, type GitBinaryProbe } from './gitBinary'

const XCODE = '/Applications/Xcode.app/Contents/Developer'
const CLT = '/Library/Developer/CommandLineTools'

/** A probe over a fake filesystem that records every lookup it is asked for. */
function fakeProbe(opts: { executables: string[]; link?: string | null; platform?: NodeJS.Platform }) {
  const exec = new Set(opts.executables)
  const asked: string[] = []
  const probe: GitBinaryProbe = {
    platform: opts.platform ?? 'darwin',
    isExecutable: (p) => {
      asked.push(p)
      return exec.has(p)
    },
    readLink: (p) => {
      asked.push(`readlink ${p}`)
      return p === XCODE_SELECT_LINK ? (opts.link ?? null) : null
    }
  }
  return { probe, asked, exec }
}

describe('gitExecutable', () => {
  it('runs the selected developer tools git when the launcher is first on PATH', () => {
    const { probe } = fakeProbe({ executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`], link: XCODE })
    expect(makeGitExecutable(probe)({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' })).toBe(`${XCODE}/usr/bin/git`)
    // A trailing slash on the entry names the same launcher.
    expect(makeGitExecutable(probe)({ PATH: '/usr/bin/:/bin' })).toBe(`${XCODE}/usr/bin/git`)
  })

  it('reads the developer directory from DEVELOPER_DIR before the xcode-select link', () => {
    const { probe, asked } = fakeProbe({
      executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`, `${CLT}/usr/bin/git`],
      link: XCODE
    })
    expect(makeGitExecutable(probe)({ PATH: '/usr/bin', DEVELOPER_DIR: CLT })).toBe(`${CLT}/usr/bin/git`)
    expect(asked).not.toContain(`readlink ${XCODE_SELECT_LINK}`)
    // A DEVELOPER_DIR without git does not fall back to the link: the launcher wouldn't.
    expect(makeGitExecutable(probe)({ PATH: '/usr/bin', DEVELOPER_DIR: '/nowhere' })).toBe('git')
    // Set but empty or relative: left to the launcher.
    expect(makeGitExecutable(probe)({ PATH: '/usr/bin', DEVELOPER_DIR: '' })).toBe('git')
    expect(makeGitExecutable(probe)({ PATH: '/usr/bin', DEVELOPER_DIR: 'Xcode.app/Contents/Developer' })).toBe('git')
  })

  it("keeps 'git' when the developer tools git is missing or not executable", () => {
    // Only the launcher installed (no developer tools selected): it shows the install prompt.
    expect(makeGitExecutable(fakeProbe({ executables: ['/usr/bin/git'], link: null }).probe)({ PATH: '/usr/bin' })).toBe(
      'git'
    )
    // A link to a developer directory that holds no git.
    expect(makeGitExecutable(fakeProbe({ executables: ['/usr/bin/git'], link: XCODE }).probe)({ PATH: '/usr/bin' })).toBe(
      'git'
    )
    // A link that is relative, or that points back at the launcher.
    const relativeLink = fakeProbe({ executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`], link: 'Xcode/Developer' })
    expect(makeGitExecutable(relativeLink.probe)({ PATH: '/usr/bin' })).toBe('git')
    const rootLink = fakeProbe({ executables: ['/usr/bin/git'], link: '/' })
    expect(makeGitExecutable(rootLink.probe)({ PATH: '/usr/bin' })).toBe('git')
  })

  it("keeps 'git' when the first git on PATH is not the launcher", () => {
    const { probe } = fakeProbe({
      executables: ['/opt/homebrew/bin/git', '/usr/bin/git', `${XCODE}/usr/bin/git`],
      link: XCODE
    })
    const git = makeGitExecutable(probe)
    expect(git({ PATH: '/opt/homebrew/bin:/usr/bin' })).toBe('git')
    // No git on PATH at all.
    expect(git({ PATH: '/opt/nothing' })).toBe('git')
    // An empty or relative entry ahead of /usr/bin is searched from the spawn's working
    // directory, which could hold a git of its own.
    expect(git({ PATH: ':/usr/bin' })).toBe('git')
    expect(git({ PATH: 'node_modules/.bin:/usr/bin' })).toBe('git')
    // ...but one after it never gets a say.
    expect(git({ PATH: '/usr/bin::bin' })).toBe(`${XCODE}/usr/bin/git`)
  })

  it('skips a PATH entry whose git is not an executable file, as the spawn does', () => {
    // `/opt/x/git` is a directory or lacks the execute bit: the fake reports it as not executable.
    const { probe, asked } = fakeProbe({ executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`], link: XCODE })
    expect(makeGitExecutable(probe)({ PATH: '/opt/x:/usr/bin' })).toBe(`${XCODE}/usr/bin/git`)
    expect(asked[0]).toBe('/opt/x/git')
  })

  it('searches the default path when the environment has no PATH', () => {
    const { probe } = fakeProbe({ executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`], link: XCODE })
    expect(makeGitExecutable(probe)({})).toBe(`${XCODE}/usr/bin/git`)
  })

  it("is always 'git' off macOS, without touching the filesystem", () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      const { probe, asked } = fakeProbe({ executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`], link: XCODE, platform })
      expect(makeGitExecutable(probe)({ PATH: '/usr/bin' })).toBe('git')
      expect(asked).toEqual([])
    }
  })

  it('remembers the answer per PATH and DEVELOPER_DIR', () => {
    const { probe, asked } = fakeProbe({
      executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`, `${CLT}/usr/bin/git`],
      link: XCODE
    })
    const git = makeGitExecutable(probe)
    expect(git({ PATH: '/a:/b:/usr/bin' })).toBe(`${XCODE}/usr/bin/git`)
    const firstLookup = asked.length
    expect(firstLookup).toBeGreaterThan(3)
    // Again: only the remembered binary is checked to still be there.
    expect(git({ PATH: '/a:/b:/usr/bin' })).toBe(`${XCODE}/usr/bin/git`)
    expect(asked.slice(firstLookup)).toEqual([`${XCODE}/usr/bin/git`])
    // A 'git' answer is remembered with no check at all.
    const before = asked.length
    expect(git({ PATH: '/opt/nothing' })).toBe('git')
    const afterFirst = asked.length
    expect(afterFirst).toBeGreaterThan(before)
    expect(git({ PATH: '/opt/nothing' })).toBe('git')
    expect(asked.length).toBe(afterFirst)
    // Another PATH or DEVELOPER_DIR is its own entry.
    expect(git({ PATH: '/a:/b:/usr/bin', DEVELOPER_DIR: CLT })).toBe(`${CLT}/usr/bin/git`)
    expect(git({ PATH: '/usr/bin' })).toBe(`${XCODE}/usr/bin/git`)
  })

  it('looks again once the remembered developer tools git is gone', () => {
    const { probe, exec } = fakeProbe({
      executables: ['/usr/bin/git', `${XCODE}/usr/bin/git`, `${CLT}/usr/bin/git`],
      link: XCODE
    })
    const git = makeGitExecutable(probe)
    expect(git({ PATH: '/usr/bin' })).toBe(`${XCODE}/usr/bin/git`)
    exec.delete(`${XCODE}/usr/bin/git`) // Xcode removed while the app runs
    expect(git({ PATH: '/usr/bin' })).toBe('git')
  })
})

describe('git spawn sites', () => {
  // Every git process under src/main names its program through gitExecutable, so none
  // pays for the macOS launcher. Test files are exempt (they build fixture repositories).
  const MAIN = resolve(__dirname, '..')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
      else if (/\.ts$/.test(name) && !/\.(test|eval)\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
    }
    return out
  }

  // A spawn call whose program is a 'git' literal, or a shell string that starts with git.
  const BARE_GIT_SPAWN =
    /\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git(?:\.exe)?['"`]|\b(?:exec|execSync)\(\s*['"`]git\s/

  it('never spawns a bare git', () => {
    const found: string[] = []
    for (const file of sourceFiles(MAIN)) {
      const n = readFileSync(file, 'utf8').match(new RegExp(BARE_GIT_SPAWN.source, 'g'))?.length ?? 0
      if (n) found.push(`${relative(MAIN, file).split('\\').join('/')} (${n})`)
    }
    expect(found).toEqual([])
  })

  it('catches the spellings it is meant to', () => {
    expect(BARE_GIT_SPAWN.test("execFile('git', ['status'])")).toBe(true)
    expect(BARE_GIT_SPAWN.test("execFile(\n      'git',\n      [...hardening]")).toBe(true)
    expect(BARE_GIT_SPAWN.test('spawnSync("git", args)')).toBe(true)
    expect(BARE_GIT_SPAWN.test('execSync(`git rev-parse HEAD`)')).toBe(true)
    expect(BARE_GIT_SPAWN.test('execFile(gitExecutable(GIT_ENV), args)')).toBe(false)
    expect(BARE_GIT_SPAWN.test("execFile('ssh', ['-G', alias])")).toBe(false)
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHOICES,
  RELEASE_FILES,
  compareVersions,
  isLatest,
  isPrCommit,
  lineFor,
  normalizeVersion,
  planPrepare,
  prNumberFromSubject,
  releaseProblems,
  releaseVersionFromSubject,
  stableVersions,
  versionOnlyChange,
} from './release-source.mjs'

const OWNER = 'houston-code'
const MINOR = 'Next minor version'
const MAJOR = 'Next major version'
const PATCH = 'Patch a release'
const UPDATE = 'Update pending release'

describe('the prepare choices', () => {
  it('are exactly the four options release-prepare.yml offers, in order', () => {
    expect(Object.keys(CHOICES)).toEqual([MINOR, MAJOR, PATCH, UPDATE])
  })
})

describe('normalizeVersion', () => {
  it('accepts X.Y.Z with or without a leading v, and nothing else', () => {
    expect(normalizeVersion('0.9.0')).toBe('0.9.0')
    expect(normalizeVersion(' v0.10.2 ')).toBe('0.10.2')
    expect(normalizeVersion('1.0.0-rc.1')).toBeNull()
    expect(normalizeVersion('0.9')).toBeNull()
    expect(normalizeVersion('0.9.0;id')).toBeNull()
    expect(normalizeVersion('')).toBeNull()
    expect(normalizeVersion(undefined)).toBeNull()
  })
})

describe('lineFor, compareVersions, stableVersions, isLatest', () => {
  it('maps a version to its line', () => {
    expect(lineFor('0.9.3')).toBe('release/0.9')
    expect(lineFor('0.10.0')).toBe('release/0.10')
  })

  it('orders versions numerically, with a pre-release below its release', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('keeps stable v* tags, highest first', () => {
    expect(stableVersions(['v0.9.0', 'v0.10.0', 'v1.0.0-rc.1', 'nightly', 'v0.9.1'])).toEqual(['0.10.0', '0.9.1', '0.9.0'])
  })

  it('marks only the highest stable release latest', () => {
    expect(isLatest('0.9.1', ['v0.9.0'])).toBe(true)
    expect(isLatest('0.8.1', ['v0.8.0', 'v0.9.0'])).toBe(false)
    expect(isLatest('1.0.0-rc.1', ['v0.9.0'])).toBe(false)
  })
})

describe('planPrepare', () => {
  const base = { tags: ['v0.7.0', 'v0.8.0'], lines: [], pending: [], mainVersion: '0.8.0' }
  const plan = (choice, version, over = {}) => planPrepare({ ...base, ...over, choice, version })

  it('cuts the next minor or major onto a new line, accepting a leading v', () => {
    expect(plan(MINOR, '0.9.0')).toEqual({ mode: 'minor', version: '0.9.0', line: 'release/0.9', createLine: true, fromTag: null })
    expect(plan(MAJOR, 'v1.0.0')).toMatchObject({ mode: 'major', version: '1.0.0', line: 'release/1.0' })
  })

  it('refuses a version that does not match the choice, naming the right one', () => {
    expect(() => plan(MINOR, '0.10.0')).toThrow('The next minor version is 0.9.0.')
    expect(() => plan(MAJOR, '0.9.0')).toThrow('The next major version is 1.0.0.')
  })

  it('counts new versions from everything that exists, so several new lines can be in progress', () => {
    const inFlight = { lines: ['release/0.9'], pending: ['0.9.0'] }
    expect(plan(MINOR, '0.10.0', inFlight)).toMatchObject({ mode: 'minor', line: 'release/0.10' })
    expect(plan(MAJOR, '1.0.0', inFlight)).toMatchObject({ mode: 'major', line: 'release/1.0' })
  })

  it('uses main only before the first release', () => {
    expect(plan(MINOR, '0.4.0', { tags: [], mainVersion: '0.3.0' }).version).toBe('0.4.0')
  })

  it('refuses to cut onto a line left behind by an abandoned cut', () => {
    expect(() => plan(MINOR, '0.9.0', { lines: ['release/0.9'] })).toThrow(/release\/0\.9 already exists.*delete the branch/)
  })

  it('patches any shipped line with its next patch', () => {
    const shipped = { tags: ['v0.8.0', 'v0.9.0', 'v0.9.1'], lines: ['release/0.8', 'release/0.9'] }
    expect(plan(PATCH, '0.9.2', shipped)).toEqual({ mode: 'patch', version: '0.9.2', line: 'release/0.9', createLine: false, fromTag: null })
    expect(plan(PATCH, '0.8.1', shipped)).toMatchObject({ mode: 'patch', line: 'release/0.8' })
  })

  it('creates the line for a release from before release lines, and stops there', () => {
    expect(plan(PATCH, '0.8.1')).toEqual({ mode: 'line-only', version: '0.8.1', line: 'release/0.8', createLine: true, fromTag: 'v0.8.0' })
  })

  it('refuses a wrong patch number, an X.Y.0 patch, an unshipped line, and a line with a pending patch', () => {
    const shipped = { tags: ['v0.9.0'], lines: ['release/0.9'] }
    expect(() => plan(PATCH, '0.9.2', shipped)).toThrow('The next patch of 0.9 is 0.9.1.')
    expect(() => plan(PATCH, '0.9.0', shipped)).toThrow(/ends in a number above 0, like 0\.9\.1/)
    expect(() => plan(PATCH, '0.6.1')).toThrow(/Nothing has shipped on 0\.6/)
    expect(() => plan(PATCH, '0.9.1', { ...shipped, pending: ['0.9.1'] })).toThrow(/v0\.9\.1 is pending on release\/0\.9.*Update pending release/)
  })

  it('updates a pending version, and explains what to do for a shipped or unknown one', () => {
    const p = { tags: ['v0.9.0'], lines: ['release/0.9', 'release/0.10'], pending: ['0.9.1', '0.10.0'] }
    expect(plan(UPDATE, '0.9.1', p)).toMatchObject({ mode: 'update', line: 'release/0.9' })
    expect(plan(UPDATE, '0.10.0', p)).toMatchObject({ mode: 'update', line: 'release/0.10' })
    expect(() => plan(UPDATE, '0.9.0', p)).toThrow('v0.9.0 already shipped. To fix it, choose "Patch a release" with 0.9.1.')
    expect(() => plan(UPDATE, '0.11.0', p)).toThrow(/v0\.11\.0 isn't pending/)
  })

  it('refuses an unknown choice and a malformed version', () => {
    expect(() => plan('Hotfix', '0.9.0')).toThrow(/Unknown choice/)
    expect(() => plan(MINOR, '0.9')).toThrow(/isn't a version/)
    expect(() => plan(MINOR, '')).toThrow(/isn't a version/)
  })
})

describe('prNumberFromSubject and isPrCommit', () => {
  it('reads merge and squash commits', () => {
    expect(prNumberFromSubject('Merge pull request #251 from houston-code/claude/step3-focus')).toBe(251)
    expect(prNumberFromSubject('Fix the crash on launch (#58)')).toBe(58)
  })

  it("drops the automation's own commits", () => {
    expect(prNumberFromSubject('Merge pull request #60 from houston-code/release-pr/v0.9.1')).toBeNull()
    expect(prNumberFromSubject('Merge pull request #61 from houston-code/release-sync/v0.9.1')).toBeNull()
    expect(prNumberFromSubject('release: v0.9.1 (#60)')).toBeNull()
    expect(prNumberFromSubject('chore(release): sync v0.9.1 notes to main (#61)')).toBeNull()
  })

  it('tells a PR commit from a rebase-merged or directly pushed one', () => {
    expect(isPrCommit('Merge pull request #5 from houston-code/x')).toBe(true)
    expect(isPrCommit('Fix (#5)')).toBe(true)
    expect(isPrCommit('fix: something')).toBe(false)
    expect(prNumberFromSubject('fix: something')).toBeNull()
  })
})

describe('releaseVersionFromSubject', () => {
  it('reads the version only from a release-pr merge from the owner', () => {
    expect(releaseVersionFromSubject('Merge pull request #33 from houston-code/release-pr/v0.9.0', OWNER)).toBe('0.9.0')
    expect(releaseVersionFromSubject('Merge pull request #33 from mallory/release-pr/v0.9.0', OWNER)).toBeNull()
    expect(releaseVersionFromSubject('Merge pull request #33 from houston-code/release/0.9', OWNER)).toBeNull()
    expect(releaseVersionFromSubject('Merge pull request #40 from houstonXcode/release-pr/v0.9.0', 'houston.code')).toBeNull()
  })
})

describe('versionOnlyChange', () => {
  const pkg = (v, deps = {}) => JSON.stringify({ name: 'x', version: v, dependencies: deps }, null, 2)
  const lock = (v, deps = {}) =>
    JSON.stringify({ name: 'x', version: v, packages: { '': { name: 'x', version: v, dependencies: deps } } }, null, 2)

  it('allows the version bump alone', () => {
    expect(versionOnlyChange('package.json', pkg('0.9.0'), pkg('0.9.1'))).toBe(true)
    expect(versionOnlyChange('package-lock.json', lock('0.9.0'), lock('0.9.1'))).toBe(true)
  })

  it('catches a dependency change riding along with the bump', () => {
    expect(versionOnlyChange('package.json', pkg('0.9.0'), pkg('0.9.1', { evil: '1.0.0' }))).toBe(false)
    expect(versionOnlyChange('package-lock.json', lock('0.9.0'), lock('0.9.1', { evil: '1.0.0' }))).toBe(false)
    expect(versionOnlyChange('package.json', pkg('0.9.0'), '{ broken')).toBe(false)
  })
})

describe('releaseProblems', () => {
  const good = {
    found: true,
    sha: 'r',
    packageVersion: '0.9.0',
    bases: ['b'],
    baseIsAncestor: true,
    changedFiles: [...RELEASE_FILES],
    jsonOk: true,
    skipped: [],
    later: [],
    tagCommit: null,
    notes: [],
  }
  const run = (over) => releaseProblems('0.9.0', 'release/0.9', { ...good, ...over }).join(' ')

  it('passes a clean release commit', () => {
    expect(run({})).toBe('')
  })

  it('needs a merged release PR, and explains a squash merge', () => {
    expect(run({ found: false })).toMatch(/no merge of release-pr\/v0\.9\.0 on release\/0\.9/)
    expect(run({ found: false, squashed: true })).toMatch(/squash-merged.*Create a merge commit/)
  })

  it('rejects a mismatched version, a bad Release-Base, and extra changes', () => {
    expect(run({ packageVersion: '0.8.0' })).toMatch(/is 0\.8\.0, not 0\.9\.0/)
    expect(run({ bases: [] })).toMatch(/exactly one Release-Base/)
    expect(run({ baseIsAncestor: false })).toMatch(/not an ancestor/)
    expect(run({ changedFiles: ['CHANGELOG.md', 'src/main/index.ts'] })).toMatch(/src\/main\/index\.ts.*Update pending release/)
    expect(run({ jsonOk: false })).toMatch(/package\.json or package-lock\.json beyond the version/)
  })

  it('refuses notes that fail the summary check', () => {
    expect(run({ notes: ['the summary must be a complete sentence'] })).toMatch(/release notes: the summary must be/)
  })

  it('refuses changes merged to the line while the release PR was open, which would not ship', () => {
    expect(run({ skipped: ['#66'] })).toMatch(/merged after v0\.9\.0 was cut that its release PR doesn't include \(#66\).*Update pending release/)
    // Once tagged, a re-run is about the shipped commit, not the line.
    expect(run({ skipped: ['#66'], tagCommit: 'r' })).toBe('')
  })

  it('refuses unannounced changes after the release PR until it is tagged, and a tag on another commit', () => {
    expect(run({ later: ['#57', 'abc123456'] })).toMatch(/#57, abc123456.*Update pending release/)
    expect(run({ later: ['#57'], tagCommit: 'r' })).toBe('')
    expect(run({ tagCommit: 'other' })).toMatch(/already names other/)
  })
})

// End to end against a real repository shaped like the release flow:
//
//   main:         base ─ #10 ─ #11 (v0.8.0, the old flow) ─ #12 ─ #13 ─ #14 ─ #15
//   release/0.9:  cut at #12 ─ #33 release-pr/v0.9.0 (R0) ─ #57 backport ─ #34 update (R0',
//                 v0.9.0) ─ "(#58)" squash backport ─ #60 release-pr/v0.9.1 (R1) ─ [#59]
//
// origin/* refs point at the branch tips (the workflows fetch them before running the script).
// Every CLI test spawns the script (a node start plus a dozen or more git calls) and most
// move refs or commit first: about 1s each on a Windows runner, and a busy runner has
// stretched one past 6s.
describe('release-source CLI', { timeout: 30_000 }, () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'release-source.mjs')
  let repo
  const sh = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const write = (name, text) => {
    writeFileSync(join(repo, name), text)
    sh('add', name)
  }
  const pkg = (v, deps) => JSON.stringify({ name: 'x', version: v, ...(deps ? { dependencies: deps } : {}) }) + '\n'
  const commit = (msg) => sh('commit', '-qm', msg)
  const pr = (n, branch, into, change, from = into) => {
    sh('checkout', '-q', '-B', branch, from)
    change()
    sh('checkout', '-q', into)
    sh('merge', '--no-ff', '-q', branch, '-m', `Merge pull request #${n} from ${OWNER}/${branch}`)
    return sh('rev-parse', 'HEAD')
  }
  const feature = (n) => () => {
    write(`f${n}.txt`, `${n}\n`)
    commit(`feature ${n}`)
  }
  const releaseCommit = (v, base, { summary = `Ships version ${v} from ${base.slice(0, 7)}.`, extra } = {}) => () => {
    write('package.json', pkg(v))
    write('CHANGELOG.md', `# Changelog\n\n## v${v} - 2026-10-21\n\n${summary}\n`)
    if (extra) extra()
    commit(`release: v${v}\n\nRelease-Base: ${base}`)
  }
  const run = (mode, env) =>
    spawnSync(process.execPath, [script, mode], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY_OWNER: OWNER, ...env },
    })
  const out = (r) => Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const numbers = (r) => r.stdout.trim().split('\n').filter(Boolean).map(Number)
  const point = (branch, sha) => sh('update-ref', `refs/remotes/origin/${branch}`, sha)
  const unpoint = (branch) => sh('update-ref', '-d', `refs/remotes/origin/${branch}`)
  const s = {}

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-source-'))
    sh('init', '-q', '-b', 'main')
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
      sh('config', k, v)
    }
    write('package.json', pkg('0.8.0'))
    commit('base')
    pr(10, 'feat/a', 'main', feature(10))
    s.v080 = pr(11, 'feat/b', 'main', feature(11))
    sh('tag', 'v0.8.0', s.v080)
    s.cut = pr(12, 'feat/c', 'main', feature(12))

    sh('branch', 'release/0.9', s.cut)
    s.m0 = pr(33, 'release-pr/v0.9.0', 'release/0.9', releaseCommit('0.9.0', s.cut))
    s.r0 = sh('rev-parse', `${s.m0}^2`)
    pr(13, 'feat/d', 'main', feature(13))
    s.b57 = pr(57, 'backport/0.9/pr-13', 'release/0.9', feature(57))
    s.m0u = pr(34, 'release-pr/v0.9.0', 'release/0.9', releaseCommit('0.9.0', s.b57), s.b57)
    s.r0u = sh('rev-parse', `${s.m0u}^2`)
    sh('tag', 'v0.9.0', s.r0u)
    pr(14, 'feat/e', 'main', feature(14))
    // A squash-merged backport: one plain commit on the line, titled "… (#58)".
    sh('checkout', '-q', 'release/0.9')
    write('f58.txt', '58\n')
    commit('Fix the crash on launch (#58)')
    s.b58 = sh('rev-parse', 'HEAD')
    s.m1 = pr(60, 'release-pr/v0.9.1', 'release/0.9', releaseCommit('0.9.1', s.b58))
    s.r1 = sh('rev-parse', `${s.m1}^2`)
    s.b59 = pr(59, 'backport/0.9/pr-14', 'release/0.9', feature(59))
    s.main = pr(15, 'feat/f', 'main', feature(15))
    point('main', s.main)
    point('release/0.9', s.m1)
    // Dozens of synchronous git spawns: well past the 10s hook default on Windows runners.
  }, 60_000)

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  const plan = (choice, version) => run('plan', { CHOICE: choice, VERSION: version, MAIN_SHA: s.main })

  describe('plan', () => {
    it('cuts the next minor from the dispatched main commit, counting the pending 0.9.1', () => {
      const r = plan(MINOR, '0.10.0')
      expect(r.stderr).toBe('')
      expect(out(r)).toMatchObject({ mode: 'minor', version: '0.10.0', line: 'release/0.10', create_line: 'true', sha: s.main })
      expect(out(r).summary).toBe('Cutting v0.10.0 (next minor) from main into a new release/0.10 branch.')
    })

    it('refuses a patch while 0.9.1 is pending on the line', () => {
      const r = plan(PATCH, '0.9.1')
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/v0\.9\.1 is pending on release\/0\.9/)
    })

    it('updates a merged pending release even with no new merges, regenerating its notes', () => {
      const r = plan(UPDATE, '0.9.1')
      expect(r.stderr).toBe('')
      expect(out(r)).toMatchObject({ mode: 'update', version: '0.9.1', sha: s.m1 })
      expect(out(r).summary).toMatch(/no new merges.*notes are regenerated/)
    })

    it('updates from an open release PR whose notes were edited in review', () => {
      // The open PR: the release commit plus a reviewer's notes edit on top; the line has
      // moved on by one backport since the cut.
      point('release/0.9', s.b59)
      sh('checkout', '-q', '-B', 'open-pr', s.b58)
      // A different draft from the merged 0.9.1 release commit: otherwise both commits can be
      // byte-identical (same parent, tree, message and second) and git sees one commit.
      releaseCommit('0.9.1', s.b58, { summary: 'Ships the reviewed draft of version 0.9.1.' })()
      write('CHANGELOG.md', '# Changelog\n\n## v0.9.1\n\nEdited in review.\n')
      commit('Tighten the notes')
      point('release-pr/v0.9.1', sh('rev-parse', 'HEAD'))
      try {
        const r = plan(UPDATE, '0.9.1')
        expect(r.stderr).toBe('')
        expect(out(r)).toMatchObject({ mode: 'update', sha: s.b59 })
        expect(out(r).summary).toMatch(/#59/)
      } finally {
        unpoint('release-pr/v0.9.1')
        point('release/0.9', s.m1)
      }
    })

    it('patches once the previous patch shipped, listing what it brings', () => {
      sh('tag', 'v0.9.1', s.r1)
      point('release/0.9', s.b59)
      try {
        const r = plan(PATCH, '0.9.2')
        expect(r.stderr).toBe('')
        expect(out(r)).toMatchObject({ mode: 'patch', version: '0.9.2', sha: s.b59, create_line: 'false' })
        expect(out(r).summary).toMatch(/#59/)
        // Nothing new since 0.9.1 means nothing to patch.
        point('release/0.9', s.m1)
        expect(plan(PATCH, '0.9.2').stderr).toMatch(/Nothing merged to release\/0\.9 since v0\.9\.1/)
      } finally {
        sh('tag', '-d', 'v0.9.1')
        point('release/0.9', s.m1)
      }
    })

    it('refuses a patch over a commit that skipped a PR', () => {
      sh('tag', 'v0.9.1', s.r1)
      sh('checkout', '-q', '-B', 'direct', s.m1)
      write('direct.txt', 'x\n')
      commit('quick fix pushed straight to the line')
      point('release/0.9', sh('rev-parse', 'HEAD'))
      try {
        const r = plan(PATCH, '0.9.2')
        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(/didn't come in through a PR.*quick fix pushed straight/)
      } finally {
        sh('tag', '-d', 'v0.9.1')
        point('release/0.9', s.m1)
      }
    })

    it('creates the line for v0.8.0 (released before lines) and stops', () => {
      const r = plan(PATCH, '0.8.1')
      expect(r.stderr).toBe('')
      expect(out(r)).toMatchObject({ mode: 'line-only', line: 'release/0.8', from_tag: 'v0.8.0', sha: s.v080 })
      expect(out(r).summary).toMatch(/Created release\/0\.8 at v0\.8\.0/)
    })

    it('refuses a mismatched version with the right one', () => {
      expect(plan(MINOR, '0.11.0').stderr).toMatch(/The next minor version is 0\.10\.0/)
      expect(plan(UPDATE, '0.9.0').stderr).toMatch(/already shipped.*0\.9\.1/)
    })
  })

  describe('prs', () => {
    it("for X.Y.0: main's merges since the previous release, up to the cut, plus the line's", () => {
      // #13 merged to main after the cut, so it belongs to 0.10.0; #33 is the release PR.
      const r = run('prs', { VERSION: '0.9.0', SHA: s.b57, MAIN: s.main })
      expect(r.status).toBe(0)
      expect(numbers(r)).toEqual([12, 57])
    })

    it("for a patch: the line's changes since the previous release, squash merges included", () => {
      const r = run('prs', { VERSION: 'v0.9.1', SHA: s.b58, MAIN: s.main })
      expect(r.status).toBe(0)
      expect(numbers(r)).toEqual([58])
    })

    it('for the next minor: everything merged to main since the previous line was cut', () => {
      const r = run('prs', { VERSION: '0.10.0', SHA: s.main, MAIN: s.main })
      expect(r.status).toBe(0)
      expect(numbers(r)).toEqual([13, 14, 15])
    })
  })

  describe('source', () => {
    const withLine = (sha, fn) => {
      point('release/0.9', sha)
      try {
        return fn()
      } finally {
        point('release/0.9', s.m1)
      }
    }

    it('ships the updated v0.9.0 release commit, not the superseded one', () => {
      sh('tag', '-d', 'v0.9.0')
      try {
        const r = withLine(s.m0u, () => run('source', { VERSION: 'v0.9.0' }))
        expect(r.stderr).toBe('')
        expect(out(r)).toEqual({ version: '0.9.0', sha: s.r0u, line: 'release/0.9', latest: 'true' })
      } finally {
        sh('tag', 'v0.9.0', s.r0u)
      }
    })

    it('refuses to ship v0.9.0 while a change merged after its release PR is unannounced', () => {
      sh('tag', '-d', 'v0.9.0')
      try {
        const r = withLine(s.b57, () => run('source', { VERSION: '0.9.0' }))
        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(/#57.*Update pending release/)
      } finally {
        sh('tag', 'v0.9.0', s.r0u)
      }
    })

    it('ships the patch, and lets a tagged release re-run despite later merges', () => {
      const r = run('source', { VERSION: '0.9.1' })
      expect(r.stderr).toBe('')
      expect(out(r)).toEqual({ version: '0.9.1', sha: s.r1, line: 'release/0.9', latest: 'true' })
      expect(run('source', { VERSION: '0.9.0' }).status).toBe(0)
    })

    // A release PR for 0.9.2 cut from the line's tip, with `options` changing what it carries.
    const shipBad = (n, options) => {
      sh('checkout', '-q', '-B', `bad-${n}`, s.m1)
      const merge = pr(n, 'release-pr/v0.9.2', `bad-${n}`, releaseCommit('0.9.2', s.m1, options))
      return withLine(merge, () => run('source', { VERSION: '0.9.2' }))
    }

    it('refuses a release PR carrying code beyond the bump and notes', () => {
      const r = shipBad(61, { extra: () => write('sneaky.txt', 'x\n') })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/sneaky\.txt/)
    })

    it('refuses a dependency smuggled into the version bump', () => {
      const r = shipBad(62, { extra: () => write('package.json', pkg('0.9.2', { evil: '1.0.0' })) })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/package\.json or package-lock\.json beyond the version/)
    })

    it('refuses release notes whose summary fails the check', () => {
      const r = shipBad(63, { summary: 'no full stop here' })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/release notes: .*complete sentence/)
    })

    it('ships a clean 0.9.2 release PR (the control for the three refusals above)', () => {
      const r = shipBad(65, {})
      expect(r.stderr).toBe('')
      expect(out(r)).toMatchObject({ version: '0.9.2', latest: 'true' })
    })

    it('refuses a release PR merged while behind the line, which would leave a fix unshipped', () => {
      // v0.9.2 is cut at the line's tip, a fix (#66) then merges to the line, and the release
      // PR merges without being updated: #66 is on the line but not in the release commit.
      sh('checkout', '-q', '-B', 'behind', s.m1)
      pr(66, 'backport/0.9/pr-66', 'behind', feature(66))
      const merge = pr(67, 'release-pr/v0.9.2', 'behind', releaseCommit('0.9.2', s.m1), s.m1)
      const r = withLine(merge, () => run('source', { VERSION: '0.9.2' }))
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/merged after v0\.9\.2 was cut that its release PR doesn't include \(#66\)/)
    })

    it('explains a squash-merged release PR', () => {
      sh('checkout', '-q', '-B', 'squashed', s.m1)
      write('package.json', pkg('0.9.2'))
      commit('release: v0.9.2 (#64)')
      const r = withLine(sh('rev-parse', 'HEAD'), () => run('source', { VERSION: '0.9.2' }))
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/squash-merged into release\/0\.9.*Create a merge commit/)
    })

    it('refuses an unknown version, a missing line, and a malformed version', () => {
      expect(run('source', { VERSION: '0.9.5' }).stderr).toMatch(/no merge of release-pr\/v0\.9\.5/)
      expect(run('source', { VERSION: '0.11.0' }).stderr).toMatch(/release\/0\.11 doesn't exist/)
      expect(run('source', { VERSION: '0.9.0;id' }).stderr).toMatch(/isn't a version/)
    })
  })
})

#!/usr/bin/env node
// Which commit a release is, and where it is cut from. Shared by release-prepare.yml and
// release-publish.yml so the two can't drift apart. docs/RELEASING.md describes the process.
//
// The model. Every release ships from its release line, `release/X.Y`:
//   - "Release - prepare" opens a release PR (branch `release-pr/vX.Y.Z`) against the line. Its
//     commit R is the commit it was cut from plus the version bump and the CHANGELOG section,
//     and records that commit in a `Release-Base:` trailer. A new minor or major creates the
//     line from main first.
//   - Until a version is tagged it is pending: fixes reach it as changes merged to its line,
//     and "Update pending release" re-cuts it from the line's tip with regenerated notes.
//   - Once tagged, further fixes are a patch: "Patch a release" cuts the next patch from the
//     line. Any shipped line can be patched; a release from before release lines existed
//     gets its line created at its tag the first time.
//   - "Release - publish" finds the latest merge of `release-pr/vX.Y.Z` on the line (M), takes
//     the PR's own commit R = M^2, and builds, tags and ships exactly R.
//
// Modes:
//   plan    (prepare)  validate the choice and version; print what to cut, from which commit.
//   prs     (prepare)  the PR numbers whose changes the release's notes must describe.
//   source  (publish)  verify the release commit for VERSION; print R and whether it is latest.
//
// Kept as a tested script rather than inline shell because these checks are the boundary
// between "something on a branch" and "the reviewed release commit".

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { changelogProblems } from './check-changelog-summary.mjs'

// X.Y.Z with an optional pre-release suffix. Anchored and character-limited because the value
// ends up in git arguments, branch names, and tag names.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`
const VERSION_RE = new RegExp(`^${VERSION}$`)

/** The only files a release PR may change on top of the commit it was cut from. */
export const RELEASE_FILES = ['CHANGELOG.md', 'package-lock.json', 'package.json']

/** The "What do you want to release?" options, exactly as release-prepare.yml lists them. */
export const CHOICES = {
  'Next minor version': 'minor',
  'Next major version': 'major',
  'Patch a release': 'patch',
  'Update pending release': 'update',
}

/** True when `v` is a plain release version (no `v` prefix). */
export function isVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v)
}

/** A typed version with an optional leading `v`, as a stable X.Y.Z, or null. */
export function normalizeVersion(input) {
  const v = String(input ?? '').trim().replace(/^v/, '')
  return isVersion(v) && !v.includes('-') ? v : null
}

function parse(version) {
  const [core, pre] = version.split('-', 2)
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre: pre ?? null }
}

/** The release line a version ships from: `release/X.Y`. */
export function lineFor(version) {
  const { major, minor } = parse(version)
  return `release/${major}.${minor}`
}

/** Semver precedence: negative when a < b. Pre-release identifiers compare per semver 2.0. */
export function compareVersions(a, b) {
  const x = parse(a)
  const y = parse(b)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1
    if (ys[i] === undefined) return 1
    const xn = /^\d+$/.test(xs[i])
    const yn = /^\d+$/.test(ys[i])
    if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) - Number(ys[i])
    if (xn !== yn) return xn ? -1 : 1
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1
  }
  return 0
}

/** Stable release versions among `v*` tags, highest first. */
export function stableVersions(tags) {
  return tags
    .filter((t) => /^v/.test(t) && isVersion(t.slice(1)) && parse(t.slice(1)).pre === null)
    .map((t) => t.slice(1))
    .sort((a, b) => compareVersions(b, a))
}

/**
 * Whether `version` should be marked the latest release, given every existing `v*` tag. Only
 * the highest stable version is latest: a pre-release never is, and neither is a patch to an
 * older line published after a newer release (the updater follows `latest`, so marking it would
 * offer that older line to everyone).
 */
export function isLatest(version, tags) {
  if (parse(version).pre !== null) return false
  return stableVersions(tags).every((v) => compareVersions(v, version) <= 0)
}

function bump(version, part) {
  const { major, minor, patch } = parse(version)
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const sameLine = (a, b) => parse(a).major === parse(b).major && parse(a).minor === parse(b).minor

/**
 * Validate a "Release - prepare" request and decide what it does.
 *   choice       one of the CHOICES labels
 *   version      what the person typed (a leading `v` is fine)
 *   tags         every v* tag
 *   lines        existing release line branches (release/X.Y)
 *   pending      versions in progress: a release-pr/v* branch exists, or a line's tip carries
 *                the version untagged
 *   mainVersion  package.json on main, used only before the first tagged release
 * Returns { mode, version, line, createLine, fromTag } where mode is minor | major | patch |
 * update | line-only. Throws with a message for the person who ran it.
 */
export function planPrepare({ choice, version: typed, tags, lines, pending, mainVersion }) {
  const mode = CHOICES[choice]
  if (!mode) throw new Error(`Unknown choice "${choice}".`)
  const version = normalizeVersion(typed)
  if (!version) throw new Error(`"${typed ?? ''}" isn't a version. Type it as X.Y.Z, for example 0.10.0.`)

  const released = stableVersions(tags)
  const known = [...new Set([...released, ...pending])].sort((a, b) => compareVersions(b, a))
  const line = lineFor(version)

  if (mode === 'minor' || mode === 'major') {
    const next = bump(known[0] ?? mainVersion, mode)
    if (version !== next) throw new Error(`The next ${mode} version is ${next}.`)
    if (lines.includes(line)) {
      throw new Error(`${line} already exists but v${version} isn't pending there. If it was abandoned, delete the branch first.`)
    }
    return { mode, version, line, createLine: true, fromTag: null }
  }

  if (mode === 'patch') {
    if (parse(version).patch === 0) throw new Error(`A patch version ends in a number above 0, like ${bump(version, 'patch')}.`)
    const shipped = released.filter((v) => sameLine(v, version))
    if (!shipped.length) throw new Error(`Nothing has shipped on ${line.replace('release/', '')} yet, so there's nothing to patch.`)
    const next = bump(shipped[0], 'patch')
    const inProgress = pending.find((v) => sameLine(v, version))
    if (inProgress) throw new Error(`v${inProgress} is pending on ${line}. Use "Update pending release" with ${inProgress}.`)
    if (version !== next) throw new Error(`The next patch of ${shipped[0].replace(/\.\d+$/, '')} is ${next}.`)
    if (!lines.includes(line)) return { mode: 'line-only', version, line, createLine: true, fromTag: `v${shipped[0]}` }
    return { mode, version, line, createLine: false, fromTag: null }
  }

  // update
  if (released.includes(version)) {
    const next = bump(released.filter((v) => sameLine(v, version))[0], 'patch')
    throw new Error(`v${version} already shipped. To fix it, choose "Patch a release" with ${next}.`)
  }
  if (!pending.includes(version)) throw new Error(`v${version} isn't pending. Prepare it first.`)
  if (!lines.includes(line)) throw new Error(`${line} doesn't exist, so v${version} has nothing to update from.`)
  return { mode, version, line, createLine: false, fromTag: null }
}

// Subjects of the automation's own commits, which never appear in release notes.
const AUTOMATION_BRANCH = /^(release-pr|release-sync)\//
const AUTOMATION_SUBJECT = /^(release: v\d|chore\(release\): )/

/**
 * The PR number a first-parent commit brought in, or null: a merge commit ("Merge pull request
 * #N from owner/branch") or a squash commit ("Title (#N)"). The automation's own release and
 * changelog-sync commits are not changes to announce.
 */
export function prNumberFromSubject(subject) {
  const s = subject ?? ''
  const merge = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/.exec(s)
  if (merge) return AUTOMATION_BRANCH.test(merge[2]) ? null : Number(merge[1])
  const squash = /\(#(\d+)\)$/.exec(s)
  if (squash && !AUTOMATION_SUBJECT.test(s)) return Number(squash[1])
  return null
}

/** True for a first-parent commit that came in through a PR (a merge or a squash). */
export function isPrCommit(subject) {
  const s = subject ?? ''
  return /^Merge pull request #\d+ from /.test(s) || /\(#\d+\)$/.test(s)
}

/**
 * The version a commit subject releases, or null. Matches only the merge-commit subject GitHub
 * writes for a PR from `<owner>/release-pr/vX.Y.Z`, so a PR from any other branch, or a fork,
 * never counts as a release.
 */
export function releaseVersionFromSubject(subject, owner) {
  if (typeof subject !== 'string' || !owner) return null
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^Merge pull request #\\d+ from ${escaped}/release-pr/v(${VERSION})$`).exec(subject)
  return m ? m[1] : null
}

/**
 * Whether a release PR's change to package.json / package-lock.json is the version bump and
 * nothing else: the two documents must be equal once their version fields are removed. Anything
 * else (a dependency added in review, say) would ship without having been gated.
 */
export function versionOnlyChange(file, before, after) {
  const strip = (text) => {
    const doc = JSON.parse(text)
    delete doc.version
    if (file === 'package-lock.json' && doc.packages?.['']) delete doc.packages[''].version
    return JSON.stringify(doc)
  }
  try {
    return strip(before) === strip(after)
  } catch {
    return false
  }
}

/**
 * Problems that stop "Release - publish" from shipping `version`; empty when it may ship.
 * `release` describes what was found on the line:
 *   found          a merge of release-pr/v<version> exists on the line's first-parent history
 *   squashed       instead, the release PR was squash-merged (its commit subject was found)
 *   sha            R, the release PR's own commit
 *   packageVersion package.json at R
 *   bases          the distinct Release-Base trailers on the release PR's commits
 *   baseIsAncestor the recorded base is an ancestor of R
 *   changedFiles   files that differ between the base and R
 *   jsonOk         package.json / package-lock.json differ only in their version fields
 *   skipped        changes merged to the line after the cut but before the release merge,
 *                  which the release commit doesn't contain (PR numbers, or short SHAs)
 *   later          commits on the line after the release merge (PR numbers, or short SHAs)
 *   tagCommit      the commit v<version> already names, or null
 *   notes          problems with R's CHANGELOG section for <version>
 */
export function releaseProblems(version, line, release) {
  if (!release.found) {
    if (release.squashed) {
      return [
        `the v${version} release PR was squash-merged into ${line}, so there is no release commit to ship. ` +
          `Revert that commit on ${line}, then merge the release PR again with "Create a merge commit".`,
      ]
    }
    return [`no merge of release-pr/v${version} on ${line}. Run "Release - prepare" and merge its PR first.`]
  }
  const problems = []
  if (release.packageVersion !== version) {
    problems.push(`package.json at the release commit is ${release.packageVersion}, not ${version}.`)
  }
  if (release.bases.length !== 1) {
    problems.push(
      `the release PR must record exactly one Release-Base trailer, found ${release.bases.length}. Run "Update pending release".`,
    )
  } else {
    if (!release.baseIsAncestor) problems.push(`the recorded Release-Base ${release.bases[0]} is not an ancestor of the release commit.`)
    const extra = release.changedFiles.filter((f) => !RELEASE_FILES.includes(f))
    if (extra.length) {
      problems.push(
        `the release PR changes files beyond the version bump and CHANGELOG (${extra.join(', ')}). ` +
          'It was rebased or updated with other changes; run "Update pending release" instead.',
      )
    }
    if (!release.jsonOk) {
      problems.push('the release PR changes package.json or package-lock.json beyond the version. Run "Update pending release".')
    }
  }
  for (const p of release.notes) problems.push(`release notes: ${p}. Fix the v${version} section in the release PR.`)
  if (release.tagCommit && release.tagCommit !== release.sha) {
    problems.push(`v${version} already names ${release.tagCommit}, not the release commit ${release.sha}.`)
  }
  if (!release.tagCommit && release.skipped.length) {
    problems.push(
      `${line} has changes merged after v${version} was cut that its release PR doesn't include (${release.skipped.join(', ')}). ` +
        `They wouldn't ship, and the notes don't mention them: run "Release - prepare" with "Update pending release" and ${version}.`,
    )
  }
  if (!release.tagCommit && release.later.length) {
    problems.push(
      `${line} has changes merged after the v${version} release PR (${release.later.join(', ')}). ` +
        `They would ship unannounced: run "Release - prepare" with "Update pending release" and ${version}.`,
    )
  }
  return problems
}

// ---- git helpers (CLI only) ----

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}
const lines = (text) => (text ? text.split('\n').filter(Boolean) : [])
const allTags = () => lines(git('tag', '--list', 'v*'))
const show = (rev, file) => git('show', `${rev}:${file}`)
const pkgVersion = (rev) => JSON.parse(show(rev, 'package.json')).version
const remote = (branch) => `refs/remotes/origin/${branch}`

// refs/remotes/origin/release/0.9 -> release/0.9
function branchesUnder(prefix) {
  return lines(git('for-each-ref', '--format=%(refname:strip=3)', `refs/remotes/origin/${prefix}`))
}

/** Versions in progress: a release-pr branch exists, or a line's tip carries them untagged. */
function pendingVersions(lineNames, tags) {
  const released = stableVersions(tags)
  const fromBranches = branchesUnder('release-pr/')
    .map((b) => normalizeVersion(b.replace(/^release-pr\//, '')))
    .filter(Boolean)
  const fromTips = lineNames.map((l) => pkgVersion(remote(l))).filter((v) => normalizeVersion(v))
  return [...new Set([...fromBranches, ...fromTips])].filter((v) => !released.includes(v))
}

/** First-parent commits in `range`, oldest first, as { sha, subject }. */
function firstParent(range) {
  return lines(git('log', '--reverse', '--first-parent', '--format=%H %s', range)).map((l) => ({
    sha: l.slice(0, 40),
    subject: l.slice(41),
  }))
}

/** Problems with commits on a line that skipped a PR (a rebase merge or a direct push). */
function bypassProblems(line, commits) {
  const bad = commits.filter((c) => !isPrCommit(c.subject))
  if (!bad.length) return []
  return [
    `${line} has commits that didn't come in through a PR merge or squash (${bad.map((c) => `${c.sha.slice(0, 9)} "${c.subject}"`).join(', ')}). ` +
      'Revert them on the line and bring the change in through a PR merged with "Create a merge commit" or "Squash and merge".',
  ]
}

/** A first-parent commit as its PR number (`#57`), or a short SHA when it has none. */
function commitLabel(commit) {
  const n = prNumberFromSubject(commit.subject)
  return n === null ? commit.sha.slice(0, 9) : `#${n}`
}

/** The latest release merge for `version` on `line`, or null. */
function releaseMerge(line, version, owner) {
  const merges = lines(git('log', '--first-parent', '--merges', '--format=%H %s', remote(line)))
  const hit = merges.find((l) => releaseVersionFromSubject(l.slice(41), owner) === version)
  return hit ? hit.slice(0, 40) : null
}

/** The Release-Base recorded on the release commit(s) between `from` (exclusive) and `to`. */
function recordedBases(from, to) {
  return [...new Set(lines(git('log', '--format=%(trailers:key=Release-Base,valueonly)', `${from}..${to}`)))]
}

function fail(problems) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}

function output(pairs) {
  process.stdout.write(Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

// `plan`: env CHOICE, VERSION, MAIN_SHA (the commit the run was dispatched on),
// GITHUB_REPOSITORY_OWNER. Needs full history, tags, and origin/release/* and
// origin/release-pr/* fetched. Prints mode, version, line, create_line, from_tag, sha (the
// commit every prepare job verifies and the release PR is cut from) and summary.
function plan(env) {
  const tags = allTags()
  const lineNames = branchesUnder('release/').filter((b) => /^release\/\d+\.\d+$/.test(b))
  const p = planPrepare({
    choice: env.CHOICE,
    version: env.VERSION,
    tags,
    lines: lineNames,
    pending: pendingVersions(lineNames, tags),
    mainVersion: pkgVersion(env.MAIN_SHA),
  })

  let sha
  let summary
  if (p.mode === 'minor' || p.mode === 'major') {
    sha = env.MAIN_SHA
    summary = `Cutting v${p.version} (next ${p.mode}) from main into a new ${p.line} branch.`
  } else if (p.mode === 'line-only') {
    sha = git('rev-parse', `refs/tags/${p.fromTag}^{commit}`)
    summary = `Created ${p.line} at ${p.fromTag}. Merge your fixes into it, then run "Patch a release" with ${p.version} again.`
  } else if (p.mode === 'patch') {
    sha = git('rev-parse', remote(p.line))
    const previous = stableVersions(tags).find((v) => sameLine(v, p.version))
    const commits = firstParent(`refs/tags/v${previous}^{commit}..${sha}`)
    const problems = bypassProblems(p.line, commits)
    if (problems.length) fail(problems)
    const changes = commits.map((c) => prNumberFromSubject(c.subject)).filter((n) => n !== null)
    if (!changes.length) fail([`Nothing merged to ${p.line} since v${previous}, so there's nothing to patch.`])
    summary = `Starting patch v${p.version} from ${p.line}: ${changes.map((n) => `#${n}`).join(', ')}.`
  } else {
    sha = git('rev-parse', remote(p.line))
    // The cut being replaced: an open release PR's own commits (everything on its branch that
    // the line doesn't have), or a merged one's (between the merge's parents).
    const open = tryGit('rev-parse', '--verify', '--quiet', remote(`release-pr/v${p.version}`))
    const merge = releaseMerge(p.line, p.version, env.GITHUB_REPOSITORY_OWNER)
    const bases = open
      ? recordedBases(remote(p.line), open)
      : merge
        ? recordedBases(`${merge}^1`, `${merge}^2`)
        : []
    if (bases.length !== 1) fail([`Couldn't find where v${p.version} was cut. Close its PR, delete its branches, and prepare it again.`])
    const commits = firstParent(`${bases[0]}..${sha}`)
    const problems = bypassProblems(p.line, commits)
    if (problems.length) fail(problems)
    const changes = commits.map((c) => prNumberFromSubject(c.subject)).filter((n) => n !== null)
    // No new merges is fine: the re-cut still regenerates the notes (for example after publish
    // refused a summary that a merged release PR got wrong).
    summary = changes.length
      ? `Updating pending v${p.version} from ${p.line}: ${changes.map((n) => `#${n}`).join(', ')} since it was cut.`
      : `Updating pending v${p.version} from ${p.line}: no new merges since it was cut, so only the notes are regenerated.`
  }
  output({ mode: p.mode, version: p.version, line: p.line, create_line: p.createLine, from_tag: p.fromTag ?? '', sha, summary })
}

/** PR numbers brought in by the first-parent commits in `range`. */
function prsIn(range) {
  return firstParent(range)
    .map((c) => prNumberFromSubject(c.subject))
    .filter((n) => n !== null)
}

// `prs`: env VERSION, SHA (the commit being cut), MAIN (main's ref). Prints the PR numbers the
// notes for VERSION describe, in ascending order:
//   X.Y.0  main's merges since the previous release's cut, up to this line's cut, plus the
//          line's own merges after its cut (changes merged before the release shipped).
//   X.Y.Z  the line's merges since the previous release on it.
function prs(env) {
  const version = normalizeVersion(env.VERSION)
  if (!version) fail([`"${env.VERSION ?? ''}" isn't a version.`])
  const { SHA: sha, MAIN: main } = env
  const tags = allTags()
  let numbers
  if (parse(version).patch === 0) {
    const cut = git('merge-base', main, sha)
    const previous = stableVersions(tags).find((v) => compareVersions(v, version) < 0)
    const since = previous ? git('merge-base', main, `refs/tags/v${previous}^{commit}`) : null
    numbers = [...prsIn(since ? `${since}..${cut}` : cut), ...prsIn(`${cut}..${sha}`)]
  } else {
    const previous = stableVersions(tags).find((v) => sameLine(v, version) && compareVersions(v, version) < 0)
    if (!previous) fail([`no earlier ${lineFor(version).replace('release/', '')} release to patch.`])
    numbers = prsIn(`refs/tags/v${previous}^{commit}..${sha}`)
  }
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  process.stdout.write(unique.join('\n') + (unique.length ? '\n' : ''))
}

// `source`: env VERSION, GITHUB_REPOSITORY_OWNER. Needs full history, tags, and
// origin/release/* fetched. Prints version, sha (R), line and latest, or fails with the problems.
function source(env) {
  const version = normalizeVersion(env.VERSION)
  if (!version) fail([`"${env.VERSION ?? ''}" isn't a version. Type it as X.Y.Z, for example 0.10.0.`])
  const line = lineFor(version)
  if (!tryGit('rev-parse', '--verify', '--quiet', remote(line))) fail([`${line} doesn't exist; prepare v${version} first.`])

  const merge = releaseMerge(line, version, env.GITHUB_REPOSITORY_OWNER)
  const release = { found: Boolean(merge) }
  if (!merge) {
    const squash = new RegExp(`^release: v${version.replace(/\./g, '\\.')} \\(#\\d+\\)$`)
    release.squashed = firstParent(remote(line)).some((c) => squash.test(c.subject))
  } else {
    const sha = git('rev-parse', `${merge}^2`)
    const bases = recordedBases(`${merge}^1`, sha)
    const base = bases.length === 1 ? bases[0] : null
    const changedFiles = base ? lines(git('diff', '--name-only', base, sha)) : []
    const jsonOk = ['package.json', 'package-lock.json']
      .filter((f) => changedFiles.includes(f))
      .every((f) => versionOnlyChange(f, show(base, f), show(sha, f)))
    Object.assign(release, {
      sha,
      packageVersion: pkgVersion(sha),
      bases,
      baseIsAncestor: Boolean(base) && tryGit('merge-base', '--is-ancestor', base, sha) !== null,
      changedFiles,
      jsonOk,
      // Merged to the line while the release PR was open, without updating it: in the line's
      // history but not in R. Pending versions own everything merged to their line.
      skipped: base ? firstParent(`${base}..${merge}^1`).map(commitLabel) : [],
      later: firstParent(`${merge}..${remote(line)}`).map(commitLabel),
      tagCommit: tryGit('rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`),
      notes: changelogProblems(show(sha, 'CHANGELOG.md'), version),
    })
  }
  const problems = releaseProblems(version, line, release)
  if (problems.length) fail(problems)
  output({ version, sha: release.sha, line, latest: isLatest(version, allTags()) })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2]
  try {
    if (mode === 'plan') plan(process.env)
    else if (mode === 'prs') prs(process.env)
    else if (mode === 'source') source(process.env)
    else {
      console.error('usage: release-source.mjs plan|prs|source')
      process.exit(2)
    }
  } catch (err) {
    fail([err.message])
  }
}

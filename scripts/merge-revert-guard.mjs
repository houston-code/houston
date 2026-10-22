#!/usr/bin/env node
// Merge revert-guard: fail a merge that would silently REVERT content already on the
// merge target (main), the failure mode behind the #551 incident. That PR's branch was
// finalized with `git reset --soft origin/main` against a stale tree, so its merge
// recorded the *absence* of three freshly-merged PRs (#548/#549/#550) as deletions —
// ~3,200 lines and 8 files removed — and CI stayed green because the reverted features'
// tests were removed in the same commit.
//
// Git graph analysis alone cannot tell that apart from an intentional deletion (the
// commit literally says "parent is current main, delete these files"), so this guard
// works on the *shape* of the landing change instead:
//
//   Rule 1 (deletions): the merge deletes a file that exists on the base (main).
//   Rule 2 (recent-content reverts): the merge removes >= LINE_THRESHOLD net lines from a
//           file that main itself touched within the last WINDOW commits — i.e. it rolls
//           back work that landed while this branch was open.
//
// Both are rare in a normal feature PR and are exactly what a stale-tree clobber produces.
// A legitimate removal (deleting dead code, a real revert) sets the override so the intent
// is explicit and on the record rather than silent.
//
// Usage:  node scripts/merge-revert-guard.mjs <baseRef> <resultRef>
//   baseRef    the merge target (e.g. the fetched origin/main)
//   resultRef  the built merge commit/tree that would land (e.g. HEAD after `git merge`)
// When resultRef is a merge commit, the comparison uses its FIRST PARENT, the base the
// merge was actually built on, rather than baseRef (see landingBase).
// Override: set ALLOW_REVERT=1 (wired to an `intentional-revert` PR label in CI).
// DEPENDENCY_UPDATE=1 (wired to Dependabot-authored PRs in CI) exempts the generated
// dependency files from Rule 2; see GENERATED_DEPENDENCY_FILES.
// Exit 0 = clean or overridden; exit 1 = a revert was detected and must be confirmed.

import { execFileSync } from 'node:child_process'

const LINE_THRESHOLD = 30 // net lines removed from a single file to count as a content revert
const WINDOW = 40 // how many recent main commits count as "work that landed while this branch was open"

// Files derived entirely from the dependency tree. A dependency update that prunes
// transitive packages shrinks both by hundreds of lines, and since nearly every dependency
// PR touches them they are always "recent", so Rule 2 flags every such bump as a revert
// (mermaid 11.4 -> 11.17 drops ~30 packages). Dependabot builds its branch from the
// current base, so it cannot carry a stale tree; on its PRs these two files are exempt
// from Rule 2. Rule 1 and every other file stay guarded, and on human PRs nothing changes.
export const GENERATED_DEPENDENCY_FILES = new Set(['package-lock.json', 'THIRD-PARTY-NOTICES.md'])

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd })
}

/** Like git(), but never leaks git's own stderr (used for existence probes that are
 *  EXPECTED to fail for a missing path — `cat-file -e` prints a fatal on a real worktree). */
function gitQuiet(args, cwd) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    cwd
  })
}

/** Files that `base` gained or changed within its last {@link WINDOW} commits. */
function recentlyTouchedOnMain(base, cwd) {
  const out = git(['log', `-n${WINDOW}`, '--name-only', '--pretty=format:', base], cwd)
  return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))
}

/** True when a file exists in a tree-ish. Probes are expected to fail for a missing
 *  path, so stderr is suppressed to keep the CI log clean. */
function existsAt(ref, file, cwd) {
  try {
    gitQuiet(['cat-file', '-e', `${ref}:${file}`], cwd)
    return true
  } catch {
    return false
  }
}

export function findReverts(base, result, deps = {}) {
  const numstat = (deps.git ?? ((args) => git(args, deps.cwd)))(['diff', '--numstat', `${base}`, `${result}`])
  const recent = deps.recent ?? recentlyTouchedOnMain(base, deps.cwd)
  const exists = deps.exists ?? ((f) => existsAt(base, f, deps.cwd))
  const dependencyUpdate = deps.dependencyUpdate ?? false
  const deletions = []
  const contentReverts = []
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [addRaw, delRaw, ...pathParts] = line.split('\t')
    const file = pathParts.join('\t')
    if (!file) continue
    if (addRaw === '-' || delRaw === '-') continue // binary; skip
    const added = Number(addRaw)
    const removed = Number(delRaw)
    // Rule 1: the merge removed a file that exists on main.
    if (added === 0 && removed > 0 && !existsInResult(result, file, deps)) {
      if (exists(file)) deletions.push({ file, removed })
      continue
    }
    // Rule 2: a large net line-loss in a file main touched recently.
    if (dependencyUpdate && GENERATED_DEPENDENCY_FILES.has(file)) continue
    if (removed - added >= LINE_THRESHOLD && recent.has(file)) {
      contentReverts.push({ file, net: removed - added })
    }
  }
  return { deletions, contentReverts }
}

function existsInResult(result, file, deps) {
  const exists = deps.existsInResult ?? ((r, f) => existsAt(r, f, deps.cwd))
  return exists(result, file)
}

/** The parent commits of `ref`, in order (empty for a root commit). */
function parentsOf(ref, cwd) {
  return git(['rev-list', '--parents', '-n1', ref], cwd).trim().split(/\s+/).slice(1)
}

/**
 * The base a landing merge was actually built on: the merge commit's first parent, or
 * `base` when the result isn't a merge.
 *
 * On a PR, CI checks out `refs/pull/N/merge`, which GitHub computes when the PR or its
 * base changes, not when the job runs. The base fetched at job time can be newer, and
 * every file it gained since then is absent from that merge, so a plain base-vs-result
 * diff reports each one as a deletion. That fails PRs whose CI waited in a queue, and the
 * upper PRs of a stack constantly, though none of them removes anything. The merge's own
 * first parent has exactly the base it was built against. It still catches the #551
 * shape: a stale tree committed on top of main merges to that stale tree, and its
 * deletions show against the first parent just as they do against the tip.
 */
export function landingBase(base, parents) {
  return parents.length >= 2 ? parents[0] : base
}

/** Run the guard on a landing merge: pick its real base, then look for reverts. */
export function checkMerge(base, result, opts = {}) {
  const parents = opts.parents ?? parentsOf(result, opts.cwd)
  const compareTo = landingBase(base, parents)
  const report = findReverts(compareTo, result, {
    cwd: opts.cwd,
    dependencyUpdate: opts.dependencyUpdate ?? false
  })
  return { compareTo, ...report }
}

function main() {
  const [, , base, result] = process.argv
  if (!base || !result) {
    console.error('usage: merge-revert-guard.mjs <baseRef> <resultRef>')
    process.exit(2)
  }
  const { compareTo, deletions, contentReverts } = checkMerge(base, result, {
    dependencyUpdate: process.env.DEPENDENCY_UPDATE === '1'
  })
  if (compareTo !== base) {
    console.log(`revert-guard: comparing against ${compareTo}, the base this merge was built on.`)
  }
  if (deletions.length === 0 && contentReverts.length === 0) {
    console.log('revert-guard: clean — the merge does not roll back existing main content.')
    process.exit(0)
  }

  console.error('::error::revert-guard: this merge would REVERT content already on main.')
  if (deletions.length) {
    console.error(`\nFiles the merge DELETES that still exist on main (${deletions.length}):`)
    for (const d of deletions) console.error(`  - ${d.file}  (-${d.removed})`)
  }
  if (contentReverts.length) {
    console.error(`\nFiles the merge rolls back that main touched recently (${contentReverts.length}):`)
    for (const c of contentReverts) console.error(`  - ${c.file}  (net -${c.net})`)
  }
  if (process.env.ALLOW_REVERT === '1') {
    console.error(
      '\nALLOW_REVERT=1 (intentional-revert label) set — proceeding. The removal is now on the record.'
    )
    process.exit(0)
  }
  console.error(
    '\nThis is the #551 stale-tree clobber signature. If the branch is stale, rebase it onto the\n' +
      'latest main and re-verify (a rebase preserves files it does not touch; a reset-then-commit\n' +
      'of a stale tree does not). If the removal is genuinely intended, add the `intentional-revert`\n' +
      'label to acknowledge it. See AGENTS.md > "Avoiding silent-clobber merges".'
  )
  process.exit(1)
}

// Only run main() as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) main()

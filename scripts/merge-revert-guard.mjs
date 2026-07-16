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
//   baseRef    the merge target as it is NOW (e.g. the fetched origin/main)
//   resultRef  the built merge commit/tree that would land (e.g. HEAD after `git merge`)
// Override: set ALLOW_REVERT=1 (wired to an `intentional-revert` PR label in CI).
// Exit 0 = clean or overridden; exit 1 = a revert was detected and must be confirmed.

import { execFileSync } from 'node:child_process'

const LINE_THRESHOLD = 30 // net lines removed from a single file to count as a content revert
const WINDOW = 40 // how many recent main commits count as "work that landed while this branch was open"

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Like git(), but never leaks git's own stderr (used for existence probes that are
 *  EXPECTED to fail for a missing path — `cat-file -e` prints a fatal on a real worktree). */
function gitQuiet(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024
  })
}

/** Files that `base` gained or changed within its last {@link WINDOW} commits. */
function recentlyTouchedOnMain(base) {
  const out = git(['log', `-n${WINDOW}`, '--name-only', '--pretty=format:', base])
  return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))
}

/** True when a file exists in a tree-ish. Probes are expected to fail for a missing
 *  path, so stderr is suppressed to keep the CI log clean. */
function existsAt(ref, file) {
  try {
    gitQuiet(['cat-file', '-e', `${ref}:${file}`])
    return true
  } catch {
    return false
  }
}

export function findReverts(base, result, deps = {}) {
  const numstat = (deps.git ?? git)(['diff', '--numstat', `${base}`, `${result}`])
  const recent = deps.recent ?? recentlyTouchedOnMain(base)
  const exists = deps.exists ?? ((f) => existsAt(base, f))
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
    if (removed - added >= LINE_THRESHOLD && recent.has(file)) {
      contentReverts.push({ file, net: removed - added })
    }
  }
  return { deletions, contentReverts }
}

function existsInResult(result, file, deps) {
  const exists = deps.existsInResult ?? ((r, f) => existsAt(r, f))
  return exists(result, file)
}

function main() {
  const [, , base, result] = process.argv
  if (!base || !result) {
    console.error('usage: merge-revert-guard.mjs <baseRef> <resultRef>')
    process.exit(2)
  }
  const { deletions, contentReverts } = findReverts(base, result)
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
      'label to acknowledge it. See CLAUDE.md > "Avoiding silent-clobber merges".'
  )
  process.exit(1)
}

// Only run main() as a CLI, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) main()

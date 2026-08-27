#!/usr/bin/env node
// Decide whether a PR's changed files can possibly affect the app.
//
// The four required checks cost about seven minutes of wall clock (`test` ~3m30s, then
// `build` ~3m10s serialized behind it, plus `linux-sandbox`), and every merge to main
// invalidates the up-to-date requirement on every other open PR, so that cost is paid
// again on each rebase. A one-line change to the marketing site was paying it in full
// while being covered by none of it.
//
// SAFETY MODEL. A job skipped by an `if:` conditional reports its required check as a
// PASS, so a wrong answer here does not turn a check red — it lets an untested change
// merge. That makes this file security-relevant, and it is why the rule is an ALLOWLIST
// that must match EVERY changed path, with three deliberate biases:
//
//   1. A path is inert only if it is named here. Anything unrecognised, including a new
//      top-level file, means "run everything".
//   2. An empty or unreadable file list means "run everything". A diff that failed to
//      compute must never read as "nothing to do".
//   3. Directories that mostly hold inert content still carve out the parts that are
//      not (`website/tools/**` has tests; `docs/houston-guide.md` is compiled into the
//      agent's prompt and pinned by goldens).
//
// Each entry below is justified against what the jobs actually read. Re-verify when
// adding one: the question is not "is this a doc?" but "does any lint, typecheck, test,
// packaging step, or generated artifact consume this path?"

/**
 * Exact files that no job consumes.
 *
 * Verified: `eslint.config.mjs` ignores `website/**`, no tsconfig includes these, the
 * vitest `node` project includes only `website/tools/**` out of the site, and
 * electron-builder packages none of them.
 *
 * Deliberately ABSENT, because something does consume them:
 *   THIRD-PARTY-NOTICES.md — the `test` job regenerates and diffs it, so a hand edit
 *     must be caught rather than skipped past.
 *   LICENSE, NOTICE — read by the license-gate and notices suites.
 *   docs/houston-guide.md — inlined into src/main/agent/guide-content.ts and pinned by
 *     the agent goldens; editing it changes the agent's behavior surface.
 */
export const INERT_FILES = new Set([
  'README.md',
  'ROADMAP.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/PRIVACY.md',
  'docs/sandboxing.md',
  '.github/PULL_REQUEST_TEMPLATE.md'
])

/** Directory prefixes whose contents are inert, except for the carve-outs below. */
export const INERT_PREFIXES = ['website/', '.github/ISSUE_TEMPLATE/']

/**
 * Paths that sit inside an INERT_PREFIX but are NOT inert.
 *
 * `website/tools/**` holds real scripts with real tests — the vitest `node` project
 * includes `website/tools/ ** /*.test.mjs` — so a change there must run the suite.
 */
export const CODE_CARVE_OUTS = ['website/tools/']

/** True when this one path cannot affect lint, typecheck, tests, or packaging. */
export function isInertPath(file) {
  if (typeof file !== 'string' || file.length === 0) return false
  // Reject anything that could climb out of the tree or arrive oddly normalized, rather
  // than reasoning about what it would resolve to.
  if (file.includes('..') || file.startsWith('/')) return false
  if (CODE_CARVE_OUTS.some((prefix) => file.startsWith(prefix))) return false
  if (INERT_FILES.has(file)) return true
  return INERT_PREFIXES.some((prefix) => file.startsWith(prefix))
}

/**
 * True when EVERY changed path is inert, so the heavy jobs can be skipped.
 *
 * An empty list returns false on purpose: "no files changed" is far more likely to mean
 * the diff did not compute than to mean a PR genuinely changed nothing, and the safe
 * reading of a failed diff is to run everything.
 */
export function isInertChange(files) {
  if (!Array.isArray(files) || files.length === 0) return false
  return files.every(isInertPath)
}

/* c8 ignore start -- CLI wiring; the decision logic above is what the tests cover. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import('node:child_process')
  const { appendFileSync } = await import('node:fs')

  const base = process.argv[2]
  let inert = false
  let files = []
  try {
    if (!base) throw new Error('no base ref given')
    // `base...HEAD` compares against the merge base, so commits that landed on main
    // while this branch was open are not counted as this PR's changes.
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8'
    })
    files = out.split('\n').filter(Boolean)
    inert = isInertChange(files)
  } catch (err) {
    // Fail open: run the full suite. Never let a broken diff read as "nothing to do".
    console.error(`ci-scope: could not determine changed files (${err.message}); running everything.`)
    inert = false
  }

  console.log(`ci-scope: ${files.length} changed file(s)`)
  for (const file of files) console.log(`  ${isInertPath(file) ? 'inert' : 'CODE '} ${file}`)
  console.log(`ci-scope: inert=${inert}`)
  if (inert) {
    console.log('::notice::Only documentation and website files changed; skipping test, linux-sandbox, and build.')
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `inert=${inert}\n`)
}
/* c8 ignore stop */

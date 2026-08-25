#!/usr/bin/env node
// License gate — fail CI when the dependency tree picks up a license Houston cannot
// redistribute under Apache-2.0, or that would block enterprise adoption of the app
// (AGPL and friends). Apache-2.0 is one-way compatible: it can absorb MIT/ISC/BSD, but
// a copyleft dependency would force its own terms onto the whole distribution. Runs on every
// PR (ci.yml `test` job) against the installed tree, so an accidental transitive
// dependency with a hostile license is caught on the PR that introduces it, never
// on main.
//
// Policy, three tiers:
//
//  1. FORBIDDEN EVERYWHERE (prod + dev, not exceptable): network copyleft and
//     source-available/non-commercial licenses — AGPL, SSPL, BUSL, Elastic,
//     Commons Clause, RSAL, Parity, Prosperity, FSL, CC-BY-NC, Hippocratic.
//     There is never a good reason for one of these to appear anywhere in this
//     repo's tree, so no exception can allow them.
//
//  2. SHIP ALLOWLIST (default-deny for everything that ships): every package in
//     the production closure (`npm ls --omit=dev`) plus the vendored CLI binaries
//     must satisfy the permissive allowlist below. Anything else — GPL/LGPL/MPL,
//     an unrecognized spelling, a missing license field — fails until it is either
//     added to the allowlist (a reviewed policy change) or granted a named
//     exception in license-gate-exceptions.json (a reviewed one-off).
//
//  3. DEV-ONLY REVIEW (warn, non-blocking): a dev-only package outside the
//     allowlist (e.g. a GPL build tool, which is legal to *use*) emits a CI
//     warning so it gets eyes, but does not fail the gate.
//
// Dual licenses are handled semantically: "MIT OR GPL-3.0" is shippable (we take
// the MIT branch), "MIT AND GPL-3.0" is not. For packages that are not cleanly
// allowed, the gate additionally scans the package's LICENSE file text for
// forbidden-license markers, so an UNKNOWN license field can't hide an AGPL text.
//
// Exceptions: scripts/license-gate-exceptions.json — entries of
//   { "name", "license", "closure": "production"|"dev", "reason" }
// matched on the exact reported license string, so a license change on a version
// bump re-triggers review. Unused exceptions fail the gate to keep the file honest.
//
// Run locally with `npm run license-gate` (needs node_modules installed).

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDORED_BINARIES, normalizeLicense, readLicenseText } from './generate-notices.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const EXCEPTIONS_FILE = join(__dirname, 'license-gate-exceptions.json')

// Tier 2: SPDX ids allowed in anything that ships. Exact ids (compared
// case-insensitively), NOT prefixes — "CC-BY-4.0" must not admit "CC-BY-NC-4.0".
// Extending this list is a deliberate policy change; prefer a named exception for
// a one-off package.
export const ALLOWED_TO_SHIP = new Set(
  [
    'MIT',
    'MIT-0',
    'ISC',
    '0BSD',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    'BlueOak-1.0.0',
    'Unlicense',
    'CC0-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'Python-2.0',
    'PSF-2.0',
    'Zlib',
    'WTFPL',
    'BSL-1.0' // Boost Software License (permissive) — NOT BUSL-1.1 (Business Source)
  ].map((s) => s.toUpperCase())
)

// Tier 1: license ids that are forbidden in every closure. Anchored patterns so
// permissive near-misses can't match (BSL-1.0 is Boost, not Business Source).
export const FORBIDDEN_ID_PATTERNS = [
  /^AGPL/i, // AGPL-1.0, AGPL-3.0-only, AGPL-3.0-or-later
  /AFFERO/i,
  /^SSPL/i,
  /^BUSL/i, // Business Source License (BUSL-1.1)
  /^ELASTIC-/i, // Elastic-2.0
  /COMMONS-?CLAUSE/i,
  /^RSAL/i, // Redis Source Available License
  /^PARITY-/i,
  /^PROSPERITY/i,
  /^FSL-/i, // Functional Source License
  /^CC-BY-NC/i, // every NonCommercial Creative Commons variant
  /^HIPPOCRATIC/i,
  /NON-?COMMERCIAL/i
]

// Unambiguous forbidden-license markers for prose: unparseable license fields and
// LICENSE file text. Deliberately narrower than the id patterns — permissive
// license texts routinely contain phrases like "commercial or non-commercial",
// so only full license names that cannot appear innocently are listed.
export const FORBIDDEN_TEXT_PATTERNS = [
  /GNU AFFERO/i,
  /\bAGPL\b/i,
  /SERVER SIDE PUBLIC LICENSE/i,
  /\bSSPL\b/i,
  /BUSINESS SOURCE LICENSE/i,
  /ELASTIC LICENSE/i,
  /COMMONS CLAUSE/i,
  /REDIS SOURCE AVAILABLE LICENSE/i
]

/** True when a single SPDX-ish id is tier-1 forbidden. */
export function isForbiddenId(id) {
  const s = String(id).replace(/\+$/, '')
  return FORBIDDEN_ID_PATTERNS.some((p) => p.test(s))
}

/** True when a single SPDX-ish id is on the ship allowlist. */
export function isAllowedToShipId(id) {
  return ALLOWED_TO_SHIP.has(String(id).replace(/\+$/, '').toUpperCase())
}

/** True when prose (a license file, or an unparseable license field) names a forbidden license. */
export function detectForbiddenText(text) {
  return typeof text === 'string' && FORBIDDEN_TEXT_PATTERNS.some((p) => p.test(text))
}

/**
 * Parse an SPDX-ish license expression ("MIT", "(MIT OR CC0-1.0)",
 * "Apache-2.0 WITH LLVM-exception", "MIT AND Zlib") into a tree of
 * { id, exception? } leaves and { op: 'OR'|'AND', left, right } nodes.
 * Returns null when the string is not a well-formed expression (e.g.
 * "SEE LICENSE IN LICENSE") — callers then fall back to text heuristics.
 */
export function parseLicenseExpression(raw) {
  if (typeof raw !== 'string') return null
  const tokens = raw.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  let pos = 0
  const peek = () => tokens[pos]
  const isKeyword = (t, k) => typeof t === 'string' && t.toUpperCase() === k

  function parseOr() {
    let left = parseAnd()
    if (!left) return null
    while (isKeyword(peek(), 'OR')) {
      pos++
      const right = parseAnd()
      if (!right) return null
      left = { op: 'OR', left, right }
    }
    return left
  }
  function parseAnd() {
    let left = parsePrimary()
    if (!left) return null
    while (isKeyword(peek(), 'AND')) {
      pos++
      const right = parsePrimary()
      if (!right) return null
      left = { op: 'AND', left, right }
    }
    return left
  }
  function parsePrimary() {
    const tok = peek()
    if (tok === undefined) return null
    if (tok === '(') {
      pos++
      const inner = parseOr()
      if (!inner || tokens[pos] !== ')') return null
      pos++
      return inner
    }
    if (tok === ')' || ['AND', 'OR', 'WITH'].includes(tok.toUpperCase())) return null
    pos++
    const node = { id: tok }
    if (isKeyword(peek(), 'WITH')) {
      pos++
      const exc = peek()
      if (exc === undefined || exc === '(' || exc === ')') return null
      pos++
      node.exception = exc
    }
    return node
  }

  const tree = parseOr()
  return tree && pos === tokens.length ? tree : null
}

/**
 * Whether the expression can be satisfied choosing licenses for which pred(id)
 * holds: OR needs one branch, AND needs both. A WITH exception only grants extra
 * permissions, so the leaf is judged by its base id.
 */
export function expressionSatisfies(tree, pred) {
  if (tree.op === 'OR') return expressionSatisfies(tree.left, pred) || expressionSatisfies(tree.right, pred)
  if (tree.op === 'AND') return expressionSatisfies(tree.left, pred) && expressionSatisfies(tree.right, pred)
  return pred(tree.id)
}

/**
 * Classify one reported license string.
 *   'forbidden' — tier 1; fails in every closure and cannot be excepted.
 *   'blocked'   — production package outside the ship allowlist; fails unless excepted.
 *   'review'    — dev-only package outside the allowlist; warns unless excepted.
 *   'ok'        — shippable under the allowlist.
 */
export function classifyLicense(raw, { production }) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  const tree = parseLicenseExpression(s)
  if (tree) {
    // Forbidden only when every way to satisfy the expression uses a forbidden id
    // ("MIT OR AGPL-3.0" is fine — we take MIT; "MIT AND AGPL-3.0" is not).
    if (!expressionSatisfies(tree, (id) => !isForbiddenId(id))) return 'forbidden'
    if (expressionSatisfies(tree, isAllowedToShipId)) return 'ok'
  } else if (detectForbiddenText(s)) {
    // The declared license field itself names a forbidden license in prose.
    return 'forbidden'
  }
  return production ? 'blocked' : 'review'
}

/**
 * Evaluate the whole tree against the policy.
 * entries: [{ name, version, license, production, dir?, source? }]
 * exceptions: parsed license-gate-exceptions.json entries.
 * readLicenseTextFor: entry -> license file text | null (injected for tests);
 * only consulted for entries that are not already 'ok', to upgrade a vague
 * license field to 'forbidden' when the shipped LICENSE text names one.
 * Returns { errors, warnings, unusedExceptions } — errors must fail the gate.
 */
export function evaluatePackages(entries, exceptions = [], { readLicenseTextFor = () => null } = {}) {
  const errors = []
  const warnings = []
  const used = new Set()
  for (const entry of entries) {
    let verdict = classifyLicense(entry.license, { production: entry.production })
    if (verdict === 'ok') continue
    let detail = ''
    if (verdict !== 'forbidden') {
      const text = readLicenseTextFor(entry)
      if (detectForbiddenText(text)) {
        verdict = 'forbidden'
        detail = 'its LICENSE file names a forbidden license'
      }
    }
    if (verdict !== 'forbidden') {
      const closure = entry.production ? 'production' : 'dev'
      const exc = exceptions.find(
        (x) => x.name === entry.name && x.license === entry.license && x.closure === closure
      )
      if (exc) {
        used.add(exc)
        continue
      }
    }
    const item = { ...entry, verdict, detail }
    if (verdict === 'review') warnings.push(item)
    else errors.push(item)
  }
  return { errors, warnings, unusedExceptions: exceptions.filter((x) => !used.has(x)) }
}

/** Validate the exceptions file shape; returns the entries or throws with a clear message. */
export function loadExceptions(json) {
  const list = json && Array.isArray(json.exceptions) ? json.exceptions : null
  if (!list) throw new Error('license-gate-exceptions.json must be { "exceptions": [...] }')
  for (const x of list) {
    for (const field of ['name', 'license', 'closure', 'reason']) {
      if (typeof x[field] !== 'string' || !x[field].trim()) {
        throw new Error(`exception for ${JSON.stringify(x.name || x)} is missing a non-empty "${field}"`)
      }
    }
    if (x.closure !== 'production' && x.closure !== 'dev') {
      throw new Error(`exception for "${x.name}": closure must be "production" or "dev", got "${x.closure}"`)
    }
  }
  return list
}

/** Absolute dirs of every installed package in a closure (project root excluded). */
function closureDirs(omitDev) {
  const args = ['ls', ...(omitDev ? ['--omit=dev'] : []), '--all', '--parseable']
  let out
  try {
    out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // npm ls exits non-zero for tree problems (extraneous/missing peers) but still
    // prints the tree; use what it printed rather than dying on a warning.
    out = err && typeof err.stdout === 'string' ? err.stdout : ''
    if (!out.trim()) throw err
  }
  const dirs = new Set()
  for (const line of out.split('\n')) {
    const d = line.trim()
    if (d && d !== ROOT && d.includes('node_modules')) dirs.add(d)
  }
  return dirs
}

function collectEntries() {
  const prodDirs = closureDirs(true)
  const allDirs = closureDirs(false)
  const byKey = new Map()
  for (const dir of allDirs) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pj, 'utf8'))
    } catch {
      continue
    }
    if (!pkg.name) continue
    const key = `${pkg.name}@${pkg.version || ''}`
    const prev = byKey.get(key)
    const production = prodDirs.has(dir) || Boolean(prev && prev.production)
    byKey.set(key, {
      name: pkg.name,
      version: pkg.version || '',
      license: normalizeLicense(pkg),
      dir,
      production
    })
  }
  const entries = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
  // The ripgrep/ast-grep binaries ship in the packaged app but come from
  // devDependencies, so hold them to the production (ship) policy explicitly.
  for (const bin of VENDORED_BINARIES) {
    entries.push({ name: bin.name, version: bin.version, license: bin.license, production: true, source: 'vendored binary' })
  }
  return { entries, prodCount: prodDirs.size, allCount: allDirs.size }
}

/** Best-effort dependency chain for a violating package, via `npm explain`. */
function explain(name) {
  try {
    return execFileSync('npm', ['explain', name], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  } catch {
    return ''
  }
}

function describe(item) {
  const closure = item.production ? 'production' : 'dev-only'
  const where = item.source ? ` (${item.source})` : ''
  const why =
    item.verdict === 'forbidden'
      ? item.detail || 'license is forbidden in every closure'
      : item.verdict === 'blocked'
        ? 'not on the ship allowlist; add a reviewed exception or change the dependency'
        : 'outside the allowlist; fine for dev tooling but worth a look'
  return `${item.name}@${item.version}${where} [${closure}]: license "${item.license}": ${why}`
}

function main() {
  let exceptions = []
  if (existsSync(EXCEPTIONS_FILE)) {
    exceptions = loadExceptions(JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')))
  }
  const { entries, prodCount, allCount } = collectEntries()
  const { errors, warnings, unusedExceptions } = evaluatePackages(entries, exceptions, {
    readLicenseTextFor: (e) => (e.dir ? readLicenseText(e.dir) : null)
  })

  const annotate = process.env.GITHUB_ACTIONS === 'true'
  for (const w of warnings) {
    const msg = `license-gate warning: ${describe(w)}`
    console.warn(msg)
    if (annotate) console.log(`::warning::${msg}`)
  }
  for (const x of unusedExceptions) {
    const msg = `license-gate: unused exception for "${x.name}" (${x.license}, ${x.closure}): remove it from license-gate-exceptions.json`
    console.error(msg)
    if (annotate) console.log(`::error::${msg}`)
  }
  for (const e of errors) {
    const msg = `license-gate violation: ${describe(e)}`
    console.error(msg)
    if (annotate) console.log(`::error::${msg}`)
    const chain = e.dir ? explain(e.name) : ''
    if (chain) console.error(chain.split('\n').map((l) => `    ${l}`).join('\n'))
  }

  if (errors.length || unusedExceptions.length) {
    console.error(`\nlicense-gate: FAILED (${errors.length} violation(s), ${unusedExceptions.length} unused exception(s))`)
    process.exit(1)
  }
  const licenses = [...new Set(entries.filter((e) => e.production).map((e) => e.license))].sort()
  console.log(
    `license-gate: OK. ${prodCount} production package dirs (ship licenses: ${licenses.join(', ')}), ` +
      `${allCount - prodCount} dev-only dirs, ${VENDORED_BINARIES.length} vendored binaries, ` +
      `${warnings.length} warning(s), ${exceptions.length} exception(s) in use.`
  )
}

// Run only when invoked directly, so tests can import the helpers cleanly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

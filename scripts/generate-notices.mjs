#!/usr/bin/env node
// Generate THIRD-PARTY-NOTICES.md — attribution for the third-party software that
// ships inside a packaged Houston build. Houston is proprietary (see LICENSE), but it
// bundles open-source dependencies whose permissive licenses (MIT/ISC/BSD copyright
// notices, and Apache-2.0's NOTICE clause for e.g. openai and @google/genai) require
// their notices to be reproduced when the software is redistributed.
//
// Coverage: the production dependency closure (`npm ls --omit=dev`) plus the CLI
// binaries vendored into the app at build time (ripgrep, ast-grep), which are sourced
// from devDependencies and so are not in that closure.
//
// Run `node scripts/generate-notices.mjs` (or `npm run notices`) after changing
// production dependencies, and commit the regenerated THIRD-PARTY-NOTICES.md.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')

// Vendored CLI binaries: shipped in the packaged app's Resources/bin (see
// scripts/copy-bundled-binaries.mjs) but provided by devDependencies, so they are not
// in the production npm closure and are attributed explicitly.
export const VENDORED_BINARIES = [
  {
    name: 'ripgrep',
    version: 'bundled binary (via @vscode/ripgrep)',
    license: 'MIT OR Unlicense',
    homepage: 'https://github.com/BurntSushi/ripgrep',
    note: 'The `rg` binary shipped in Resources/bin. ripgrep is dual-licensed MIT OR Unlicense; the @vscode/ripgrep npm package that supplies the binary is MIT.'
  },
  {
    name: 'ast-grep',
    version: 'bundled binary (via @ast-grep/cli)',
    license: 'MIT',
    homepage: 'https://github.com/ast-grep/ast-grep',
    note: 'The `ast-grep` binary shipped in Resources/bin, provided by the @ast-grep/cli npm package.'
  }
]

/** Normalize an npm package's license metadata to an SPDX-ish string. */
export function normalizeLicense(pkg) {
  if (!pkg) return 'UNKNOWN'
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean)
    if (types.length) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

/** Extract a homepage/repository URL from an npm package manifest, or ''. */
export function homepageOf(pkg) {
  if (!pkg) return ''
  if (typeof pkg.homepage === 'string' && pkg.homepage) return pkg.homepage
  const repo = pkg.repository
  if (typeof repo === 'string') return repo
  if (repo && typeof repo.url === 'string') return repo.url.replace(/^git\+/, '').replace(/\.git$/, '')
  return ''
}

const LICENSE_FILES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md',
  'License', 'License.md', 'license', 'license.md', 'COPYING', 'NOTICE'
]

/** Read the first license/notice file found in a package dir, or null. */
export function readLicenseText(dir, { exists = existsSync, read = readFileSync } = {}) {
  for (const f of LICENSE_FILES) {
    const p = join(dir, f)
    if (exists(p)) {
      try {
        const t = read(p, 'utf8').trim()
        if (t) return t
      } catch {
        // Unreadable; try the next candidate.
      }
    }
  }
  return null
}

/** Render one component as a markdown section. */
export function renderEntry({ name, version, license, homepage, text, note }) {
  const lines = [`### ${name}${version ? ` — ${version}` : ''}`, '']
  lines.push(`- License: ${license}`)
  if (homepage) lines.push(`- Homepage: ${homepage}`)
  lines.push('')
  if (note) lines.push(note, '')
  if (text) lines.push('```text', text, '```', '')
  return lines.join('\n')
}

/** Absolute dirs of every installed production dependency (project root excluded). */
function productionPackageDirs() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const seen = new Set()
  const dirs = []
  for (const line of out.split('\n')) {
    const d = line.trim()
    if (!d || d === ROOT) continue
    if (!d.includes(`${'node_modules'}`)) continue
    if (seen.has(d)) continue
    seen.add(d)
    dirs.push(d)
  }
  return dirs
}

function collectEntries() {
  const entries = []
  for (const dir of productionPackageDirs()) {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pj, 'utf8'))
    } catch {
      continue
    }
    if (!pkg.name) continue
    entries.push({
      name: pkg.name,
      version: pkg.version || '',
      license: normalizeLicense(pkg),
      homepage: homepageOf(pkg),
      text: readLicenseText(dir)
    })
  }
  // Dedupe by name@version, then sort by name.
  const byKey = new Map()
  for (const e of entries) byKey.set(`${e.name}@${e.version}`, e)
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function render(deps) {
  // Distinct licenses across the bundled npm closure, surfaced up front so a compliance
  // reviewer sees the whole set at a glance without scanning every entry below. Computed
  // from the actual closure, so it can never drift out of sync with the components.
  const licenses = [...new Set(deps.map((d) => d.license).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const header = [
    '# Third-party notices',
    '',
    'Houston is proprietary software (see [LICENSE](LICENSE)). It bundles the open-source',
    'components listed below, each under its own license. This file is generated by',
    '`scripts/generate-notices.mjs` (`npm run notices`) from the production dependency',
    'closure plus the CLI binaries vendored into the packaged app, and reproduces each',
    "component's license or notice text where the package ships one.",
    '',
    `> Licenses present in this closure: ${licenses.join(', ')}. Public-domain dedications`,
    '> such as the Unlicense (e.g. `fast-sha256`) carry no attribution requirement and are',
    '> treated here as permissive.',
    '',
    '> Electron, and the Chromium and Node.js components it bundles, ships its own license',
    '> notices inside the Electron framework included in each packaged build.',
    '',
    '---',
    ''
  ].join('\n')
  const bins = ['## Vendored CLI binaries', '', ...VENDORED_BINARIES.map(renderEntry), '---', ''].join('\n')
  const npm = [`## Bundled npm dependencies (${deps.length})`, '', ...deps.map(renderEntry)].join('\n')
  return header + bins + npm
}

function main() {
  const deps = collectEntries()
  writeFileSync(OUT, render(deps))
  process.stdout.write(`Wrote ${OUT} (${deps.length} npm dependencies + ${VENDORED_BINARIES.length} vendored binaries)\n`)
}

// Run only when invoked directly, so the test can import the helpers cleanly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

#!/usr/bin/env node
// Enrich a Syft-generated SBOM (CycloneDX + SPDX) with per-component integrity hashes and
// author metadata. Syft scans package-lock.json to enumerate the COMPLETE production
// closure (see .github/workflows/sbom.yml), but the lockfile carries neither file hashes
// nor author, so those fields come out empty. This post-process fills them in WITHOUT
// touching the component set — hashes from the lockfile's own `integrity` (the sha512 npm
// verifies each tarball against) and author from each package's installed package.json —
// so the completeness the scan guarantees (every production package present) is preserved
// exactly. Components with no lockfile integrity (the root project) or no `author` field in
// their manifest are simply left as-is; nothing is dropped.
//
// Usage: node scripts/enrich-sbom.mjs sbom.cyclonedx.json sbom.spdx.json
// Run from the repo root with node_modules installed (author is read from there).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Decode an npm `sha512-<base64>` integrity string to lowercase hex, or null. */
export function integrityToHex(integrity) {
  const m = /^sha512-(.+)$/.exec(integrity || '')
  if (!m) return null
  return Buffer.from(m[1], 'base64').toString('hex')
}

/** Normalize an npm `author` field (string or { name, email }) to "Name <email>", or null. */
export function normalizeAuthor(author) {
  if (!author) return null
  if (typeof author === 'string') return author.trim() || null
  if (typeof author === 'object' && author.name) {
    return author.email ? `${author.name} <${author.email}>` : author.name
  }
  return null
}

/** Format an author string as an SPDX originator ("Person: Name (email)"), or null. */
export function spdxOriginator(authorStr) {
  if (!authorStr) return null
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(authorStr)
  return m ? `Person: ${m[1].trim()} (${m[2].trim()})` : `Person: ${authorStr}`
}

/** Index name@version -> { integrity, path } from an npm v3 lockfile's `packages` map. */
export function buildLockIndex(lock) {
  const byNV = new Map()
  for (const [p, meta] of Object.entries((lock && lock.packages) || {})) {
    const i = p.lastIndexOf('node_modules/')
    if (i === -1 || !meta.version) continue
    const name = p.slice(i + 'node_modules/'.length)
    byNV.set(`${name}@${meta.version}`, { integrity: meta.integrity || null, path: p })
  }
  return byNV
}

/** Read the `author` for an installed package path, or null. */
function authorForPath(pkgPath) {
  const pj = join(ROOT, pkgPath, 'package.json')
  if (!existsSync(pj)) return null
  try {
    return normalizeAuthor(JSON.parse(readFileSync(pj, 'utf8')).author)
  } catch {
    return null
  }
}

/** Add hashes + author to each CycloneDX component in place. Returns coverage counts. */
export function enrichCycloneDx(doc, index, authorLookup) {
  let hashes = 0
  let authors = 0
  for (const c of doc.components || []) {
    const entry = index.get(`${c.name}@${c.version}`)
    if (!entry) continue
    const hex = integrityToHex(entry.integrity)
    if (hex && !(c.hashes || []).length) {
      c.hashes = [{ alg: 'SHA-512', content: hex }]
      hashes++
    }
    const author = authorLookup(entry.path)
    if (author && !c.author) {
      c.author = author
      authors++
    }
  }
  return { hashes, authors }
}

/** Add checksums + originator to each SPDX package in place. Returns coverage counts. */
export function enrichSpdx(doc, index, authorLookup) {
  let hashes = 0
  let authors = 0
  for (const p of doc.packages || []) {
    if (!p.name || !p.versionInfo) continue
    const entry = index.get(`${p.name}@${p.versionInfo}`)
    if (!entry) continue
    const hex = integrityToHex(entry.integrity)
    if (hex && !(p.checksums || []).some((x) => x.algorithm === 'SHA512')) {
      p.checksums = [...(p.checksums || []), { algorithm: 'SHA512', checksumValue: hex }]
      hashes++
    }
    const orig = spdxOriginator(authorLookup(entry.path))
    if (orig && (!p.originator || p.originator === 'NOASSERTION')) {
      p.originator = orig
      authors++
    }
  }
  return { hashes, authors }
}

function main() {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: node scripts/enrich-sbom.mjs <cyclonedx.json> [spdx.json]')
    process.exit(2)
  }
  const index = buildLockIndex(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')))
  for (const f of files) {
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    const res =
      doc.bomFormat === 'CycloneDX'
        ? enrichCycloneDx(doc, index, authorForPath)
        : enrichSpdx(doc, index, authorForPath)
    writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`)
    console.log(`enriched ${f}: +${res.hashes} hashes, +${res.authors} authors`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

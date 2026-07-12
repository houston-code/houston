#!/usr/bin/env node
// Enrich a Syft-generated SBOM (CycloneDX + SPDX) with per-component integrity hashes and
// supplier/author metadata. Syft scans package-lock.json to enumerate the COMPLETE
// production closure (see .github/workflows/sbom.yml), but the lockfile carries neither
// file hashes nor supplier data, so those fields come out empty. This post-process fills
// them in WITHOUT touching the component set — so the completeness the scan guarantees
// (every production package present) is preserved exactly; it only adds fields.
//
//   - hashes:   from the lockfile's own `integrity` (the sha512 npm verifies each tarball
//               against), decoded to hex.
//   - author:   from each package's installed package.json `author` (real authorship only).
//   - supplier: NTIA "Supplier Name" minimum element. Not every package declares an author,
//               so a fallback chain keeps coverage high: author -> contributors/maintainers
//               -> npm scope as an org (@google -> Google) -> repository owner -> otherwise
//               left as NOASSERTION (the SPDX-conformant "we checked, it isn't declared").
//
// Usage: node scripts/enrich-sbom.mjs sbom.cyclonedx.json sbom.spdx.json
// Run from the repo root with node_modules installed (metadata is read from there).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Supplier + author of the ROOT product itself (Houston), as opposed to its dependencies.
// syft can't know this, so it leaves the primary component's supplier and the SBOM author
// empty — which the NTIA minimum-elements check flags. Until Houston is incorporated the
// supplier/author is the individual who publishes it; on incorporation, switch to
// { name: '<Company>', isOrg: true } (and the SPDX/CDX formatting below follows).
export const SBOM_AUTHOR = { name: 'Piyush Kumar Vijay', email: 'piyushvijay@houstoncode.ai', isOrg: false }

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

/** Parse an npm person field (string "Name <email> (url)" or object) to { name, email }, or null. */
function personFrom(p) {
  if (!p) return null
  if (typeof p === 'string') {
    const s = p.trim()
    if (!s) return null
    const m = /^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\([^)]*\))?$/.exec(s)
    const name = ((m && m[1]) || s).trim()
    return name ? { name, email: m && m[2] ? m[2].trim() : undefined } : null
  }
  if (typeof p === 'object' && p.name) return { name: p.name, email: p.email }
  return null
}

/** Extract the owner from a package `repository` field (url or shorthand), or null. */
export function repoOwner(repository) {
  const url = typeof repository === 'string' ? repository : (repository && repository.url) || ''
  if (!url) return null
  const host = /(?:github|gitlab|bitbucket)\.com[/:]([^/#]+)\//.exec(url)
  if (host) return host[1]
  const short = /^(?:github:|gitlab:|bitbucket:)?([\w.-]+)\/[\w.-]+$/.exec(url)
  return short ? short[1] : null
}

/**
 * Best-effort supplier for a package, or null. Fallback chain: declared author ->
 * first contributor/maintainer -> npm scope as an organization -> repository owner.
 * Returns { name, email?, isOrg }.
 */
export function deriveSupplier(pkg, name) {
  const m = pkg || {}
  const person =
    personFrom(m.author) ||
    (Array.isArray(m.contributors) && personFrom(m.contributors[0])) ||
    (Array.isArray(m.maintainers) && personFrom(m.maintainers[0]))
  if (person) return { name: person.name, email: person.email, isOrg: false }
  if (name && name.startsWith('@')) {
    const scope = name.slice(1).split('/')[0]
    if (scope) return { name: scope, isOrg: true }
  }
  const owner = repoOwner(m.repository)
  if (owner) return { name: owner, isOrg: true }
  return null
}

/** Format a derived supplier as an SPDX supplier string, or "NOASSERTION". */
export function spdxSupplier(supplier) {
  if (!supplier) return 'NOASSERTION'
  if (supplier.isOrg) return `Organization: ${supplier.name}`
  return supplier.email ? `Person: ${supplier.name} (${supplier.email})` : `Person: ${supplier.name}`
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

/** Read a package's installed manifest, or null. */
function manifestForPath(pkgPath) {
  const pj = join(ROOT, pkgPath, 'package.json')
  if (!existsSync(pj)) return null
  try {
    return JSON.parse(readFileSync(pj, 'utf8'))
  } catch {
    return null
  }
}

/** Add hashes + author + supplier to each CycloneDX component in place. Returns coverage. */
export function enrichCycloneDx(doc, index, manifestLookup) {
  let hashes = 0
  let authors = 0
  let suppliers = 0
  for (const c of doc.components || []) {
    const entry = index.get(`${c.name}@${c.version}`)
    if (!entry) continue
    const hex = integrityToHex(entry.integrity)
    if (hex && !(c.hashes || []).length) {
      c.hashes = [{ alg: 'SHA-512', content: hex }]
      hashes++
    }
    const pkg = manifestLookup(entry.path)
    const author = normalizeAuthor(pkg && pkg.author)
    if (author && !c.author) {
      c.author = author
      authors++
    }
    const supplier = deriveSupplier(pkg, c.name)
    if (supplier && !c.supplier) {
      c.supplier = { name: supplier.name }
      suppliers++
    }
  }
  return { hashes, authors, suppliers }
}

/** Add checksums + originator + supplier to each SPDX package in place. Returns coverage. */
export function enrichSpdx(doc, index, manifestLookup) {
  let hashes = 0
  let authors = 0
  let suppliers = 0
  for (const p of doc.packages || []) {
    if (!p.name || !p.versionInfo) continue
    const entry = index.get(`${p.name}@${p.versionInfo}`)
    if (!entry) continue
    const hex = integrityToHex(entry.integrity)
    if (hex && !(p.checksums || []).some((x) => x.algorithm === 'SHA512')) {
      p.checksums = [...(p.checksums || []), { algorithm: 'SHA512', checksumValue: hex }]
      hashes++
    }
    const pkg = manifestLookup(entry.path)
    const orig = spdxOriginator(normalizeAuthor(pkg && pkg.author))
    if (orig && (!p.originator || p.originator === 'NOASSERTION')) {
      p.originator = orig
      authors++
    }
    const supStr = spdxSupplier(deriveSupplier(pkg, p.name))
    if (supStr !== 'NOASSERTION' && (!p.supplier || p.supplier === 'NOASSERTION')) {
      p.supplier = supStr
      suppliers++
    }
  }
  return { hashes, authors, suppliers }
}

/** Format SBOM_AUTHOR as an SPDX actor ("Person: Name (email)" or "Organization: Name"). */
export function authorAsSpdxActor(a = SBOM_AUTHOR) {
  if (a.isOrg) return `Organization: ${a.name}`
  return a.email ? `Person: ${a.name} (${a.email})` : `Person: ${a.name}`
}

/**
 * Fill in the ROOT product's supplier and the SBOM author on a CycloneDX doc — the fields
 * that describe who produced the software and the SBOM, which syft leaves empty. Targets the
 * primary component plus any `file` component (syft's scanned-file node); dependency
 * suppliers are handled by enrichCycloneDx. Returns how many component suppliers were set.
 */
export function enrichCycloneDxSelf(doc, rootName, author = SBOM_AUTHOR) {
  const md = (doc.metadata = doc.metadata || {})
  if (!md.authors || !md.authors.length) md.authors = [{ name: author.name, email: author.email }]
  // Declare the CISA SBOM type. This SBOM is software-composition analysis of the dependency
  // lockfile, which is a "Source" SBOM (from source manifests), not a "Build" one (which would
  // capture build-process/built-component data). CycloneDX has no CISA type enum, so express it
  // as a named lifecycle rather than a phase enum (none of which map cleanly to CISA Source).
  if (!md.lifecycles || !md.lifecycles.length) {
    md.lifecycles = [{ name: 'source', description: 'CISA Source SBOM: SCA of the dependency lockfile.' }]
  }
  if (md.component && !md.component.supplier) md.component.supplier = { name: author.name }
  let suppliers = 0
  for (const c of doc.components || []) {
    if ((c.name === rootName || c.type === 'file') && !c.supplier) {
      c.supplier = { name: author.name }
      suppliers++
    }
  }
  return suppliers
}

/** Same for SPDX: add a Person/Organization creator and set the root + file-node supplier. */
export function enrichSpdxSelf(doc, rootName, author = SBOM_AUTHOR) {
  const ci = (doc.creationInfo = doc.creationInfo || {})
  const actor = authorAsSpdxActor(author)
  ci.creators = ci.creators || []
  if (!ci.creators.includes(actor)) ci.creators = [actor, ...ci.creators]
  // Declare the CISA SBOM type (Source: SCA of the dependency lockfile). SPDX 2.3 has no field
  // for it — the FSCT3 checker only reads it from SPDX 3's /Software/Sbom.sbomType — so record
  // it in the document comment for human/other-tool consumption. (SPDX 3 output would be needed
  // to satisfy that specific FSCT3 check.)
  if (!ci.comment) ci.comment = 'SBOM type (CISA): Source — software-composition analysis of the dependency lockfile.'
  let suppliers = 0
  for (const p of doc.packages || []) {
    const isSelf = p.name === rootName || (typeof p.SPDXID === 'string' && p.SPDXID.includes('DocumentRoot-File'))
    if (isSelf && (!p.supplier || p.supplier === 'NOASSERTION')) {
      p.supplier = actor
      suppliers++
    }
  }
  return suppliers
}

/**
 * Remove syft's scanned-file wrapper so the SBOM lists only real software. A
 * `file:package-lock.json` scan makes the lockfile itself the primary component and adds a
 * `file` node that "contains" every package but has no PURL, which trips SBOM-quality checks
 * (e.g. Google's EO external-references check). Drop that node and promote the actual product
 * to the primary component; the dependency graph (which never references the file node) is
 * left intact.
 */
export function stripCycloneDxFileNode(doc, rootName) {
  const comps = doc.components || []
  const fileRefs = new Set(comps.filter((c) => c.type === 'file').map((c) => c['bom-ref']))
  const root = comps.find((c) => c.name === rootName && c.type !== 'file')
  if (root) doc.metadata = { ...(doc.metadata || {}), component: root }
  doc.components = comps.filter((c) => c.type !== 'file' && c !== root)
  if (Array.isArray(doc.dependencies)) {
    doc.dependencies = doc.dependencies
      .filter((d) => !fileRefs.has(d.ref))
      .map((d) => ({ ...d, dependsOn: (d.dependsOn || []).filter((r) => !fileRefs.has(r)) }))
  }
}

/** Same for SPDX: drop the file package + its CONTAINS edges, redirect DESCRIBES to the product. */
export function stripSpdxFileNode(doc, rootName) {
  const fileIds = new Set(
    (doc.packages || [])
      .filter((p) => typeof p.SPDXID === 'string' && p.SPDXID.includes('DocumentRoot-File'))
      .map((p) => p.SPDXID)
  )
  if (!fileIds.size) return
  const rootId = (doc.packages || []).find((p) => p.name === rootName)?.SPDXID
  doc.packages = (doc.packages || []).filter((p) => !fileIds.has(p.SPDXID))
  doc.relationships = (doc.relationships || [])
    .map((r) =>
      r.relationshipType === 'DESCRIBES' && fileIds.has(r.relatedSpdxElement) && rootId
        ? { ...r, relatedSpdxElement: rootId }
        : r
    )
    .filter((r) => !fileIds.has(r.spdxElementId) && !fileIds.has(r.relatedSpdxElement))
  if (Array.isArray(doc.documentDescribes) && rootId) {
    doc.documentDescribes = doc.documentDescribes.map((id) => (fileIds.has(id) ? rootId : id))
  }
}

/**
 * Whether an SPDX `licenseDeclared` value is safe to also assert as `licenseConcluded`. The
 * guardrail: a single token (an SPDX id or `LicenseRef-*`) is fine; a multi-token value is a
 * valid SPDX license *expression* only if it joins licenses with OR/AND/WITH — otherwise it's
 * free text (e.g. "SEE LICENSE IN LICENSE") that must not be asserted as a conclusion.
 */
export function isCopyableSpdxLicense(l) {
  if (!l || l === 'NOASSERTION' || l === 'NONE') return false
  if (/\s/.test(l)) return /\b(OR|AND|WITH)\b/.test(l)
  return true
}

/**
 * Set `licenseConcluded = licenseDeclared` for each package where the declared value is a
 * valid SPDX expression (see isCopyableSpdxLicense). syft populates only `licenseDeclared`,
 * leaving `licenseConcluded = NOASSERTION`, which FSCT3 flags. These licenses were audited as
 * permissive, so declared is a justified conclusion; the guardrail keeps a future oddball
 * (free-text or NOASSERTION) declaration from being asserted. Returns how many were set.
 */
export function concludeSpdxLicenses(doc) {
  let n = 0
  for (const p of doc.packages || []) {
    if ((!p.licenseConcluded || p.licenseConcluded === 'NOASSERTION') && isCopyableSpdxLicense(p.licenseDeclared)) {
      p.licenseConcluded = p.licenseDeclared
      n++
    }
  }
  return n
}

function main() {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: node scripts/enrich-sbom.mjs <cyclonedx.json> [spdx.json]')
    process.exit(2)
  }
  const index = buildLockIndex(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')))
  const rootName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
  for (const f of files) {
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    const isCdx = doc.bomFormat === 'CycloneDX'
    if (isCdx) stripCycloneDxFileNode(doc, rootName)
    else stripSpdxFileNode(doc, rootName)
    const res = isCdx ? enrichCycloneDx(doc, index, manifestForPath) : enrichSpdx(doc, index, manifestForPath)
    const self = isCdx ? enrichCycloneDxSelf(doc, rootName) : enrichSpdxSelf(doc, rootName)
    if (!isCdx) concludeSpdxLicenses(doc)
    writeFileSync(f, `${JSON.stringify(doc, null, 2)}\n`)
    console.log(`enriched ${f}: +${res.hashes} hashes, +${res.authors} authors, +${res.suppliers + self} suppliers (incl. ${self} self/root)`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

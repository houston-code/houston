#!/usr/bin/env node
// Completeness floor for the three lockfile SBOMs (CycloneDX 1.6, SPDX 2.3, SPDX 3.0).
//
// The conformance checkers (NTIA, FSCT3, CycloneDX validate) are per-package field
// validators: they ask whether each package PRESENT carries a supplier, version and unique
// id. Nothing in them asserts how many packages there should be, so a truncated closure
// (npm sbom once emitted 56 of 73 production packages, every one well-formed) passes them
// all. The entry floor is the guard against that; the hash floor catches enrichment
// (scripts/enrich-sbom.mjs) silently no-op'ing; the SPDX 3.0 supplier check catches the
// FSCT3-critical field syft omits. Same fail-closed stance as verify-bundled-binaries.mjs.
//
// Usage: node scripts/verify-sbom.mjs <sbom.cyclonedx.json> <sbom.spdx.json> <sbom.spdx3.json>
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The production closure is ~73 packages; well under that means a partial scan.
export const MIN_PACKAGES = 60

/** CycloneDX (`components`) or SPDX 2.3 (`packages`): entry and hashed-entry floors. */
export function checkFlat(name, doc) {
  const items = doc.components || doc.packages || []
  const hashed = items.filter((x) => (x.hashes || x.checksums || []).length).length
  if (items.length < MIN_PACKAGES) {
    return { ok: false, message: `${name} has only ${items.length} entries (<${MIN_PACKAGES}): closure looks truncated` }
  }
  if (hashed < MIN_PACKAGES) {
    return { ok: false, message: `${name} has only ${hashed} hashed entries (<${MIN_PACKAGES}): enrichment did not run` }
  }
  return { ok: true, message: `${name} OK (${items.length} entries, ${hashed} hashed)` }
}

/** SPDX 3.0 JSON-LD graph: package floor, and every package carries a supplier. */
export function checkSpdx3(name, doc) {
  const pkgs = (doc['@graph'] || []).filter((e) => e.type === 'software_Package')
  const supplied = pkgs.filter((p) => p.suppliedBy).length
  if (pkgs.length < MIN_PACKAGES) {
    return { ok: false, message: `${name} has only ${pkgs.length} packages (<${MIN_PACKAGES})` }
  }
  if (supplied < pkgs.length) {
    return { ok: false, message: `${name}: ${pkgs.length - supplied} packages missing suppliedBy` }
  }
  return { ok: true, message: `${name} OK (${pkgs.length} packages, all supplied)` }
}

export function verify([cdx, spdx, spdx3], read = (p) => JSON.parse(readFileSync(p, 'utf8'))) {
  return [checkFlat(cdx, read(cdx)), checkFlat(spdx, read(spdx)), checkSpdx3(spdx3, read(spdx3))]
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2)
  if (files.length !== 3) {
    console.error('usage: verify-sbom.mjs <cyclonedx.json> <spdx.json> <spdx3.json>')
    process.exit(2)
  }
  const results = verify(files)
  for (const r of results) (r.ok ? console.log : (m) => console.error(`::error::${m}`))(r.message)
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

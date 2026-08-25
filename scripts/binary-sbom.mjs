#!/usr/bin/env node
// Deep binary SBOM for the NATIVE layer of the packaged app — the components that ship as
// real executables/addons rather than as npm tarballs in the lockfile: the Electron runtime
// (and the Chromium + Node it embeds), the node-pty native addon, and the vendored `rg`
// (ripgrep) + `ast-grep` CLI binaries. The lockfile SBOM (scripts/enrich-sbom.mjs) already
// covers the JavaScript closure; this covers the layer it structurally cannot see.
//
// WHY THIS ISN'T JUST `syft scan dir:<app>`. A calibration run of Syft v1.46 against a real
// packaged Houston.app found essentially NOTHING:
//   • default directory catalogers            -> 0 components
//   • --override-default-catalogers all        -> 1 component (node-pty, from its unpacked
//                                                 package.json) and nothing else
//   • the Electron Framework binary directly   -> 0 (Syft has no Electron/Chromium classifier)
//   • the `rg` / `ast-grep` binaries           -> 0 (stripped Rust binaries carry no metadata
//                                                 Syft recognizes)
// So a fail-closed floor keyed on "Syft found >= N" would be meaningless (N would be ~1), and
// the four things this SBOM exists to record — Electron, Chromium, Node, and the two Rust CLIs —
// would be absent. This generator therefore CONSTRUCTS the component set from a known-binary
// manifest and reads each version from the ACTUAL shipped artifact (not from a table that would
// silently go stale across an Electron bump):
//   • electron / chromium / node : parsed from the Electron binary's compiled-in user-agent and
//                                  node runtime strings ("Electron/43.1.0", "Chrome/150.0.7871.47",
//                                  "node.js/v24.18.0"). These differ from anything in a manifest —
//                                  e.g. the SHIPPED Node (24.18.0) is not the BUILD Node (.nvmrc),
//                                  and the Chromium version appears in no package.json at all.
//   • ripgrep                    : `rg --version` on the shipped binary ("ripgrep 15.0.0") — the
//                                  real ripgrep release, which the wrapper package version
//                                  (@vscode/ripgrep@1.18.0) does NOT reveal.
//   • ast-grep                   : `ast-grep --version` on the shipped binary ("ast-grep 0.44.1").
//   • node-pty                   : version from its unpacked package.json.
// Each component also carries the sha256 of the exact file that ships (integrity evidence) and a
// purl/CPE chosen so a vulnerability scanner (grype) can match advisories against the native
// layer too — today a Chromium or ripgrep CVE is invisible to the release's SBOM vuln gate.
//
// FAIL-CLOSED FLOOR (verifyComponents): the build aborts unless EVERY expected component is
// present with a non-empty version AND a hash. This is the same stance as
// scripts/verify-bundled-binaries.mjs — better to fail the release than ship a hollow SBOM that
// silently dropped the runtime it's supposed to attest.
//
// Usage: node scripts/binary-sbom.mjs --app <packaged-app-dir> \
//          -o cyclonedx-json=sbom.binary.cyclonedx.json \
//          -o spdx-json=sbom.binary.spdx.json
// Run from the repo root (reads node_modules/electron/package.json for a cross-check).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SBOM_AUTHOR, SBOM_ROOT_LICENSE, spdxSupplier, authorAsSpdxActor } from './enrich-sbom.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The expected native components, in a stable order. `key` is the internal id; `name` is the
// component name in the SBOM. `supplier`/`license` are the audited, well-known upstream values
// (these are not npm packages, so there's no manifest to derive them from). `purl`/`cpe` are the
// coordinates a scanner matches advisories against — a CPE for the two runtimes NVD tracks
// (Chromium under google:chrome, Node under nodejs:node.js) and a purl for the ecosystem-native
// ones (npm for electron/node-pty, cargo for the two Rust CLIs). `type` is the CycloneDX class.
export const EXPECTED_BINARIES = [
  {
    key: 'electron',
    name: 'electron',
    type: 'framework',
    supplier: { name: 'OpenJS Foundation', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:npm/electron@${v}`,
    cpe: null
  },
  {
    key: 'chromium',
    name: 'chromium',
    type: 'framework',
    supplier: { name: 'Google LLC', isOrg: true },
    license: 'BSD-3-Clause',
    purl: (v) => `pkg:generic/chromium@${v}`,
    cpe: (v) => `cpe:2.3:a:google:chrome:${v}:*:*:*:*:*:*:*`
  },
  {
    key: 'node',
    name: 'node',
    type: 'framework',
    supplier: { name: 'OpenJS Foundation', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:generic/node@${v}`,
    cpe: (v) => `cpe:2.3:a:nodejs:node.js:${v}:*:*:*:*:*:*:*`
  },
  {
    key: 'nodePty',
    name: 'node-pty',
    type: 'library',
    supplier: { name: 'Microsoft', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:npm/node-pty@${v}`,
    cpe: null
  },
  {
    key: 'ripgrep',
    name: 'ripgrep',
    type: 'application',
    supplier: { name: 'Andrew Gallant', isOrg: false },
    license: 'MIT',
    purl: (v) => `pkg:cargo/ripgrep@${v}`,
    cpe: null
  },
  {
    key: 'astGrep',
    name: 'ast-grep',
    type: 'application',
    supplier: { name: 'Herrington Darkholme', isOrg: false },
    license: 'MIT',
    purl: (v) => `pkg:cargo/ast-grep@${v}`,
    cpe: null
  }
]

// macOS-only: Electron bundles the Squirrel.Mac auto-updater and its two Objective-C
// dependencies (ReactiveObjC, Mantle) as frameworks inside the `.app`. Windows and Linux use
// different update mechanisms, so these are absent there. They ship as real bytes, so a
// component-complete SBOM of the mac artifact must list them — but they are NOT part of the
// fail-closed floor (EXPECTED_BINARIES): Electron owns this packaging, and requiring them would
// (correctly) make every non-macOS leg fail. Recorded additively when present, with the version
// from each framework's Info.plist. No CPE — these carry no NVD coordinates, so they're an
// honest inventory record, not a vulnerability-match target.
export const MAC_FRAMEWORKS = [
  {
    key: 'squirrel',
    name: 'Squirrel.Mac',
    framework: 'Squirrel',
    supplier: { name: 'GitHub', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:github/Squirrel/Squirrel.Mac@${v}`
  },
  {
    key: 'reactiveObjC',
    name: 'ReactiveObjC',
    framework: 'ReactiveObjC',
    supplier: { name: 'ReactiveCocoa', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:cocoapods/ReactiveObjC@${v}`
  },
  {
    key: 'mantle',
    name: 'Mantle',
    framework: 'Mantle',
    supplier: { name: 'GitHub', isOrg: true },
    license: 'MIT',
    purl: (v) => `pkg:cocoapods/Mantle@${v}`
  }
]

// ── Version parsers (pure) ────────────────────────────────────────────────────────────────

/**
 * Pull Electron / Chromium / Node versions out of the strings compiled into the Electron
 * binary. The default user-agent carries "Chrome/<X>" and "Electron/<X>", and the node runtime
 * banner carries "node.js/v<X>". Returns { electron, chromium, node } with any not-found field
 * left undefined so the caller's floor check can report exactly what was missing.
 */
export function parseElectronVersions(text) {
  const pick = (re) => {
    const m = re.exec(text || '')
    return m ? m[1] : undefined
  }
  return {
    electron: pick(/Electron\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/),
    // Chromium ships a four-part version (major.minor.build.patch).
    chromium: pick(/Chrome\/(\d+\.\d+\.\d+\.\d+)/),
    node: pick(/node\.js\/v(\d+\.\d+\.\d+)/)
  }
}

/** Parse `rg --version` output ("ripgrep 15.0.0 (rev ...)") to a bare version, or undefined. */
export function parseRgVersion(stdout) {
  const m = /ripgrep\s+(\d+\.\d+\.\d+)/.exec(stdout || '')
  return m ? m[1] : undefined
}

/** Parse `ast-grep --version` output ("ast-grep 0.44.1") to a bare version, or undefined. */
export function parseAstGrepVersion(stdout) {
  const m = /ast[-_ ]?grep\s+(\d+\.\d+\.\d+)/i.exec(stdout || '')
  return m ? m[1] : undefined
}

/** Pull a `<key>…</key><string>…</string>` value out of an Info.plist XML, or undefined. */
export function parsePlistString(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
  const m = re.exec(xml || '')
  return m ? m[1].trim() || undefined : undefined
}

// ── Binary discovery (impure, filesystem) ──────────────────────────────────────────────────

/**
 * The main Electron executable lives in different places per platform, and the compiled-in
 * version strings can sit in the main binary (Linux/Windows) OR in the Electron Framework
 * (macOS splits them out). Return every plausible carrier under `appDir`, largest first — the
 * framework/main binary that actually holds the strings is always among the biggest files, so a
 * size-ordered scan finds it quickly without hard-coding a per-platform path that a future
 * electron-builder layout change could break.
 */
export function findVersionCarriers(appDir, { fs = { readdirSync, statSync } } = {}) {
  const out = []
  const skipDirs = new Set(['bin']) // vendored rg/ast-grep handled separately; don't rescan them
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(p, depth + 1)
      } else if (e.isFile()) {
        let size = 0
        try {
          size = fs.statSync(p).size
        } catch {
          continue
        }
        // The strings live in a large linked binary; skip small resources, locale paks, etc.
        if (size >= 1_000_000) out.push({ path: p, size })
      }
    }
  }
  walk(appDir, 0)
  return out.sort((a, b) => b.size - a.size).map((f) => f.path)
}

/** Read a file as latin1 text so byte-embedded ASCII version strings are greppable. */
function readAsText(path) {
  return readFileSync(path).toString('latin1')
}

/**
 * Scan the candidate carriers (largest first) until all three Electron-family versions are
 * found. Stops early once complete so it doesn't slurp every large binary. `read` is injectable
 * for tests.
 */
export function extractElectronVersions(carriers, { read = readAsText } = {}) {
  let found = {}
  for (const path of carriers) {
    const v = parseElectronVersions(read(path))
    found = { electron: found.electron ?? v.electron, chromium: found.chromium ?? v.chromium, node: found.node ?? v.node }
    if (found.electron && found.chromium && found.node) break
  }
  return found
}

/** Locate a vendored CLI binary (rg / ast-grep, optionally .exe) under the app's Resources/bin. */
export function findVendoredBinary(appDir, name, { fs = { readdirSync, statSync } } = {}) {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && (e.name === name || e.name === `${name}.exe`)) hits.push(p)
    }
  }
  walk(appDir, 0)
  // Prefer a binary under a `bin/` dir (our vendored location) over any incidental match.
  hits.sort((a, b) => (dirname(b).endsWith('bin') ? 1 : 0) - (dirname(a).endsWith('bin') ? 1 : 0))
  return hits[0] ?? null
}

/** Locate the shipped node-pty native addon (.node) to hash, or null. */
export function findNodePtyAddon(appDir, { fs = { readdirSync, statSync } } = {}) {
  let best = null
  const walk = (dir, depth) => {
    if (depth > 10) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      // The loaded addon is build/Release/pty.node; prefer it over the bundled cross-platform
      // prebuilds so the hash reflects what this platform actually loads.
      else if (e.isFile() && e.name.endsWith('.node')) {
        if (!best || p.includes(`${'build'}/Release/`)) best = p
      }
    }
  }
  walk(appDir, 0)
  return best
}

/** sha256 of a file as lowercase hex. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Detect the macOS-only Electron framework stack (Squirrel.Mac + ReactiveObjC + Mantle) inside a
 * packaged `.app`, returning a component object (same shape as the core set) for each one present
 * with a parseable version. Returns [] on a Windows/Linux artifact (the frameworks aren't there),
 * so the same generator runs unchanged on every leg. `read`/`exists`/`hash` are injectable.
 */
export function detectMacFrameworks(
  appDir,
  { read = (p) => readFileSync(p, 'utf8'), exists = existsSync, hash = sha256File } = {}
) {
  const out = []
  for (const fw of MAC_FRAMEWORKS) {
    const base = join(appDir, 'Contents', 'Frameworks', `${fw.framework}.framework`)
    const plist = join(base, 'Resources', 'Info.plist')
    const binary = join(base, 'Versions', 'A', fw.framework)
    if (!exists(plist)) continue
    let version
    try {
      version = parsePlistString(read(plist), 'CFBundleShortVersionString')
    } catch {
      /* unreadable plist; skip this framework */
    }
    if (!version) continue
    let fileHash
    try {
      if (exists(binary)) fileHash = hash(binary)
    } catch {
      /* leave hash unset — frameworks aren't floor-required */
    }
    out.push({
      key: fw.key,
      name: fw.name,
      version,
      type: 'framework',
      supplier: fw.supplier,
      license: fw.license,
      purl: fw.purl(version),
      cpe: undefined,
      hash: fileHash,
      path: exists(binary) ? binary : plist
    })
  }
  return out
}

// ── Assembly (pure) ─────────────────────────────────────────────────────────────────────────

/**
 * Turn the resolved { versions, hashes } into the ordered component list used by both output
 * formats. `resolved[key]` = { version, hash?, path? }. A spec with no resolved version is still
 * emitted (version: undefined) so verifyComponents can flag it, rather than being silently
 * dropped from the set.
 */
export function buildComponents(resolved, specs = EXPECTED_BINARIES) {
  return specs.map((spec) => {
    const r = resolved[spec.key] || {}
    return {
      key: spec.key,
      name: spec.name,
      version: r.version,
      type: spec.type,
      supplier: spec.supplier,
      license: spec.license,
      purl: r.version ? spec.purl(r.version) : undefined,
      cpe: r.version && spec.cpe ? spec.cpe(r.version) : undefined,
      hash: r.hash,
      path: r.path
    }
  })
}

/**
 * Fail-closed floor: throw unless every expected component is present with a non-empty version
 * AND a hash. Returns the components on success. This is the release-gating check — a hollow or
 * partial binary SBOM must abort the build, never ship.
 */
export function verifyComponents(components, specs = EXPECTED_BINARIES) {
  const problems = []
  const byKey = new Map(components.map((c) => [c.key, c]))
  for (const spec of specs) {
    const c = byKey.get(spec.key)
    if (!c) problems.push(`${spec.name}: missing entirely`)
    else {
      if (!c.version) problems.push(`${spec.name}: no version resolved`)
      if (!c.hash) problems.push(`${spec.name}: no file hash (binary not found in the bundle)`)
    }
  }
  if (problems.length) {
    throw new Error(
      `binary-sbom: fail-closed floor not met — the packaged app is missing expected native ` +
        `components or their versions:\n  • ${problems.join('\n  • ')}\n` +
        `Refusing to write a hollow binary SBOM.`
    )
  }
  return components
}

/** A short, stable bom-ref for a component. */
const refFor = (c) => `binary:${c.name}@${c.version}`

/** Assemble a CycloneDX 1.6 document from the components. */
export function assembleCycloneDx(components, { rootName, version, platform, author = SBOM_AUTHOR, serialNumber } = {}) {
  const rootRef = `root:${rootName}@${version}${platform ? `?platform=${platform}` : ''}`
  const root = {
    type: 'application',
    'bom-ref': rootRef,
    name: rootName,
    version,
    supplier: { name: author.name },
    licenses: [{ license: { id: SBOM_ROOT_LICENSE } }],
    description: `Houston packaged desktop application (native/binary layer${platform ? `, ${platform}` : ''})`
  }
  if (platform) root.properties = [{ name: 'houston:platform', value: platform }]
  const comps = components.map((c) => {
    const out = {
      type: c.type,
      'bom-ref': refFor(c),
      name: c.name,
      version: c.version,
      supplier: { name: c.supplier.name },
      licenses: [{ license: { id: c.license } }],
      purl: c.purl
    }
    if (c.hash) out.hashes = [{ alg: 'SHA-256', content: c.hash }]
    if (c.cpe) out.cpe = c.cpe
    return out
  })
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: serialNumber || undefined,
    version: 1,
    metadata: {
      // No wall-clock timestamp: the generator must be deterministic (Date.now() is banned in
      // this codebase's build scripts), and a per-run timestamp would make the SBOM non-repro.
      authors: [{ name: author.name, email: author.email }],
      component: root,
      // Record which platform artifact this document describes: the component versions are
      // identical across platforms, but the hashes (and the macOS-only frameworks) are not.
      ...(platform ? { properties: [{ name: 'houston:platform', value: platform }] } : {}),
      // This SBOM describes built binaries pulled from the packaged artifact, i.e. a CISA
      // "Build" SBOM — unlike the lockfile SBOM, which is "Source".
      lifecycles: [{ name: 'build', description: 'CISA Build SBOM: native binaries in the packaged app.' }]
    },
    components: comps,
    dependencies: [{ ref: rootRef, dependsOn: comps.map((c) => c['bom-ref']) }]
  }
}

/** Assemble an SPDX 2.3 document from the components. */
export function assembleSpdx(components, { rootName, version, platform, author = SBOM_AUTHOR, namespace } = {}) {
  const rootId = 'SPDXRef-Package-root'
  const idFor = (c) => `SPDXRef-Package-${c.name.replace(/[^A-Za-z0-9.-]+/g, '-')}`
  const packages = [
    {
      SPDXID: rootId,
      name: rootName,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      supplier: authorAsSpdxActor(author),
      licenseConcluded: SBOM_ROOT_LICENSE,
      licenseDeclared: SBOM_ROOT_LICENSE,
      copyrightText: 'NOASSERTION',
      comment: platform ? `platform: ${platform}` : undefined
    },
    ...components.map((c) => {
      const externalRefs = [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl }
      ]
      if (c.cpe) {
        externalRefs.push({ referenceCategory: 'SECURITY', referenceType: 'cpe23Type', referenceLocator: c.cpe })
      }
      return {
        SPDXID: idFor(c),
        name: c.name,
        versionInfo: c.version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        supplier: spdxSupplier(c.supplier),
        licenseConcluded: c.license,
        licenseDeclared: c.license,
        copyrightText: 'NOASSERTION',
        checksums: c.hash ? [{ algorithm: 'SHA256', checksumValue: c.hash }] : undefined,
        externalRefs
      }
    })
  ]
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${rootName}-binary-sbom${platform ? `-${platform}` : ''}`,
    // The namespace must be unique per document; fold in the platform so each leg's SBOM has a
    // distinct namespace (the versions match across platforms, but the documents are separate).
    documentNamespace: namespace || `https://houstoncode.ai/spdx/${rootName}-binary-${platform ? `${platform}-` : ''}${version}`,
    creationInfo: {
      // Deterministic: no `created` timestamp (see the CycloneDX note above).
      creators: [authorAsSpdxActor(author), 'Tool: houston-binary-sbom'],
      comment: `SBOM type (CISA): Build — native binaries extracted from the packaged app${platform ? ` (${platform})` : ''}.`
    },
    packages,
    documentDescribes: [rootId],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: rootId, relationshipType: 'DESCRIBES' },
      ...components.map((c) => ({
        spdxElementId: rootId,
        relatedSpdxElement: idFor(c),
        relationshipType: 'DEPENDS_ON'
      }))
    ]
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

/** Parse `--app <dir>`, optional `--platform <os-arch>`, and repeatable `-o <format>=<path>`. */
export function parseArgs(argv) {
  let app
  let platform
  const outputs = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app' && argv[i + 1]) app = argv[++i]
    else if (argv[i] === '--platform' && argv[i + 1]) platform = argv[++i]
    else if (argv[i] === '-o' && argv[i + 1]) {
      const [fmt, ...rest] = argv[++i].split('=')
      outputs.push({ fmt, path: rest.join('=') })
    }
  }
  return { app, platform, outputs }
}

/**
 * Resolve every component's version + hash from the packaged app at `appDir`. Pure orchestration
 * over the discovery helpers; returns the `resolved` map buildComponents consumes.
 */
export function resolveFromApp(appDir, { exec = execFileSync } = {}) {
  const resolved = {}

  // Electron / Chromium / Node — from the compiled-in strings of the largest binaries.
  const carriers = findVersionCarriers(appDir)
  const ev = extractElectronVersions(carriers)
  // Hash the biggest carrier (the Electron Framework / main binary) as the runtime's integrity
  // evidence — the same file for electron/chromium/node since they share one binary.
  const runtimeBinary = carriers[0]
  const runtimeHash = runtimeBinary ? sha256File(runtimeBinary) : undefined
  resolved.electron = { version: ev.electron, hash: runtimeHash, path: runtimeBinary }
  resolved.chromium = { version: ev.chromium, hash: runtimeHash, path: runtimeBinary }
  resolved.node = { version: ev.node, hash: runtimeHash, path: runtimeBinary }

  // node-pty — version from its unpacked manifest, hash from the loaded .node addon.
  const ptyAddon = findNodePtyAddon(appDir)
  let ptyVersion
  // The unpacked package.json sits next to the addon under node_modules/node-pty.
  const ptyManifest = findVendoredManifest(appDir, 'node-pty')
  if (ptyManifest) {
    try {
      ptyVersion = JSON.parse(readFileSync(ptyManifest, 'utf8')).version
    } catch {
      /* leave undefined; floor will flag it */
    }
  }
  resolved.nodePty = { version: ptyVersion, hash: ptyAddon ? sha256File(ptyAddon) : undefined, path: ptyAddon }

  // ripgrep — `rg --version` on the shipped binary (native to this platform on its build leg).
  const rg = findVendoredBinary(appDir, 'rg')
  resolved.ripgrep = {
    version: rg ? parseRgVersion(safeExec(exec, rg, ['--version'])) : undefined,
    hash: rg ? sha256File(rg) : undefined,
    path: rg
  }

  // ast-grep — `ast-grep --version` on the shipped binary.
  const ag = findVendoredBinary(appDir, 'ast-grep')
  resolved.astGrep = {
    version: ag ? parseAstGrepVersion(safeExec(exec, ag, ['--version'])) : undefined,
    hash: ag ? sha256File(ag) : undefined,
    path: ag
  }

  // macOS-only Electron framework stack (Squirrel.Mac + ReactiveObjC + Mantle); [] elsewhere.
  const frameworks = detectMacFrameworks(appDir)

  return { resolved, frameworks }
}

/** Run a binary and capture stdout, returning '' on any failure (floor catches the missing version). */
function safeExec(exec, bin, args) {
  try {
    return exec(bin, args, { encoding: 'utf8', timeout: 30_000 }).toString()
  } catch {
    return ''
  }
}

/** Find an unpacked package's package.json under the app (e.g. node-pty's), or null. */
function findVendoredManifest(appDir, pkgName) {
  let found = null
  const walk = (dir, depth) => {
    if (found || depth > 10) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (found) return
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'package.json' && basename(dirname(p)) === pkgName) found = p
    }
  }
  walk(appDir, 0)
  return found
}

function main() {
  const { app, platform, outputs } = parseArgs(process.argv.slice(2))
  if (!app || !outputs.length) {
    console.error(
      'usage: node scripts/binary-sbom.mjs --app <packaged-app-dir> [--platform <os-arch>] ' +
        '-o cyclonedx-json=<path> [-o spdx-json=<path>]'
    )
    process.exit(2)
  }
  if (!existsSync(app)) {
    console.error(`binary-sbom: packaged app dir not found: ${app}`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const { resolved, frameworks } = resolveFromApp(app)
  // The core six are floor-required; the macOS framework stack (when present) is additive.
  const components = [...buildComponents(resolved), ...frameworks]

  // Cross-check the grepped Electron version against the installed electron package — a mismatch
  // means the strings parse latched onto the wrong token, so fail rather than mislabel.
  try {
    const declared = JSON.parse(readFileSync(join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version
    const parsed = components.find((c) => c.key === 'electron')?.version
    if (declared && parsed && declared !== parsed) {
      console.error(
        `binary-sbom: Electron version mismatch — packaged binary says ${parsed} but ` +
          `node_modules/electron is ${declared}. Aborting.`
      )
      process.exit(1)
    }
  } catch {
    // electron package not installed (e.g. running against a downloaded artifact) — skip the cross-check.
  }

  verifyComponents(components) // fail-closed

  for (const { fmt, path } of outputs) {
    let doc
    if (fmt === 'cyclonedx-json') doc = assembleCycloneDx(components, { rootName: pkg.name, version: pkg.version, platform })
    else if (fmt === 'spdx-json') doc = assembleSpdx(components, { rootName: pkg.name, version: pkg.version, platform })
    else {
      console.error(`binary-sbom: unknown output format "${fmt}" (want cyclonedx-json | spdx-json)`)
      process.exit(2)
    }
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  }

  console.log(`✓ binary-sbom${platform ? ` [${platform}]` : ''}: ${components.length} native components:`)
  for (const c of components) console.log(`    ${c.name.padEnd(13)} ${String(c.version).padEnd(16)} ${c.purl}`)
  console.log(`  wrote: ${outputs.map((o) => o.path).join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

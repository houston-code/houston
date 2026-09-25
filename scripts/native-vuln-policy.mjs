#!/usr/bin/env node
// Release policy for vulnerabilities in the NATIVE layer (the Electron runtime, the Chromium and
// Node it embeds, node-pty, and the vendored rg/ast-grep CLIs). The lockfile gate blocks on any
// fixable High/Critical, because an npm fix is always one `npm update` away. The native layer is
// different: Chromium and Node reach us only through an Electron release, and each Electron major
// stays on its Chromium major. A Chromium security batch routinely lands weeks before any STABLE
// Electron carries it, and blocking every release for that window stops shipping everything else
// (including the fixes Electron has already backported) without making anyone safer.
//
// So a fixable High/Critical finding is classified:
//   • BLOCKING  — we are simply behind: a stable Electron release already bundles a Chromium /
//                 Node / Electron at or above the fixed version. Or the component is not supplied
//                 by Electron at all (node-pty, rg, ast-grep), so the fix is ours to take.
//   • TRACKED   — only a pre-release (alpha/beta/nightly) has the fix. The release ships, and the
//                 finding is published as an `affected` statement in the release's VEX document
//                 and (from native-vuln-scan.yml) as a GitHub code scanning alert, which closes
//                 itself once a scan stops reporting it.
// Pre-release Electron is never an upgrade target: shipping one to clear a scanner trades known
// CVEs for an untested runtime.
//
// Subcommands:
//   sbom      --releases <releases.json> [--lockfile package-lock.json] -o <out.cdx.json>
//             Pre-build SBOM of electron/chromium/node, from the lockfile's Electron version and
//             Electron's published release metadata. Lets the scan run before anything is built.
//   evaluate  --report <grype.json> --releases <releases.json>
//             [--vex-in <doc>] [--vex-out <doc>] [--release <version>] [--summary <file>]
//             Classify the grype findings, write the Markdown summary and (optionally) the
//             release VEX document, and exit 1 if anything is BLOCKING.
//   sarif     --report <grype.json> --in <grype.sarif> --out <out.sarif> [--lockfile <path>]
//             Reduce grype's SARIF to the High/Critical findings and give each a real file
//             location, for upload to GitHub code scanning.
//
// <releases.json> is https://releases.electronjs.org/releases.json, downloaded once per run so
// every step of a run judges against the same snapshot. Missing metadata fails closed.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_BINARIES } from './binary-sbom.mjs'

const BLOCKING_SEVERITIES = new Set(['High', 'Critical'])

// Numeric dotted-version compare (Chromium is 4-part, Node/Electron 3-part). A prerelease suffix
// is ignored here; callers filter prereleases out before comparing.
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

const major = (v) => Number(String(v).split('.')[0])

// Does `version` contain the fix? `fixes` may list one fixed version per maintained line (Node
// advisories do: "22.20.1, 24.21.3"). A version is fixed when it is at or above the fix on its
// own line, or on a newer line than every listed fix.
export function satisfiesFix(version, fixes) {
  if (!version || !fixes?.length) return false
  const sameLine = fixes.filter((f) => major(f) === major(version))
  if (sameLine.length) return sameLine.some((f) => compareVersions(version, f) >= 0)
  return fixes.every((f) => major(version) > major(f))
}

export const isStable = (release) => !String(release.version).includes('-')

// Which field of an Electron release carries a given runtime component's version.
const RUNTIME_FIELD = { electron: 'version', chromium: 'chrome', node: 'node' }

// The component a grype match is about, keyed to EXPECTED_BINARIES (by purl prefix, since that is
// what binary-sbom.mjs and the pre-build SBOM both emit).
export function componentKey(artifact) {
  const purl = artifact?.purl || ''
  for (const spec of EXPECTED_BINARIES) {
    if (purl.startsWith(spec.purl(''))) return spec.key
  }
  return artifact?.name || 'unknown'
}

// First stable Electron release (oldest) that fixes the finding, or undefined.
export function stableUpgrade(key, fixes, releases) {
  const field = RUNTIME_FIELD[key]
  if (!field) return undefined
  return releases
    .filter(isStable)
    .filter((r) => satisfiesFix(r[field], fixes))
    .sort((a, b) => compareVersions(a.version, b.version))[0]
}

// Classify every fixable High/Critical match. Returns { blocking, tracked }, each a list of
// { id, severity, kev, key, purl, installed, fixes, upgrade?, reason }. `kev` marks a CVE on
// CISA's Known Exploited Vulnerabilities list; it does not change the class (blocking cannot ship
// a fix no stable Electron has), but the summary puts it in front of whoever reads it.
export function classify(report, releases) {
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('Electron release metadata is missing or empty; refusing to classify (fail closed).')
  }
  const blocking = []
  const tracked = []
  const seen = new Set()
  for (const m of report.matches || []) {
    const v = m.vulnerability || {}
    if (!BLOCKING_SEVERITIES.has(v.severity)) continue
    if (v.fix?.state !== 'fixed' || !v.fix.versions?.length) continue
    const key = componentKey(m.artifact)
    const dedupe = `${v.id}|${m.artifact?.purl}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const item = {
      id: v.id,
      severity: v.severity,
      kev: (v.knownExploited || []).length > 0,
      key,
      purl: m.artifact?.purl,
      installed: m.artifact?.version,
      fixes: v.fix.versions
    }
    if (!(key in RUNTIME_FIELD)) {
      blocking.push({ ...item, reason: `not supplied by Electron; update ${key} to ${item.fixes.join(' or ')}` })
      continue
    }
    const upgrade = stableUpgrade(key, item.fixes, releases)
    if (upgrade) {
      blocking.push({
        ...item,
        upgrade: upgrade.version,
        reason: `stable Electron ${upgrade.version} bundles ${key} ${upgrade[RUNTIME_FIELD[key]]}`
      })
    } else {
      tracked.push({ ...item, reason: `no stable Electron bundles ${key} at or above ${item.fixes.join(' or ')}` })
    }
  }
  const order = (a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id)
  return { blocking: blocking.sort(order), tracked: tracked.sort(order) }
}

// The release's VEX document: the repo's hand-maintained assessments, plus one generated
// `affected` statement per TRACKED finding. A hand-written statement for the same CVE + product
// wins (it is a deliberate assessment; the generated one is a default). Per-release @id, since
// each release publishes a different set.
export function buildReleaseVex(baseDoc, tracked, { release, now }) {
  const existing = new Set(
    (baseDoc.statements || []).flatMap((s) =>
      (s.products || []).map((p) => `${s.vulnerability?.name}|${p['@id']}`)
    )
  )
  const generated = tracked
    .filter((t) => !existing.has(`${t.id}|${t.purl}`))
    .map((t) => ({
      vulnerability: { name: t.id },
      products: [{ '@id': t.purl }],
      status: 'affected',
      action_statement:
        `Fixed upstream in ${t.key} ${t.fixes.join(' or ')}. No stable Electron release bundles that ` +
        `version yet (Houston ships ${t.key} ${t.installed}), and Houston does not ship pre-release ` +
        'runtimes. The fix will ship in the first Houston release after a stable Electron carrying it is published.',
      timestamp: now
    }))
  return {
    ...baseDoc,
    '@id': release ? `${baseDoc['@id']}/v${release}` : baseDoc['@id'],
    last_updated: now,
    statements: [...(baseDoc.statements || []), ...generated]
  }
}

export function renderSummary({ blocking, tracked }) {
  const lines = ['## Native-layer vulnerability policy', '']
  const table = (rows) => [
    '| CVE | Severity | Component | Installed | Fixed in | Why |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.severity}${r.kev ? ' (KEV)' : ''} | ${r.key} | ${r.installed} | ${r.fixes.join(', ')} | ${r.reason} |`)
  ]
  if (blocking.length) {
    lines.push(`**Blocking: ${blocking.length}** (a stable fix exists; upgrade before releasing)`, '', ...table(blocking), '')
  } else {
    lines.push('**Blocking: 0**', '')
  }
  const bySev = (s) => tracked.filter((t) => t.severity === s).length
  const kev = tracked.filter((t) => t.kev).length
  lines.push(
    `**Tracked, not blocking: ${tracked.length}** (${bySev('Critical')} Critical, ${bySev('High')} High; ` +
      'no stable Electron carries the fix yet)'
  )
  if (kev) {
    lines.push('', `**${kev} tracked finding${kev === 1 ? ' is' : 's are'} on CISA's Known Exploited Vulnerabilities list** (marked KEV). Take the stable Electron that fixes ${kev === 1 ? 'it' : 'them'} as soon as it ships.`)
  }
  if (tracked.length) lines.push('', '<details><summary>Tracked findings</summary>', '', ...table(tracked), '', '</details>')
  return lines.join('\n') + '\n'
}

// Pre-build SBOM: the three runtime components, with the purl/CPE binary-sbom.mjs would give them,
// at the versions the lockfile's Electron release is published with.
export function prebuildSbom(electronVersion, releases) {
  const rel = releases.find((r) => r.version === electronVersion)
  if (!rel) throw new Error(`Electron ${electronVersion} is not in the release metadata (fail closed).`)
  const versions = { electron: rel.version, chromium: rel.chrome, node: rel.node }
  const components = EXPECTED_BINARIES.filter((s) => s.key in versions).map((s) => {
    const version = versions[s.key]
    if (!version) throw new Error(`Electron ${electronVersion} metadata has no ${s.key} version (fail closed).`)
    const c = { type: s.type, 'bom-ref': s.purl(version), name: s.name, version, purl: s.purl(version) }
    if (s.cpe) c.cpe = s.cpe(version)
    return c
  })
  return { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components }
}

// Shape grype's SARIF for GitHub code scanning. Grype emits every severity with an EMPTY file
// location (an SBOM scan has no source file). Keep the High/Critical results the policy acts on
// (selected via the grype JSON, not by parsing SARIF prose) and anchor each to the lockfile line
// that pins Electron: that is the line a fix changes, and code scanning needs a real path.
export function shapeSarif(sarif, report, { uri, line }) {
  const keep = new Set(
    (report.matches || [])
      .filter((m) => BLOCKING_SEVERITIES.has(m.vulnerability?.severity))
      .map((m) => `${m.vulnerability.id}-${m.artifact?.name}`)
  )
  const location = {
    physicalLocation: {
      artifactLocation: { uri },
      region: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 }
    }
  }
  return {
    ...sarif,
    runs: (sarif.runs || []).map((run) => {
      const results = (run.results || [])
        .filter((r) => keep.has(r.ruleId))
        .map((r) => ({ ...r, locations: [location] }))
      const used = new Set(results.map((r) => r.ruleId))
      const rules = (run.tool?.driver?.rules || []).filter((r) => used.has(r.id))
      return { ...run, tool: { ...run.tool, driver: { ...run.tool?.driver, rules } }, results }
    })
  }
}

// 1-based line of the lockfile's Electron entry (falls back to line 1).
export function electronLockLine(lockText) {
  const i = lockText.split('\n').findIndex((l) => l.includes('"node_modules/electron": {'))
  return i >= 0 ? i + 1 : 1
}

export function lockfileElectronVersion(lock) {
  const v = lock.packages?.['node_modules/electron']?.version
  if (!v) throw new Error('package-lock.json has no node_modules/electron entry.')
  return v
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const opts = { cmd }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const val = rest[i + 1]
    if (!flag.startsWith('-') || val === undefined) throw new Error(`bad argument: ${flag}`)
    opts[flag.replace(/^-+/, '')] = val
    i++
  }
  return opts
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function main(argv) {
  const o = parseArgs(argv)
  if (o.cmd === 'sarif') {
    if (!o.report || !o.in || !o.out) throw new Error('sarif needs --report, --in and --out')
    const lockfile = o.lockfile || 'package-lock.json'
    const shaped = shapeSarif(readJson(o.in), readJson(o.report), {
      uri: lockfile,
      line: electronLockLine(readFileSync(lockfile, 'utf8'))
    })
    writeFileSync(o.out, JSON.stringify(shaped, null, 2) + '\n')
    console.log(`wrote ${o.out} (${shaped.runs.reduce((n, r) => n + r.results.length, 0)} results)`)
    return 0
  }
  if (!o.releases) throw new Error('--releases <releases.json> is required')
  const releases = readJson(o.releases)
  if (o.cmd === 'sbom') {
    if (!o.o) throw new Error('-o <out> is required')
    const electron = lockfileElectronVersion(readJson(o.lockfile || 'package-lock.json'))
    writeFileSync(o.o, JSON.stringify(prebuildSbom(electron, releases), null, 2) + '\n')
    console.log(`wrote ${o.o} (electron ${electron})`)
    return 0
  }
  if (o.cmd === 'evaluate') {
    if (!o.report) throw new Error('--report <grype.json> is required')
    const result = classify(readJson(o.report), releases)
    const summary = renderSummary(result)
    process.stdout.write(summary)
    if (o.summary) appendFileSync(o.summary, summary)
    if (o['vex-out']) {
      if (!o['vex-in']) throw new Error('--vex-out needs --vex-in')
      const doc = buildReleaseVex(readJson(o['vex-in']), result.tracked, {
        release: o.release,
        now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      writeFileSync(o['vex-out'], JSON.stringify(doc, null, 2) + '\n')
      console.log(`wrote ${o['vex-out']} (${doc.statements.length} statements)`)
    }
    for (const b of result.blocking) {
      console.log(`::error::${b.id} (${b.severity}) in ${b.key} ${b.installed}: ${b.reason}`)
    }
    return result.blocking.length ? 1 : 0
  }
  throw new Error(`unknown subcommand: ${o.cmd} (expected sbom, evaluate or sarif)`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    console.error(`::error::${e.message}`)
    process.exit(2)
  }
}

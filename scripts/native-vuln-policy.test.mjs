import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  satisfiesFix,
  isStable,
  componentKey,
  stableUpgrade,
  classify,
  buildReleaseVex,
  renderSummary,
  prebuildSbom,
  lockfileElectronVersion,
  shapeSarif,
  electronLockLine,
  parseArgs
} from './native-vuln-policy.mjs'

// A slice of releases.electronjs.org/releases.json shaped like the 2026-09-25 state: the 44
// stable line tops out on Chromium 152, and only 45 pre-releases carry Chromium 155.
const RELEASES = [
  { version: '46.0.0-nightly.20260925', chrome: '155.0.8059.0', node: '24.22.0' },
  { version: '45.0.0-alpha.12', chrome: '155.0.8046.0', node: '24.22.0' },
  { version: '44.4.5', chrome: '152.0.7977.130', node: '24.21.0' },
  { version: '44.4.3', chrome: '152.0.7977.130', node: '24.21.0' },
  { version: '44.4.1', chrome: '152.0.7977.78', node: '24.20.0' },
  { version: '43.7.5', chrome: '150.0.7871.300', node: '24.18.0' }
]

const CHROMIUM = { name: 'chromium', version: '152.0.7977.78', purl: 'pkg:generic/chromium@152.0.7977.78' }
const match = (id, severity, artifact, fixes, state = 'fixed', knownExploited) => ({
  vulnerability: { id, severity, fix: { versions: fixes, state }, ...(knownExploited && { knownExploited }) },
  artifact
})

describe('compareVersions', () => {
  it('compares 4-part Chromium versions numerically, not lexically', () => {
    expect(compareVersions('152.0.7977.130', '152.0.7977.78')).toBe(1)
    expect(compareVersions('153.0.8010.36', '152.0.9999.999')).toBe(1)
    expect(compareVersions('24.21.0', '24.21.0')).toBe(0)
    expect(compareVersions('9.0.0', '10.0.0')).toBe(-1)
  })

  it('treats a missing trailing part as zero', () => {
    expect(compareVersions('24.21', '24.21.0')).toBe(0)
  })
})

describe('satisfiesFix', () => {
  it('is fixed at or above the fix on the same line', () => {
    expect(satisfiesFix('152.0.7977.130', ['152.0.7977.130'])).toBe(true)
    expect(satisfiesFix('152.0.7977.78', ['152.0.7977.130'])).toBe(false)
  })

  it('judges each maintained line against its own fix (multi-line Node advisories)', () => {
    const fixes = ['22.20.1', '24.21.3']
    expect(satisfiesFix('24.21.3', fixes)).toBe(true)
    expect(satisfiesFix('24.21.0', fixes)).toBe(false)
    // 22.30 is above the 22 fix; being below the 24 fix must not count against it.
    expect(satisfiesFix('22.30.0', fixes)).toBe(true)
  })

  it('is fixed on a newer line than every fix, and not on an older one', () => {
    expect(satisfiesFix('155.0.8046.0', ['153.0.8010.36'])).toBe(true)
    expect(satisfiesFix('152.0.7977.130', ['153.0.8010.36'])).toBe(false)
  })

  it('is never fixed with no version or no fixes', () => {
    expect(satisfiesFix(undefined, ['1.0.0'])).toBe(false)
    expect(satisfiesFix('1.0.0', [])).toBe(false)
  })
})

describe('isStable', () => {
  it('rejects alpha, beta, and nightly builds', () => {
    expect(isStable({ version: '44.4.5' })).toBe(true)
    expect(isStable({ version: '45.0.0-alpha.12' })).toBe(false)
    expect(isStable({ version: '45.0.0-beta.1' })).toBe(false)
    expect(isStable({ version: '46.0.0-nightly.20260925' })).toBe(false)
  })
})

describe('componentKey', () => {
  it('maps each runtime purl to its binary-sbom key', () => {
    expect(componentKey({ purl: 'pkg:generic/chromium@152.0.7977.130' })).toBe('chromium')
    expect(componentKey({ purl: 'pkg:generic/node@24.21.0' })).toBe('node')
    expect(componentKey({ purl: 'pkg:npm/electron@44.4.5' })).toBe('electron')
    expect(componentKey({ purl: 'pkg:npm/node-pty@1.1.0' })).toBe('nodePty')
    expect(componentKey({ purl: 'pkg:cargo/ripgrep@15.0.0' })).toBe('ripgrep')
  })

  it('falls back to the artifact name for an unknown purl', () => {
    expect(componentKey({ name: 'mystery', purl: 'pkg:generic/mystery@1' })).toBe('mystery')
  })
})

describe('stableUpgrade', () => {
  it('finds the OLDEST stable release carrying the fix', () => {
    expect(stableUpgrade('chromium', ['152.0.7977.100'], RELEASES)?.version).toBe('44.4.3')
  })

  it('ignores pre-releases even when they are the only builds with the fix', () => {
    expect(stableUpgrade('chromium', ['153.0.8010.36'], RELEASES)).toBeUndefined()
  })

  it('uses the node field for Node advisories and the version for Electron ones', () => {
    expect(stableUpgrade('node', ['24.21.0'], RELEASES)?.version).toBe('44.4.3')
    expect(stableUpgrade('electron', ['44.4.5'], RELEASES)?.version).toBe('44.4.5')
    expect(stableUpgrade('electron', ['45.0.0-beta.1'], RELEASES)).toBeUndefined()
  })

  it('has no upgrade path for a component Electron does not supply', () => {
    expect(stableUpgrade('ripgrep', ['15.1.0'], RELEASES)).toBeUndefined()
  })
})

describe('classify', () => {
  it('BLOCKS when a stable Electron already carries the fix (we are behind)', () => {
    const { blocking, tracked } = classify({ matches: [match('CVE-1', 'High', CHROMIUM, ['152.0.7977.100'])] }, RELEASES)
    expect(tracked).toEqual([])
    expect(blocking).toHaveLength(1)
    expect(blocking[0]).toMatchObject({ id: 'CVE-1', key: 'chromium', upgrade: '44.4.3' })
    expect(blocking[0].reason).toMatch(/stable Electron 44\.4\.3 bundles chromium 152\.0\.7977\.130/)
  })

  it('TRACKS when only a pre-release carries the fix (the 2026-09-25 release failure)', () => {
    const chromium130 = { ...CHROMIUM, version: '152.0.7977.130', purl: 'pkg:generic/chromium@152.0.7977.130' }
    const { blocking, tracked } = classify(
      { matches: [match('CVE-2', 'Critical', chromium130, ['153.0.8010.36'])] },
      RELEASES
    )
    expect(blocking).toEqual([])
    expect(tracked).toHaveLength(1)
    expect(tracked[0]).toMatchObject({ id: 'CVE-2', severity: 'Critical', installed: '152.0.7977.130' })
  })

  it('flags a CISA KEV finding without changing its class', () => {
    const chromium130 = { ...CHROMIUM, version: '152.0.7977.130', purl: 'pkg:generic/chromium@152.0.7977.130' }
    const { blocking, tracked } = classify(
      {
        matches: [
          match('CVE-K', 'High', chromium130, ['153.0.8010.36'], 'fixed', [{ cve: 'CVE-K' }]),
          match('CVE-N', 'High', chromium130, ['153.0.8010.36'])
        ]
      },
      RELEASES
    )
    expect(blocking).toEqual([])
    expect(tracked.map((t) => [t.id, t.kev])).toEqual([
      ['CVE-K', true],
      ['CVE-N', false]
    ])
  })

  it('always BLOCKS a fixable finding in a component Electron does not supply', () => {
    const rg = { name: 'ripgrep', version: '15.0.0', purl: 'pkg:cargo/ripgrep@15.0.0' }
    const { blocking } = classify({ matches: [match('CVE-3', 'High', rg, ['15.0.1'])] }, RELEASES)
    expect(blocking).toHaveLength(1)
    expect(blocking[0].reason).toMatch(/not supplied by Electron; update ripgrep to 15\.0\.1/)
  })

  it('ignores Medium/Low, unfixed, and fix-less findings', () => {
    const { blocking, tracked } = classify(
      {
        matches: [
          match('CVE-M', 'Medium', CHROMIUM, ['152.0.7977.100']),
          match('CVE-L', 'Low', CHROMIUM, ['152.0.7977.100']),
          match('CVE-U', 'High', CHROMIUM, [], 'not-fixed'),
          match('CVE-W', 'High', CHROMIUM, ['152.0.7977.100'], 'wont-fix')
        ]
      },
      RELEASES
    )
    expect(blocking).toEqual([])
    expect(tracked).toEqual([])
  })

  it('counts a CVE matched twice on the same component once (grype matches purl AND CPE)', () => {
    const m = match('CVE-D', 'High', CHROMIUM, ['152.0.7977.100'])
    expect(classify({ matches: [m, m] }, RELEASES).blocking).toHaveLength(1)
  })

  it('handles a report with no matches', () => {
    expect(classify({}, RELEASES)).toEqual({ blocking: [], tracked: [] })
  })

  it('fails closed without release metadata rather than waving findings through', () => {
    expect(() => classify({ matches: [] }, [])).toThrow(/fail closed/)
    expect(() => classify({ matches: [] }, undefined)).toThrow(/fail closed/)
  })
})

describe('buildReleaseVex', () => {
  const base = {
    '@context': 'https://openvex.dev/ns/v0.2.0',
    '@id': 'https://houstoncode.ai/vex/houston',
    version: 4,
    last_updated: '2026-08-27T00:00:00Z',
    statements: [
      {
        vulnerability: { name: 'CVE-HAND' },
        products: [{ '@id': 'pkg:generic/chromium@152.0.7977.130' }],
        status: 'not_affected',
        justification: 'vulnerable_code_not_present'
      }
    ]
  }
  const tracked = [
    { id: 'CVE-HAND', key: 'chromium', purl: 'pkg:generic/chromium@152.0.7977.130', installed: '152.0.7977.130', fixes: ['153.0.8010.36'] },
    { id: 'CVE-NEW', key: 'chromium', purl: 'pkg:generic/chromium@152.0.7977.130', installed: '152.0.7977.130', fixes: ['153.0.8010.36'] }
  ]
  const now = '2026-09-25T12:00:00Z'

  it('appends an `affected` statement with an action statement per tracked finding', () => {
    const doc = buildReleaseVex(base, tracked, { release: '0.2.240', now })
    const added = doc.statements.find((s) => s.vulnerability.name === 'CVE-NEW')
    expect(added).toMatchObject({
      products: [{ '@id': 'pkg:generic/chromium@152.0.7977.130' }],
      status: 'affected',
      timestamp: now
    })
    expect(added.action_statement).toMatch(/153\.0\.8010\.36/)
    expect(added.action_statement).toMatch(/stable Electron/)
  })

  it('keeps a hand-written assessment instead of overriding it', () => {
    const doc = buildReleaseVex(base, tracked, { release: '0.2.240', now })
    const hand = doc.statements.filter((s) => s.vulnerability.name === 'CVE-HAND')
    expect(hand).toHaveLength(1)
    expect(hand[0].status).toBe('not_affected')
  })

  it('gives each release its own document id and does not mutate the repo document', () => {
    const doc = buildReleaseVex(base, tracked, { release: '0.2.240', now })
    expect(doc['@id']).toBe('https://houstoncode.ai/vex/houston/v0.2.240')
    expect(doc.last_updated).toBe(now)
    expect(doc.version).toBe(4)
    expect(base.statements).toHaveLength(1)
  })

  it('writes no extra statements and keeps the id when nothing is tracked', () => {
    const doc = buildReleaseVex({ ...base, statements: [] }, [], { now })
    expect(doc.statements).toEqual([])
    expect(doc['@id']).toBe(base['@id'])
  })

  it('keeps no public notes pointing at repo-internal paths', () => {
    const doc = buildReleaseVex(base, tracked, { release: '0.2.240', now })
    expect(JSON.stringify(doc)).not.toMatch(/\.github\/|README|scripts\//)
  })
})

describe('renderSummary', () => {
  it('reports blocking findings in a table and tracked counts by severity', () => {
    const out = renderSummary({
      blocking: [{ id: 'CVE-B', severity: 'High', key: 'chromium', installed: '1', fixes: ['2'], reason: 'r' }],
      tracked: [
        { id: 'CVE-T1', severity: 'Critical', key: 'chromium', installed: '1', fixes: ['3'], reason: 'r' },
        { id: 'CVE-T2', severity: 'High', key: 'chromium', installed: '1', fixes: ['3'], reason: 'r' }
      ]
    })
    expect(out).toMatch(/\*\*Blocking: 1\*\*/)
    expect(out).toMatch(/\| CVE-B \| High \| chromium \| 1 \| 2 \| r \|/)
    expect(out).toMatch(/Tracked, not blocking: 2\*\* \(1 Critical, 1 High;/)
    expect(out).toMatch(/<details>/)
  })

  it('marks KEV findings and calls them out above the table', () => {
    const row = { severity: 'High', key: 'chromium', installed: '1', fixes: ['3'], reason: 'r' }
    const one = renderSummary({ blocking: [], tracked: [{ ...row, id: 'CVE-K', kev: true }, { ...row, id: 'CVE-N', kev: false }] })
    expect(one).toMatch(/\| CVE-K \| High \(KEV\) \|/)
    expect(one).toMatch(/\| CVE-N \| High \|/)
    expect(one).toMatch(/\*\*1 tracked finding is on CISA's Known Exploited Vulnerabilities list\*\*/)
    const two = renderSummary({ blocking: [], tracked: [{ ...row, id: 'A', kev: true }, { ...row, id: 'B', kev: true }] })
    expect(two).toMatch(/2 tracked findings are on CISA/)
    expect(renderSummary({ blocking: [], tracked: [{ ...row, id: 'N', kev: false }] })).not.toMatch(/Known Exploited/)
  })

  it('says zero blocking and omits the tracked table when clean', () => {
    const out = renderSummary({ blocking: [], tracked: [] })
    expect(out).toMatch(/\*\*Blocking: 0\*\*/)
    expect(out).not.toMatch(/<details>/)
  })

  it('uses no em dashes (the summary is shown to people)', () => {
    const out = renderSummary({
      blocking: [{ id: 'C', severity: 'High', key: 'k', installed: '1', fixes: ['2'], reason: 'r' }],
      tracked: [{ id: 'D', severity: 'High', key: 'k', installed: '1', fixes: ['2'], reason: 'r' }]
    })
    expect(out).not.toContain('—')
  })
})

describe('prebuildSbom', () => {
  it('emits electron/chromium/node at the versions that Electron release ships, with scanner coordinates', () => {
    const sbom = prebuildSbom('44.4.5', RELEASES)
    expect(sbom.bomFormat).toBe('CycloneDX')
    const byName = Object.fromEntries(sbom.components.map((c) => [c.name, c]))
    expect(byName.electron).toMatchObject({ version: '44.4.5', purl: 'pkg:npm/electron@44.4.5' })
    expect(byName.chromium).toMatchObject({
      version: '152.0.7977.130',
      purl: 'pkg:generic/chromium@152.0.7977.130',
      cpe: 'cpe:2.3:a:google:chrome:152.0.7977.130:*:*:*:*:*:*:*'
    })
    expect(byName.node).toMatchObject({ version: '24.21.0', cpe: 'cpe:2.3:a:nodejs:node.js:24.21.0:*:*:*:*:*:*:*' })
    expect(byName.electron.cpe).toBeUndefined()
    expect(sbom.components).toHaveLength(3)
  })

  it('fails closed for an Electron version missing from the metadata', () => {
    expect(() => prebuildSbom('99.0.0', RELEASES)).toThrow(/not in the release metadata/)
  })

  it('fails closed when the metadata lacks a runtime version', () => {
    expect(() => prebuildSbom('1.0.0', [{ version: '1.0.0', chrome: '1.0' }])).toThrow(/no node version/)
  })
})

describe('lockfileElectronVersion', () => {
  it('reads the installed Electron from a v3 lockfile', () => {
    expect(lockfileElectronVersion({ packages: { 'node_modules/electron': { version: '44.4.5' } } })).toBe('44.4.5')
  })

  it('throws when the lockfile has no Electron', () => {
    expect(() => lockfileElectronVersion({ packages: {} })).toThrow(/no node_modules\/electron/)
  })
})

describe('parseArgs', () => {
  it('takes a subcommand and flag/value pairs', () => {
    expect(parseArgs(['evaluate', '--report', 'g.json', '--releases', 'r.json', '-o', 'x'])).toEqual({
      cmd: 'evaluate',
      report: 'g.json',
      releases: 'r.json',
      o: 'x'
    })
  })

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['sbom', '--releases'])).toThrow(/bad argument/)
  })
})

describe('shapeSarif', () => {
  const emptyLoc = [{ physicalLocation: { artifactLocation: { uri: '' } } }]
  const sarif = {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'grype',
            rules: [{ id: 'CVE-H-chromium' }, { id: 'CVE-C-chromium' }, { id: 'CVE-M-chromium' }]
          }
        },
        results: [
          { ruleId: 'CVE-H-chromium', locations: emptyLoc, partialFingerprints: { primaryLocationLineHash: 'grype-hash' } },
          { ruleId: 'CVE-C-chromium', locations: emptyLoc },
          { ruleId: 'CVE-M-chromium', locations: emptyLoc }
        ]
      }
    ]
  }
  const report = {
    matches: [
      match('CVE-H', 'High', CHROMIUM, ['1']),
      match('CVE-C', 'Critical', CHROMIUM, ['1']),
      match('CVE-M', 'Medium', CHROMIUM, ['1'])
    ]
  }

  it('keeps only High/Critical results and the rules they use', () => {
    const out = shapeSarif(sarif, report, { uri: 'package-lock.json', line: 42 })
    expect(out.runs[0].results.map((r) => r.ruleId)).toEqual(['CVE-H-chromium', 'CVE-C-chromium'])
    expect(out.runs[0].tool.driver.rules.map((r) => r.id)).toEqual(['CVE-H-chromium', 'CVE-C-chromium'])
    expect(out.runs[0].tool.driver.name).toBe('grype')
  })

  it('replaces the empty location with the lockfile line that pins Electron', () => {
    const out = shapeSarif(sarif, report, { uri: 'package-lock.json', line: 42 })
    for (const r of out.runs[0].results) {
      expect(r.locations).toEqual([
        {
          physicalLocation: {
            artifactLocation: { uri: 'package-lock.json' },
            region: { startLine: 42, startColumn: 1, endLine: 42, endColumn: 1 }
          }
        }
      ])
    }
  })

  it("drops grype's fingerprints so upload-sarif computes them for the new location", () => {
    const out = shapeSarif(sarif, report, { uri: 'package-lock.json', line: 42 })
    for (const r of out.runs[0].results) expect(r).not.toHaveProperty('partialFingerprints')
  })

  it('yields an empty (still valid) run when nothing is High/Critical', () => {
    const out = shapeSarif(sarif, { matches: [] }, { uri: 'package-lock.json', line: 1 })
    expect(out.runs[0].results).toEqual([])
    expect(out.runs[0].tool.driver.rules).toEqual([])
  })
})

describe('electronLockLine', () => {
  it('finds the 1-based line of the Electron entry', () => {
    expect(electronLockLine('{\n  "packages": {\n    "node_modules/electron": {\n')).toBe(3)
  })

  it('falls back to line 1', () => {
    expect(electronLockLine('{}')).toBe(1)
  })
})

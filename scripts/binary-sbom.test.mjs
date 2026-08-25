import { describe, it, expect } from 'vitest'
import {
  parseElectronVersions,
  parseRgVersion,
  parseAstGrepVersion,
  parsePlistString,
  findVersionCarriers,
  extractElectronVersions,
  findVendoredBinary,
  detectMacFrameworks,
  buildComponents,
  verifyComponents,
  assembleCycloneDx,
  assembleSpdx,
  parseArgs,
  EXPECTED_BINARIES,
  MAC_FRAMEWORKS
} from './binary-sbom.mjs'

describe('parseElectronVersions', () => {
  it('pulls electron/chromium/node from a real compiled-in user-agent + node banner', () => {
    // The exact strings a calibration run found embedded in the shipped Electron binary.
    const text =
      'Mozilla/5.0 ... Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36 ... node.js/v24.18.0 ...'
    expect(parseElectronVersions(text)).toEqual({
      electron: '43.1.0',
      chromium: '150.0.7871.47',
      node: '24.18.0'
    })
  })

  it('leaves a field undefined when its string is absent (so the floor can flag it)', () => {
    expect(parseElectronVersions('Chrome/150.0.7871.47 only')).toEqual({
      electron: undefined,
      chromium: '150.0.7871.47',
      node: undefined
    })
  })

  it('accepts a prerelease Electron tag', () => {
    expect(parseElectronVersions('Electron/44.0.0-alpha.3').electron).toBe('44.0.0-alpha.3')
  })

  it('does not match a 3-part number as a 4-part Chromium version', () => {
    expect(parseElectronVersions('Chrome/150.0.7871 truncated').chromium).toBeUndefined()
  })

  it('is safe on empty/nullish input', () => {
    expect(parseElectronVersions('')).toEqual({ electron: undefined, chromium: undefined, node: undefined })
    expect(parseElectronVersions(null)).toEqual({ electron: undefined, chromium: undefined, node: undefined })
  })
})

describe('parseRgVersion / parseAstGrepVersion', () => {
  it('parses ripgrep --version', () => {
    expect(parseRgVersion('ripgrep 15.0.0 (rev 3a612f88b8)\n\nfeatures:+pcre2')).toBe('15.0.0')
  })
  it('parses ast-grep --version', () => {
    expect(parseAstGrepVersion('ast-grep 0.44.1')).toBe('0.44.1')
  })
  it('returns undefined on unrelated output', () => {
    expect(parseRgVersion('command not found')).toBeUndefined()
    expect(parseAstGrepVersion('')).toBeUndefined()
  })
})

describe('findVersionCarriers', () => {
  // A tiny in-memory fs: dirs map to entries, files map to sizes.
  const mkFs = (tree) => {
    const dirs = new Map() // path -> [{name, kind}]
    const sizes = new Map() // path -> bytes
    for (const [path, size] of Object.entries(tree)) {
      sizes.set(path, size)
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        const name = parts[i]
        const kind = i === parts.length - 1 ? 'file' : 'dir'
        const list = dirs.get(parent) || []
        if (!list.some((x) => x.name === name)) list.push({ name, kind })
        dirs.set(parent, list)
      }
    }
    return {
      readdirSync: (dir, _opts) =>
        (dirs.get(dir) || []).map((x) => ({
          name: x.name,
          isDirectory: () => x.kind === 'dir',
          isFile: () => x.kind === 'file'
        })),
      statSync: (p) => ({ size: sizes.get(p) ?? 0 })
    }
  }

  it('returns large binaries largest-first and skips small files + the bin/ dir', () => {
    const fs = mkFs({
      '/app/Frameworks/Electron Framework': 200_000_000,
      '/app/MacOS/Houston': 40_000,
      '/app/Resources/app.asar': 24_000_000,
      '/app/Resources/bin/rg': 4_500_000, // under bin/ → skipped
      '/app/Resources/icon.icns': 120_000
    })
    expect(findVersionCarriers('/app', { fs })).toEqual([
      '/app/Frameworks/Electron Framework',
      '/app/Resources/app.asar'
    ])
  })
})

describe('extractElectronVersions', () => {
  it('scans carriers in order and stops once all three are found', () => {
    const reads = {
      '/a': 'Chrome/150.0.7871.47 Electron/43.1.0',
      '/b': 'node.js/v24.18.0',
      '/c': 'SHOULD NOT BE READ'
    }
    const seen = []
    const read = (p) => {
      seen.push(p)
      return reads[p]
    }
    expect(extractElectronVersions(['/a', '/b', '/c'], { read })).toEqual({
      electron: '43.1.0',
      chromium: '150.0.7871.47',
      node: '24.18.0'
    })
    expect(seen).toEqual(['/a', '/b']) // '/c' never read — short-circuits when complete
  })

  it('merges partial hits across carriers', () => {
    const read = (p) => (p === '/x' ? 'Electron/43.1.0' : 'Chrome/150.0.7871.47 node.js/v24.18.0')
    expect(extractElectronVersions(['/x', '/y'], { read })).toEqual({
      electron: '43.1.0',
      chromium: '150.0.7871.47',
      node: '24.18.0'
    })
  })
})

describe('findVendoredBinary', () => {
  const mkFs = (paths) => {
    const dirs = new Map()
    const files = new Set(paths)
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        const name = parts[i]
        const kind = i === parts.length - 1 ? 'file' : 'dir'
        const list = dirs.get(parent) || []
        if (!list.some((x) => x.name === name)) list.push({ name, kind })
        dirs.set(parent, list)
      }
    }
    return {
      readdirSync: (dir) =>
        (dirs.get(dir) || []).map((x) => ({
          name: x.name,
          isDirectory: () => x.kind === 'dir',
          isFile: () => x.kind === 'file'
        })),
      statSync: () => ({ size: 1 }),
      _files: files
    }
  }

  it('finds rg under Resources/bin', () => {
    const fs = mkFs(['/app/Resources/bin/rg', '/app/Resources/bin/ast-grep'])
    expect(findVendoredBinary('/app', 'rg', { fs })).toBe('/app/Resources/bin/rg')
  })

  it('finds the .exe variant on Windows layouts', () => {
    const fs = mkFs(['/app/resources/bin/rg.exe'])
    expect(findVendoredBinary('/app', 'rg', { fs })).toBe('/app/resources/bin/rg.exe')
  })

  it('returns null when absent', () => {
    const fs = mkFs(['/app/resources/bin/ast-grep'])
    expect(findVendoredBinary('/app', 'rg', { fs })).toBeNull()
  })
})

describe('buildComponents', () => {
  const resolved = {
    electron: { version: '43.1.0', hash: 'a1' },
    chromium: { version: '150.0.7871.47', hash: 'a1' },
    node: { version: '24.18.0', hash: 'a1' },
    nodePty: { version: '1.1.0', hash: 'b2' },
    ripgrep: { version: '15.0.0', hash: 'c3' },
    astGrep: { version: '0.44.1', hash: 'd4' }
  }

  it('produces one component per expected binary, with purl + platform-appropriate cpe', () => {
    const comps = buildComponents(resolved)
    expect(comps.map((c) => c.name)).toEqual([
      'electron',
      'chromium',
      'node',
      'node-pty',
      'ripgrep',
      'ast-grep'
    ])
    const chromium = comps.find((c) => c.name === 'chromium')
    expect(chromium.purl).toBe('pkg:generic/chromium@150.0.7871.47')
    expect(chromium.cpe).toBe('cpe:2.3:a:google:chrome:150.0.7871.47:*:*:*:*:*:*:*')
    expect(comps.find((c) => c.name === 'ripgrep').purl).toBe('pkg:cargo/ripgrep@15.0.0')
    // electron/node-pty/ripgrep/ast-grep carry no cpe.
    expect(comps.find((c) => c.name === 'electron').cpe).toBeUndefined()
  })

  it('keeps an unresolved component in the set (version undefined) so the floor can flag it', () => {
    const comps = buildComponents({ ...resolved, ripgrep: {} })
    const rg = comps.find((c) => c.name === 'ripgrep')
    expect(rg.version).toBeUndefined()
    expect(rg.purl).toBeUndefined()
  })
})

describe('verifyComponents (fail-closed floor)', () => {
  const full = () =>
    buildComponents({
      electron: { version: '43.1.0', hash: 'a1' },
      chromium: { version: '150.0.7871.47', hash: 'a1' },
      node: { version: '24.18.0', hash: 'a1' },
      nodePty: { version: '1.1.0', hash: 'b2' },
      ripgrep: { version: '15.0.0', hash: 'c3' },
      astGrep: { version: '0.44.1', hash: 'd4' }
    })

  it('passes when every component has a version and a hash', () => {
    const comps = full()
    expect(verifyComponents(comps)).toBe(comps)
  })

  it('throws when a component is missing a version', () => {
    const comps = full().map((c) => (c.name === 'chromium' ? { ...c, version: undefined } : c))
    expect(() => verifyComponents(comps)).toThrow(/chromium: no version/)
  })

  it('throws when a component is missing its file hash', () => {
    const comps = full().map((c) => (c.name === 'ripgrep' ? { ...c, hash: undefined } : c))
    expect(() => verifyComponents(comps)).toThrow(/ripgrep: no file hash/)
  })

  it('throws when a whole component is absent', () => {
    const comps = full().filter((c) => c.name !== 'ast-grep')
    expect(() => verifyComponents(comps)).toThrow(/ast-grep: missing entirely/)
  })

  it('reports every problem at once', () => {
    const comps = full().map((c) => (c.name === 'node' || c.name === 'ripgrep' ? { ...c, hash: undefined } : c))
    expect(() => verifyComponents(comps)).toThrow(/node: no file hash[\s\S]*ripgrep: no file hash/)
  })
})

describe('assembleCycloneDx', () => {
  const comps = buildComponents({
    electron: { version: '43.1.0', hash: 'a1' },
    chromium: { version: '150.0.7871.47', hash: 'a1' },
    node: { version: '24.18.0', hash: 'a1' },
    nodePty: { version: '1.1.0', hash: 'b2' },
    ripgrep: { version: '15.0.0', hash: 'c3' },
    astGrep: { version: '0.44.1', hash: 'd4' }
  })
  const doc = assembleCycloneDx(comps, { rootName: 'houston', version: '0.2.49' })

  it('is a CycloneDX 1.6 build-lifecycle document rooted at the product', () => {
    expect(doc.bomFormat).toBe('CycloneDX')
    expect(doc.specVersion).toBe('1.6')
    expect(doc.metadata.component.name).toBe('houston')
    expect(doc.metadata.lifecycles[0].name).toBe('build')
  })

  it('carries SHA-256 hashes, purls, and cpes on the components', () => {
    const chromium = doc.components.find((c) => c.name === 'chromium')
    expect(chromium.hashes).toEqual([{ alg: 'SHA-256', content: 'a1' }])
    expect(chromium.cpe).toBe('cpe:2.3:a:google:chrome:150.0.7871.47:*:*:*:*:*:*:*')
    expect(chromium.purl).toBe('pkg:generic/chromium@150.0.7871.47')
  })

  it('wires a dependency edge from the root to every component', () => {
    expect(doc.dependencies[0].dependsOn).toHaveLength(comps.length)
  })

  it('emits no wall-clock timestamp (deterministic output)', () => {
    expect(doc.metadata.timestamp).toBeUndefined()
  })

  it('declares the root product’s own license (Houston is Apache-2.0)', () => {
    // There is no manifest for a packaged .app, so this root is hand-built; without an
    // explicit license it would ship NOASSERTION for the very product the SBOM is about.
    expect(doc.metadata.component.licenses).toEqual([{ license: { id: 'Apache-2.0' } }])
  })
})

describe('assembleSpdx', () => {
  const comps = buildComponents({
    electron: { version: '43.1.0', hash: 'a1' },
    chromium: { version: '150.0.7871.47', hash: 'a1' },
    node: { version: '24.18.0', hash: 'a1' },
    nodePty: { version: '1.1.0', hash: 'b2' },
    ripgrep: { version: '15.0.0', hash: 'c3' },
    astGrep: { version: '0.44.1', hash: 'd4' }
  })
  const doc = assembleSpdx(comps, { rootName: 'houston', version: '0.2.49' })

  it('is an SPDX-2.3 document that DESCRIBES the root and DEPENDS_ON each component', () => {
    expect(doc.spdxVersion).toBe('SPDX-2.3')
    expect(doc.packages).toHaveLength(comps.length + 1) // + root
    const describes = doc.relationships.filter((r) => r.relationshipType === 'DESCRIBES')
    expect(describes).toHaveLength(1)
    const deps = doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON')
    expect(deps).toHaveLength(comps.length)
  })

  it('records supplier, license, checksum, and a purl externalRef per component', () => {
    const chromium = doc.packages.find((p) => p.name === 'chromium')
    expect(chromium.supplier).toBe('Organization: Google LLC')
    expect(chromium.licenseDeclared).toBe('BSD-3-Clause')
    expect(chromium.checksums).toEqual([{ algorithm: 'SHA256', checksumValue: 'a1' }])
    expect(chromium.externalRefs.some((r) => r.referenceType === 'purl')).toBe(true)
    expect(chromium.externalRefs.some((r) => r.referenceType === 'cpe23Type')).toBe(true)
  })

  it('formats a person supplier for the Rust CLIs', () => {
    expect(doc.packages.find((p) => p.name === 'ripgrep').supplier).toBe('Person: Andrew Gallant')
  })

  it('declares the root product’s own license (Houston is Apache-2.0)', () => {
    const root = doc.packages.find((p) => p.SPDXID === 'SPDXRef-Package-root')
    expect(root.licenseDeclared).toBe('Apache-2.0')
    expect(root.licenseConcluded).toBe('Apache-2.0')
  })
})

describe('parseArgs', () => {
  it('parses --app, --platform, and repeatable -o format=path', () => {
    expect(
      parseArgs([
        '--app',
        'release/mac-arm64/Houston.app',
        '--platform',
        'darwin-arm64',
        '-o',
        'cyclonedx-json=a.json',
        '-o',
        'spdx-json=b.json'
      ])
    ).toEqual({
      app: 'release/mac-arm64/Houston.app',
      platform: 'darwin-arm64',
      outputs: [
        { fmt: 'cyclonedx-json', path: 'a.json' },
        { fmt: 'spdx-json', path: 'b.json' }
      ]
    })
  })

  it('leaves platform undefined when not given', () => {
    expect(parseArgs(['--app', 'x'])).toEqual({ app: 'x', platform: undefined, outputs: [] })
  })
})

describe('EXPECTED_BINARIES', () => {
  it('covers exactly the six native components the deep SBOM attests', () => {
    expect(EXPECTED_BINARIES.map((b) => b.name)).toEqual([
      'electron',
      'chromium',
      'node',
      'node-pty',
      'ripgrep',
      'ast-grep'
    ])
  })
})

describe('parsePlistString', () => {
  it('extracts a value across the newline/tab between key and string (real plist layout)', () => {
    const xml = '<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>3.1.0</string>\n</dict>'
    expect(parsePlistString(xml, 'CFBundleShortVersionString')).toBe('3.1.0')
  })
  it('returns undefined for a missing key or empty value', () => {
    expect(parsePlistString('<dict></dict>', 'CFBundleShortVersionString')).toBeUndefined()
    expect(parsePlistString('<key>K</key><string></string>', 'K')).toBeUndefined()
    expect(parsePlistString(null, 'K')).toBeUndefined()
  })
})

describe('detectMacFrameworks', () => {
  const fw = (name) => `/app/Contents/Frameworks/${name}.framework`
  const macFs = {
    // All three frameworks present with a version + binary.
    exists: (p) => /\.framework\/(Resources\/Info\.plist|Versions\/A\/\w+)$/.test(p),
    read: (p) => {
      const ver = p.includes('ReactiveObjC') ? '3.1.0' : '1.0'
      return `<key>CFBundleShortVersionString</key>\n\t<string>${ver}</string>`
    },
    hash: (p) => `hash-of-${p.split('/').pop()}`
  }

  it('records Squirrel.Mac + ReactiveObjC + Mantle with versions, purls, and hashes', () => {
    const out = detectMacFrameworks('/app', macFs)
    expect(out.map((c) => c.name)).toEqual(['Squirrel.Mac', 'ReactiveObjC', 'Mantle'])
    const react = out.find((c) => c.name === 'ReactiveObjC')
    expect(react.version).toBe('3.1.0')
    expect(react.purl).toBe('pkg:cocoapods/ReactiveObjC@3.1.0')
    expect(react.hash).toBe('hash-of-ReactiveObjC')
    expect(out.every((c) => c.type === 'framework' && !c.cpe)).toBe(true)
  })

  it('returns [] on a Windows/Linux artifact (no .app/Frameworks) — floor unaffected', () => {
    expect(detectMacFrameworks('/win-unpacked', { exists: () => false, read: () => '', hash: () => 'h' })).toEqual([])
  })

  it('skips a framework whose plist has no version', () => {
    const fs = {
      exists: (p) => p.includes('Squirrel'),
      read: () => '<dict></dict>', // no CFBundleShortVersionString
      hash: () => 'h'
    }
    expect(detectMacFrameworks('/app', fs)).toEqual([])
  })

  it('MAC_FRAMEWORKS lists exactly the Squirrel.Mac updater stack', () => {
    expect(MAC_FRAMEWORKS.map((f) => f.framework)).toEqual(['Squirrel', 'ReactiveObjC', 'Mantle'])
  })
})

describe('platform label threading', () => {
  const comps = buildComponents({
    electron: { version: '43.1.0', hash: 'a1' },
    chromium: { version: '150.0.7871.47', hash: 'a1' },
    node: { version: '24.18.0', hash: 'a1' },
    nodePty: { version: '1.1.0', hash: 'b2' },
    ripgrep: { version: '15.0.0', hash: 'c3' },
    astGrep: { version: '0.44.1', hash: 'd4' }
  })

  it('CycloneDX records the platform as a metadata property', () => {
    const doc = assembleCycloneDx(comps, { rootName: 'houston', version: '0.2.49', platform: 'win32-x64' })
    expect(doc.metadata.properties).toEqual([{ name: 'houston:platform', value: 'win32-x64' }])
    expect(doc.metadata.component.properties).toEqual([{ name: 'houston:platform', value: 'win32-x64' }])
  })

  it('CycloneDX omits the property when no platform is given', () => {
    const doc = assembleCycloneDx(comps, { rootName: 'houston', version: '0.2.49' })
    expect(doc.metadata.properties).toBeUndefined()
  })

  it('SPDX folds the platform into name + namespace so each leg has a distinct document', () => {
    const a = assembleSpdx(comps, { rootName: 'houston', version: '0.2.49', platform: 'darwin-arm64' })
    const b = assembleSpdx(comps, { rootName: 'houston', version: '0.2.49', platform: 'linux-x64' })
    expect(a.name).toBe('houston-binary-sbom-darwin-arm64')
    expect(a.documentNamespace).not.toBe(b.documentNamespace)
    expect(a.packages.find((p) => p.SPDXID === 'SPDXRef-Package-root').comment).toBe('platform: darwin-arm64')
  })
})

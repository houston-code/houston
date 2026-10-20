import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolvePackageDir, vendoredJsDirs } from './vendored-js.mjs'

// A fake install: root/node_modules holds the hoisted packages, and one nested copy
// lives under a dependent's own node_modules (a version conflict npm couldn't hoist).
const ROOT = '/repo'
const nm = (...parts) => join(ROOT, 'node_modules', ...parts)
const files = {
  [nm('mermaid', 'package.json')]: { name: 'mermaid', dependencies: { d3: '^7', khroma: '^2' }, optionalDependencies: { 'only-on-linux': '1' } },
  [nm('d3', 'package.json')]: { name: 'd3', dependencies: { 'd3-array': '^3' } },
  [nm('d3-array', 'package.json')]: { name: 'd3-array', dependencies: { internmap: '^2' } },
  [nm('khroma', 'package.json')]: { name: 'khroma', dependencies: { 'd3-array': '^1' } },
  [nm('khroma', 'node_modules', 'd3-array', 'package.json')]: { name: 'd3-array', dependencies: {} },
  [nm('internmap', 'package.json')]: { name: 'internmap' },
  [nm('react', 'package.json')]: { name: 'react' }
}
const exists = (p) => p in files
const read = (p) => JSON.stringify(files[p])

describe('resolvePackageDir', () => {
  it('prefers a nested copy, then walks up to the hoisted one, never above the root', () => {
    expect(resolvePackageDir('d3-array', nm('khroma'), ROOT, exists)).toBe(nm('khroma', 'node_modules', 'd3-array'))
    expect(resolvePackageDir('d3-array', nm('d3'), ROOT, exists)).toBe(nm('d3-array'))
    expect(resolvePackageDir('missing', nm('d3'), ROOT, exists)).toBeNull()
  })
})

describe('vendoredJsDirs', () => {
  it('collects the vendored package and its whole dependency subtree, nested copies included', () => {
    const dirs = vendoredJsDirs(ROOT, { packages: ['mermaid'], exists, read })
    expect([...dirs].sort()).toEqual(
      [nm('mermaid'), nm('d3'), nm('d3-array'), nm('internmap'), nm('khroma'), nm('khroma', 'node_modules', 'd3-array')].sort()
    )
  })

  it('leaves out packages nothing vendored depends on, and skips uninstalled optional ones', () => {
    const dirs = vendoredJsDirs(ROOT, { packages: ['mermaid'], exists, read })
    expect(dirs.has(nm('react'))).toBe(false)
    expect([...dirs].some((d) => d.includes('only-on-linux'))).toBe(false)
  })

  it('returns nothing when the vendored package is not installed', () => {
    expect(vendoredJsDirs(ROOT, { packages: ['nope'], exists, read }).size).toBe(0)
  })
})

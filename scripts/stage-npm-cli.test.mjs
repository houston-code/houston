import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { npmManifest, PACKAGE_NAME } from './stage-npm-cli.mjs'

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'))

describe('npmManifest', () => {
  const manifest = npmManifest(rootPkg)

  it('publishes the scoped CLI package, never the private app', () => {
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(manifest.private).toBeUndefined()
  })

  it('tracks the root version, license, repository and Node floor', () => {
    expect(manifest.version).toBe(rootPkg.version)
    expect(manifest.license).toBe(rootPkg.license)
    expect(manifest.repository).toEqual(rootPkg.repository)
    expect(manifest.engines).toEqual({ node: rootPkg.engines.node })
  })

  it('installs the command as `houston` and ships only the bundle plus the Apache NOTICE', () => {
    expect(manifest.bin).toEqual({ houston: 'houston-cli.cjs' })
    expect(manifest.files).toEqual(['houston-cli.cjs', 'NOTICE'])
  })

  it('carries no dependencies or install-time scripts', () => {
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })

  it('publishes publicly with provenance', () => {
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true })
  })

  it('refuses a non-release version', () => {
    expect(() => npmManifest({ ...rootPkg, version: '0.3.0-dev' })).toThrow(/non-release/)
    expect(() => npmManifest({ ...rootPkg, version: '0.9.0-rc.1' })).toThrow(/non-release/)
    expect(() => npmManifest({ ...rootPkg, version: undefined })).toThrow(/non-release/)
  })
})

import { describe, it, expect } from 'vitest'
import {
  integrityToHex,
  normalizeAuthor,
  spdxOriginator,
  repoOwner,
  deriveSupplier,
  spdxSupplier,
  buildLockIndex,
  enrichCycloneDx,
  enrichSpdx,
  authorAsSpdxActor,
  enrichCycloneDxSelf,
  enrichSpdxSelf,
  stripCycloneDxFileNode,
  stripSpdxFileNode,
  isCopyableSpdxLicense,
  concludeSpdxLicenses,
  enrichSpdx3
} from './enrich-sbom.mjs'

const ME = { name: 'Ada Lovelace', email: 'ada@x.com', isOrg: false }
const ORG = { name: 'Acme Inc', isOrg: true }

const sha512 = (hex) => 'sha512-' + Buffer.from(hex, 'hex').toString('base64')

describe('integrityToHex', () => {
  it('round-trips an npm sha512 integrity to lowercase hex', () => {
    const hex = 'ab'.repeat(64) // 64 bytes = a sha512 digest
    expect(integrityToHex(sha512(hex))).toBe(hex)
  })

  it('returns null for non-sha512 or missing integrity', () => {
    expect(integrityToHex('sha1-abcd')).toBeNull()
    expect(integrityToHex('')).toBeNull()
    expect(integrityToHex(null)).toBeNull()
  })
})

describe('normalizeAuthor', () => {
  it('accepts a plain string', () => {
    expect(normalizeAuthor('Jane Doe')).toBe('Jane Doe')
  })

  it('formats the { name, email } object form', () => {
    expect(normalizeAuthor({ name: 'Jane', email: 'j@x.com' })).toBe('Jane <j@x.com>')
    expect(normalizeAuthor({ name: 'Jane' })).toBe('Jane')
  })

  it('returns null when there is no usable author', () => {
    expect(normalizeAuthor(null)).toBeNull()
    expect(normalizeAuthor({})).toBeNull()
    expect(normalizeAuthor('   ')).toBeNull()
  })
})

describe('spdxOriginator', () => {
  it('maps "Name <email>" to an SPDX Person originator', () => {
    expect(spdxOriginator('Jane <j@x.com>')).toBe('Person: Jane (j@x.com)')
  })

  it('handles a bare name and null', () => {
    expect(spdxOriginator('Jane')).toBe('Person: Jane')
    expect(spdxOriginator(null)).toBeNull()
  })
})

describe('repoOwner', () => {
  it('extracts the owner from a github url in various shapes', () => {
    expect(repoOwner('git+https://github.com/nodeca/argparse.git')).toBe('nodeca')
    expect(repoOwner({ url: 'git+https://github.com/vercel/ms.git' })).toBe('vercel')
    expect(repoOwner('https://github.com/isaacs/node-graceful-fs')).toBe('isaacs')
    expect(repoOwner('github:juliangruber/balanced-match')).toBe('juliangruber')
  })

  it('returns null when there is no resolvable owner', () => {
    expect(repoOwner('')).toBeNull()
    expect(repoOwner(null)).toBeNull()
    expect(repoOwner('https://example.com/x')).toBeNull()
  })
})

describe('deriveSupplier', () => {
  it('prefers a declared author (person)', () => {
    expect(deriveSupplier({ author: 'Jane <j@x.com>' }, 'foo')).toEqual({ name: 'Jane', email: 'j@x.com', isOrg: false })
  })

  it('falls back to the first contributor when no author', () => {
    expect(deriveSupplier({ contributors: [{ name: 'Con Tributor' }] }, 'foo')).toEqual({ name: 'Con Tributor', email: undefined, isOrg: false })
  })

  it('uses the npm scope as an org when no person is declared', () => {
    expect(deriveSupplier({}, '@google/genai')).toEqual({ name: 'google', isOrg: true })
  })

  it('falls back to the repository owner as an org', () => {
    expect(deriveSupplier({ repository: 'git+https://github.com/isaacs/graceful-fs.git' }, 'graceful-fs')).toEqual({ name: 'isaacs', isOrg: true })
  })

  it('returns null only when nothing is derivable', () => {
    expect(deriveSupplier({}, 'argparse')).toBeNull()
    expect(deriveSupplier(null, 'x')).toBeNull()
  })
})

describe('spdxSupplier', () => {
  it('formats org and person suppliers, and NOASSERTION for null', () => {
    expect(spdxSupplier({ name: 'google', isOrg: true })).toBe('Organization: google')
    expect(spdxSupplier({ name: 'Jane', email: 'j@x.com', isOrg: false })).toBe('Person: Jane (j@x.com)')
    expect(spdxSupplier({ name: 'Jane', isOrg: false })).toBe('Person: Jane')
    expect(spdxSupplier(null)).toBe('NOASSERTION')
  })
})

describe('buildLockIndex', () => {
  it('indexes name@version -> integrity + path, deriving scoped names from the path', () => {
    const idx = buildLockIndex({
      packages: {
        '': { name: 'root' },
        'node_modules/foo': { version: '1.0.0', integrity: 'sha512-AAA' },
        'node_modules/@s/bar': { version: '2.0.0', integrity: 'sha512-BBB' },
        'node_modules/foo/node_modules/baz': { version: '3.0.0' }
      }
    })
    expect(idx.get('foo@1.0.0')).toEqual({ integrity: 'sha512-AAA', path: 'node_modules/foo' })
    expect(idx.get('@s/bar@2.0.0').integrity).toBe('sha512-BBB')
    expect(idx.get('baz@3.0.0').integrity).toBeNull() // nested, no integrity in this fixture
    expect(idx.size).toBe(3) // the root ('') entry is skipped
  })
})

describe('enrichCycloneDx', () => {
  it('adds hash, author and supplier only for indexed components', () => {
    const hex = 'ab'.repeat(64)
    const idx = new Map([['foo@1.0.0', { integrity: sha512(hex), path: 'node_modules/foo' }]])
    const manifests = { 'node_modules/foo': { author: 'Jane <j@x.com>' } }
    const doc = {
      bomFormat: 'CycloneDX',
      components: [
        { name: 'foo', version: '1.0.0' },
        { name: 'bar', version: '9.9.9' } // not in the index
      ]
    }
    const res = enrichCycloneDx(doc, idx, (p) => manifests[p] || null)
    expect(res).toEqual({ hashes: 1, authors: 1, suppliers: 1 })
    expect(doc.components[0].hashes).toEqual([{ alg: 'SHA-512', content: hex }])
    expect(doc.components[0].author).toBe('Jane <j@x.com>')
    expect(doc.components[0].supplier).toEqual({ name: 'Jane' })
    expect(doc.components[1].hashes).toBeUndefined()
  })

  it('supplies a scope-derived org when the manifest has no author', () => {
    const idx = new Map([['@google/genai@1.0.0', { integrity: null, path: 'node_modules/@google/genai' }]])
    const doc = { components: [{ name: '@google/genai', version: '1.0.0' }] }
    const res = enrichCycloneDx(doc, idx, () => ({}))
    expect(res.suppliers).toBe(1)
    expect(doc.components[0].supplier).toEqual({ name: 'google' })
    expect(doc.components[0].author).toBeUndefined()
  })

  it('never clobbers an existing hash, author or supplier', () => {
    const idx = new Map([['foo@1.0.0', { integrity: sha512('cd'.repeat(64)), path: 'node_modules/foo' }]])
    const doc = { components: [{ name: 'foo', version: '1.0.0', hashes: [{ alg: 'MD5', content: 'x' }], author: 'Existing', supplier: { name: 'Existing' } }] }
    const res = enrichCycloneDx(doc, idx, () => ({ author: 'Jane' }))
    expect(res).toEqual({ hashes: 0, authors: 0, suppliers: 0 })
    expect(doc.components[0].author).toBe('Existing')
  })
})

describe('enrichSpdx', () => {
  it('adds checksum, originator and supplier', () => {
    const hex = 'cd'.repeat(64)
    const idx = new Map([['foo@1.0.0', { integrity: sha512(hex), path: 'node_modules/foo' }]])
    const doc = {
      spdxVersion: 'SPDX-2.3',
      packages: [{ name: 'foo', versionInfo: '1.0.0', originator: 'NOASSERTION', supplier: 'NOASSERTION' }]
    }
    const res = enrichSpdx(doc, idx, () => ({ author: 'Jane <j@x.com>' }))
    expect(res).toEqual({ hashes: 1, authors: 1, suppliers: 1 })
    expect(doc.packages[0].checksums).toEqual([{ algorithm: 'SHA512', checksumValue: hex }])
    expect(doc.packages[0].originator).toBe('Person: Jane (j@x.com)')
    expect(doc.packages[0].supplier).toBe('Person: Jane (j@x.com)')
  })

  it('leaves supplier as NOASSERTION when nothing is derivable', () => {
    const idx = new Map([['argparse@2.0.1', { integrity: null, path: 'node_modules/argparse' }]])
    const doc = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'argparse', versionInfo: '2.0.1', supplier: 'NOASSERTION' }] }
    const res = enrichSpdx(doc, idx, () => ({}))
    expect(res.suppliers).toBe(0)
    expect(doc.packages[0].supplier).toBe('NOASSERTION')
  })
})

describe('enrichSpdx3', () => {
  it('sets sbomType, gives every package a supplier via Agents, and dedupes shared suppliers', () => {
    const doc = {
      '@graph': [
        { type: 'software_Sbom', element: [], software_sbomType: [] },
        { type: 'software_Package', name: 'houston', software_packageVersion: '1.0.0', creationInfo: '_:C' },
        { type: 'software_Package', name: 'dep-a', software_packageVersion: '2.0.0', creationInfo: '_:C' },
        { type: 'software_Package', name: 'dep-b', software_packageVersion: '3.0.0', creationInfo: '_:C' }
      ]
    }
    const index = new Map([
      ['dep-a@2.0.0', { path: 'node_modules/dep-a' }],
      ['dep-b@3.0.0', { path: 'node_modules/dep-b' }]
    ])
    // Both deps resolve to the same org owner "acme" → one shared Agent.
    const manifests = { 'node_modules/dep-a': { repository: 'github:acme/a' }, 'node_modules/dep-b': { repository: 'github:acme/b' } }
    const r = enrichSpdx3(doc, index, (p) => manifests[p] || null, 'houston', { name: 'Me', isOrg: false })
    const g = doc['@graph']
    expect(g.find((e) => e.type === 'software_Sbom').software_sbomType).toEqual(['source'])
    expect(g.filter((e) => e.type === 'software_Package').every((p) => p.suppliedBy)).toBe(true)
    // root → Person "Me"; both deps → one shared Organization "acme"
    const agents = g.filter((e) => e.type === 'Person' || e.type === 'Organization')
    expect(agents.map((a) => a.name).sort()).toEqual(['Me', 'acme'])
    expect(r).toMatchObject({ suppliers: 3, agents: 2 })
    // agents are registered on the Sbom element
    expect(g.find((e) => e.type === 'software_Sbom').element.length).toBe(2)
  })
})

describe('stripCycloneDxFileNode', () => {
  it('drops the file node + product-as-component and promotes the product to primary', () => {
    const doc = {
      bomFormat: 'CycloneDX',
      metadata: { component: { name: 'package-lock.json', type: 'file', 'bom-ref': 'FILE' } },
      components: [
        { name: 'houston', type: 'library', 'bom-ref': 'H' },
        { name: 'package-lock.json', type: 'file', 'bom-ref': 'FILE' },
        { name: 'dep', type: 'library', 'bom-ref': 'D' }
      ],
      dependencies: [
        { ref: 'H', dependsOn: ['D'] },
        { ref: 'FILE', dependsOn: ['H'] },
        { ref: 'D', dependsOn: [] }
      ]
    }
    stripCycloneDxFileNode(doc, 'houston')
    expect(doc.metadata.component.name).toBe('houston')
    expect(doc.components.map((c) => c.name)).toEqual(['dep']) // file + product removed
    expect(doc.dependencies.map((d) => d.ref)).toEqual(['H', 'D']) // FILE node dropped
    expect(doc.dependencies.find((d) => d.ref === 'H').dependsOn).toEqual(['D'])
  })
})

describe('isCopyableSpdxLicense', () => {
  it('accepts SPDX ids, LicenseRefs, and OR/AND/WITH expressions', () => {
    expect(isCopyableSpdxLicense('MIT')).toBe(true)
    expect(isCopyableSpdxLicense('BSD-3-Clause')).toBe(true)
    expect(isCopyableSpdxLicense('LicenseRef-SEE-LICENSE-IN-LICENSE')).toBe(true)
    expect(isCopyableSpdxLicense('(MIT OR Apache-2.0)')).toBe(true)
    expect(isCopyableSpdxLicense('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(true)
  })

  it('rejects NOASSERTION/NONE/empty and free text without operators', () => {
    expect(isCopyableSpdxLicense('NOASSERTION')).toBe(false)
    expect(isCopyableSpdxLicense('NONE')).toBe(false)
    expect(isCopyableSpdxLicense('')).toBe(false)
    expect(isCopyableSpdxLicense(null)).toBe(false)
    expect(isCopyableSpdxLicense('SEE LICENSE IN LICENSE')).toBe(false) // free text, no operator
  })
})

describe('concludeSpdxLicenses', () => {
  it('copies a valid declared license to concluded, skips free text and existing values', () => {
    const doc = {
      packages: [
        { name: 'a', licenseDeclared: 'MIT', licenseConcluded: 'NOASSERTION' },
        { name: 'b', licenseDeclared: 'SEE LICENSE IN LICENSE', licenseConcluded: 'NOASSERTION' },
        { name: 'c', licenseDeclared: 'ISC', licenseConcluded: 'MIT' } // already concluded — untouched
      ]
    }
    const n = concludeSpdxLicenses(doc)
    expect(n).toBe(1)
    expect(doc.packages[0].licenseConcluded).toBe('MIT')
    expect(doc.packages[1].licenseConcluded).toBe('NOASSERTION') // free text not asserted
    expect(doc.packages[2].licenseConcluded).toBe('MIT') // not clobbered
  })
})

describe('stripSpdxFileNode', () => {
  it('removes the file package + its CONTAINS edges and redirects DESCRIBES to the product', () => {
    const doc = {
      spdxVersion: 'SPDX-2.3',
      packages: [
        { name: 'houston', SPDXID: 'SPDXRef-Package-npm-houston-x' },
        { name: 'package-lock.json', SPDXID: 'SPDXRef-DocumentRoot-File-package-lock.json' },
        { name: 'dep', SPDXID: 'SPDXRef-Package-npm-dep' }
      ],
      relationships: [
        { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: 'SPDXRef-DocumentRoot-File-package-lock.json', relationshipType: 'DESCRIBES' },
        { spdxElementId: 'SPDXRef-DocumentRoot-File-package-lock.json', relatedSpdxElement: 'SPDXRef-Package-npm-dep', relationshipType: 'CONTAINS' },
        { spdxElementId: 'SPDXRef-Package-npm-dep', relatedSpdxElement: 'SPDXRef-Package-npm-houston-x', relationshipType: 'DEPENDENCY_OF' }
      ]
    }
    stripSpdxFileNode(doc, 'houston')
    expect(doc.packages.map((p) => p.name)).toEqual(['houston', 'dep'])
    expect(doc.relationships.find((r) => r.relationshipType === 'DESCRIBES').relatedSpdxElement).toBe('SPDXRef-Package-npm-houston-x')
    expect(doc.relationships.some((r) => r.relationshipType === 'CONTAINS')).toBe(false)
    expect(doc.relationships.some((r) => r.relationshipType === 'DEPENDENCY_OF')).toBe(true)
  })
})

describe('authorAsSpdxActor', () => {
  it('formats a person and an organization', () => {
    expect(authorAsSpdxActor(ME)).toBe('Person: Ada Lovelace (ada@x.com)')
    expect(authorAsSpdxActor(ORG)).toBe('Organization: Acme Inc')
    expect(authorAsSpdxActor({ name: 'Nobody', isOrg: false })).toBe('Person: Nobody')
  })
})

describe('enrichCycloneDxSelf', () => {
  it('sets metadata authors, the primary component supplier, and root/file suppliers', () => {
    const doc = {
      metadata: { component: { name: 'package-lock.json', type: 'file' } },
      components: [
        { name: 'houston', type: 'library' }, // the root product
        { name: 'package-lock.json', type: 'file' }, // syft's scanned-file node
        { name: 'dep', type: 'library', supplier: { name: 'someone' } } // untouched
      ]
    }
    const n = enrichCycloneDxSelf(doc, 'houston', ME)
    expect(n).toBe(2)
    expect(doc.metadata.authors).toEqual([{ name: 'Ada Lovelace', email: 'ada@x.com' }])
    expect(doc.metadata.lifecycles[0].name).toBe('source')
    expect(doc.metadata.component.supplier).toEqual({ name: 'Ada Lovelace' })
    expect(doc.components[0].supplier).toEqual({ name: 'Ada Lovelace' })
    expect(doc.components[1].supplier).toEqual({ name: 'Ada Lovelace' })
    expect(doc.components[2].supplier).toEqual({ name: 'someone' }) // not clobbered
  })
})

describe('enrichSpdxSelf', () => {
  it('prepends a creator and sets the root + file-node supplier', () => {
    const doc = {
      creationInfo: { creators: ['Tool: syft-1.0'] },
      packages: [
        { name: 'houston', SPDXID: 'SPDXRef-Package-npm-houston-abc', supplier: 'NOASSERTION' },
        { name: 'package-lock.json', SPDXID: 'SPDXRef-DocumentRoot-File-package-lock.json' },
        { name: 'dep', SPDXID: 'SPDXRef-Package-npm-dep', supplier: 'Organization: x' }
      ]
    }
    const n = enrichSpdxSelf(doc, 'houston', ME)
    expect(n).toBe(2)
    expect(doc.creationInfo.creators).toEqual(['Person: Ada Lovelace (ada@x.com)', 'Tool: syft-1.0'])
    expect(doc.packages[0].supplier).toBe('Person: Ada Lovelace (ada@x.com)')
    expect(doc.packages[1].supplier).toBe('Person: Ada Lovelace (ada@x.com)')
    expect(doc.packages[2].supplier).toBe('Organization: x') // not clobbered
  })
})

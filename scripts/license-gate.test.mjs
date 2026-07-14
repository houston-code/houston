import { describe, it, expect } from 'vitest'
import {
  parseLicenseExpression,
  expressionSatisfies,
  isForbiddenId,
  isAllowedToShipId,
  detectForbiddenText,
  classifyLicense,
  evaluatePackages,
  loadExceptions,
  ALLOWED_TO_SHIP,
  FORBIDDEN_ID_PATTERNS
} from './license-gate.mjs'

describe('parseLicenseExpression', () => {
  it('parses a single id', () => {
    expect(parseLicenseExpression('MIT')).toEqual({ id: 'MIT' })
  })

  it('parses OR / AND with correct precedence (AND binds tighter)', () => {
    expect(parseLicenseExpression('MIT OR Unlicense')).toEqual({
      op: 'OR',
      left: { id: 'MIT' },
      right: { id: 'Unlicense' }
    })
    const t = parseLicenseExpression('MIT OR Zlib AND ISC')
    expect(t.op).toBe('OR')
    expect(t.right.op).toBe('AND')
  })

  it('parses parenthesized expressions', () => {
    expect(parseLicenseExpression('(MIT OR CC0-1.0)')).toEqual({
      op: 'OR',
      left: { id: 'MIT' },
      right: { id: 'CC0-1.0' }
    })
    expect(parseLicenseExpression('(MIT AND (ISC OR Zlib))')).toBeTruthy()
  })

  it('parses WITH exceptions onto the leaf', () => {
    expect(parseLicenseExpression('Apache-2.0 WITH LLVM-exception')).toEqual({
      id: 'Apache-2.0',
      exception: 'LLVM-exception'
    })
  })

  it('is case-insensitive about the keywords', () => {
    expect(parseLicenseExpression('WTFPL or ISC')).toEqual({
      op: 'OR',
      left: { id: 'WTFPL' },
      right: { id: 'ISC' }
    })
  })

  it('rejects prose and malformed expressions', () => {
    expect(parseLicenseExpression('SEE LICENSE IN LICENSE')).toBeNull()
    expect(parseLicenseExpression('MIT OR')).toBeNull()
    expect(parseLicenseExpression('(MIT')).toBeNull()
    expect(parseLicenseExpression('MIT )')).toBeNull()
    expect(parseLicenseExpression('')).toBeNull()
    expect(parseLicenseExpression(undefined)).toBeNull()
    expect(parseLicenseExpression('Apache License 2.0')).toBeNull()
  })
})

describe('expressionSatisfies', () => {
  const allowMIT = (id) => id === 'MIT'
  it('OR needs one satisfiable branch, AND needs both', () => {
    expect(expressionSatisfies(parseLicenseExpression('MIT OR GPL-3.0'), allowMIT)).toBe(true)
    expect(expressionSatisfies(parseLicenseExpression('MIT AND GPL-3.0'), allowMIT)).toBe(false)
    expect(expressionSatisfies(parseLicenseExpression('GPL-3.0 OR LGPL-2.1'), allowMIT)).toBe(false)
  })

  it('judges a WITH leaf by its base id', () => {
    expect(expressionSatisfies(parseLicenseExpression('MIT WITH Autoconf-exception-2.0'), allowMIT)).toBe(true)
  })
})

describe('policy predicates', () => {
  it('forbids the AGPL/SSPL/source-available family, including -only/-or-later/+ forms', () => {
    for (const id of [
      'AGPL-3.0',
      'AGPL-3.0-only',
      'AGPL-3.0-or-later',
      'AGPL-1.0+',
      'SSPL-1.0',
      'BUSL-1.1',
      'Elastic-2.0',
      'Parity-7.0.0',
      'Prosperity-3.0.0',
      'FSL-1.1-MIT',
      'CC-BY-NC-4.0',
      'CC-BY-NC-SA-4.0',
      'Hippocratic-2.1',
      'RSALv2'
    ]) {
      expect(isForbiddenId(id), id).toBe(true)
    }
  })

  it('does not forbid permissive near-misses', () => {
    for (const id of ['MIT', 'BSL-1.0', 'CC-BY-4.0', 'Apache-2.0', 'Unlicense', 'GPL-3.0', 'LGPL-2.1']) {
      expect(isForbiddenId(id), id).toBe(false)
    }
  })

  it('allowlists permissive ids case-insensitively and never GPL/MPL/unknown', () => {
    expect(isAllowedToShipId('mit')).toBe(true)
    expect(isAllowedToShipId('BSD-3-CLAUSE')).toBe(true)
    expect(isAllowedToShipId('GPL-3.0-only')).toBe(false)
    expect(isAllowedToShipId('LGPL-3.0')).toBe(false)
    expect(isAllowedToShipId('MPL-2.0')).toBe(false)
    expect(isAllowedToShipId('UNKNOWN')).toBe(false)
    expect(isAllowedToShipId('UNLICENSED')).toBe(false)
  })

  it('keeps the allowlist and forbidden patterns disjoint', () => {
    for (const id of ALLOWED_TO_SHIP) {
      expect(FORBIDDEN_ID_PATTERNS.some((p) => p.test(id)), id).toBe(false)
    }
  })

  it('detects forbidden license names in prose but not permissive boilerplate', () => {
    expect(detectForbiddenText('GNU AFFERO GENERAL PUBLIC LICENSE Version 3')).toBe(true)
    expect(detectForbiddenText('Licensed under the Server Side Public License v1')).toBe(true)
    expect(detectForbiddenText('Business Source License 1.1')).toBe(true)
    // Permissive texts routinely say "commercial or non-commercial" (Unlicense, CC0).
    expect(detectForbiddenText('free to use for any purpose, commercial or non-commercial')).toBe(false)
    expect(detectForbiddenText('MIT License\nPermission is hereby granted...')).toBe(false)
    expect(detectForbiddenText(null)).toBe(false)
  })
})

describe('classifyLicense', () => {
  it('passes permissive licenses and expressions in both closures', () => {
    for (const production of [true, false]) {
      expect(classifyLicense('MIT', { production })).toBe('ok')
      expect(classifyLicense('MIT OR Unlicense', { production })).toBe('ok')
      expect(classifyLicense('(WTFPL OR MIT)', { production })).toBe('ok')
      expect(classifyLicense('Apache-2.0 WITH LLVM-exception', { production })).toBe('ok')
      expect(classifyLicense('BSL-1.0', { production })).toBe('ok')
    }
  })

  it('forbids AGPL-family everywhere', () => {
    expect(classifyLicense('AGPL-3.0-only', { production: true })).toBe('forbidden')
    expect(classifyLicense('AGPL-3.0-only', { production: false })).toBe('forbidden')
    expect(classifyLicense('SSPL-1.0', { production: false })).toBe('forbidden')
  })

  it('handles dual licenses semantically: OR escapes, AND does not', () => {
    expect(classifyLicense('MIT OR AGPL-3.0', { production: true })).toBe('ok')
    expect(classifyLicense('MIT AND AGPL-3.0', { production: true })).toBe('forbidden')
    expect(classifyLicense('MIT AND AGPL-3.0', { production: false })).toBe('forbidden')
  })

  it('blocks non-allowlisted licenses from shipping but only flags them for review in dev', () => {
    for (const lic of ['GPL-3.0-only', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0', 'UNKNOWN', 'SEE LICENSE IN LICENSE']) {
      expect(classifyLicense(lic, { production: true }), lic).toBe('blocked')
      expect(classifyLicense(lic, { production: false }), lic).toBe('review')
    }
  })

  it('forbids a prose license field that names a forbidden license', () => {
    expect(classifyLicense('GNU Affero General Public License v3', { production: false })).toBe('forbidden')
  })
})

describe('evaluatePackages', () => {
  const mit = { name: 'a', version: '1.0.0', license: 'MIT', production: true }
  const agplDev = { name: 'b', version: '2.0.0', license: 'AGPL-3.0-only', production: false }
  const gplProd = { name: 'c', version: '3.0.0', license: 'GPL-3.0-only', production: true }
  const gplDev = { name: 'd', version: '4.0.0', license: 'GPL-3.0-only', production: false }

  it('splits errors (forbidden + blocked) from warnings (dev review)', () => {
    const { errors, warnings } = evaluatePackages([mit, agplDev, gplProd, gplDev])
    expect(errors.map((e) => e.name).sort()).toEqual(['b', 'c'])
    expect(errors.find((e) => e.name === 'b').verdict).toBe('forbidden')
    expect(errors.find((e) => e.name === 'c').verdict).toBe('blocked')
    expect(warnings.map((w) => w.name)).toEqual(['d'])
  })

  it('honors an exception matched on name + exact license + closure', () => {
    const exc = [{ name: 'c', license: 'GPL-3.0-only', closure: 'production', reason: 'r' }]
    const { errors, unusedExceptions } = evaluatePackages([gplProd], exc)
    expect(errors).toEqual([])
    expect(unusedExceptions).toEqual([])
  })

  it('does not apply an exception across closures or license strings', () => {
    const wrongClosure = [{ name: 'd', license: 'GPL-3.0-only', closure: 'production', reason: 'r' }]
    expect(evaluatePackages([gplDev], wrongClosure).warnings).toHaveLength(1)
    const wrongLicense = [{ name: 'c', license: 'GPL-2.0-only', closure: 'production', reason: 'r' }]
    expect(evaluatePackages([gplProd], wrongLicense).errors).toHaveLength(1)
  })

  it('never lets an exception override a tier-1 forbidden license', () => {
    const exc = [{ name: 'b', license: 'AGPL-3.0-only', closure: 'dev', reason: 'nope' }]
    const { errors, unusedExceptions } = evaluatePackages([agplDev], exc)
    expect(errors).toHaveLength(1)
    expect(unusedExceptions).toEqual(exc)
  })

  it('reports unused exceptions so the file cannot rot', () => {
    const exc = [{ name: 'ghost', license: 'MIT', closure: 'dev', reason: 'gone' }]
    expect(evaluatePackages([mit], exc).unusedExceptions).toEqual(exc)
  })

  it('upgrades a vague license field to forbidden when the LICENSE text names one', () => {
    const shady = { name: 'e', version: '1.0.0', license: 'SEE LICENSE IN LICENSE', production: false, dir: '/x' }
    const { errors } = evaluatePackages([shady], [], {
      readLicenseTextFor: () => 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3'
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].verdict).toBe('forbidden')
  })

  it('does not read license text for cleanly allowed packages', () => {
    let reads = 0
    evaluatePackages([mit], [], {
      readLicenseTextFor: () => {
        reads++
        return null
      }
    })
    expect(reads).toBe(0)
  })
})

describe('loadExceptions', () => {
  it('accepts a well-formed file', () => {
    const list = [{ name: 'x', license: 'MPL-2.0', closure: 'production', reason: 'reviewed' }]
    expect(loadExceptions({ exceptions: list })).toEqual(list)
    expect(loadExceptions({ exceptions: [] })).toEqual([])
  })

  it('rejects a missing exceptions array', () => {
    expect(() => loadExceptions({})).toThrow(/exceptions/)
    expect(() => loadExceptions(null)).toThrow(/exceptions/)
  })

  it('rejects entries missing required fields or with a bad closure', () => {
    expect(() => loadExceptions({ exceptions: [{ name: 'x', license: 'MIT', closure: 'production' }] })).toThrow(
      /reason/
    )
    expect(() =>
      loadExceptions({ exceptions: [{ name: 'x', license: 'MIT', closure: 'prod', reason: 'r' }] })
    ).toThrow(/closure/)
  })
})

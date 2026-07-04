import { describe, expect, it } from 'vitest'
import { nodeVersionError } from './index'

describe('nodeVersionError', () => {
  it('returns null when the runtime is new enough', () => {
    expect(nodeVersionError('v22.0.0')).toBeNull()
    expect(nodeVersionError('v24.3.1')).toBeNull()
    expect(nodeVersionError('v22.22.3')).toBeNull()
  })

  it('reports an actionable error on an older runtime', () => {
    const err = nodeVersionError('v18.19.0')
    expect(err).not.toBeNull()
    expect(err).toContain('Node 22')
    expect(err).toContain('v18.19.0')
  })

  it('honors a custom minimum', () => {
    expect(nodeVersionError('v20.0.0', 22)).toContain('Node 22')
    expect(nodeVersionError('v20.0.0', 20)).toBeNull()
  })

  it('does not block on an unparseable version string', () => {
    expect(nodeVersionError('not-a-version')).toBeNull()
    expect(nodeVersionError('')).toBeNull()
  })
})

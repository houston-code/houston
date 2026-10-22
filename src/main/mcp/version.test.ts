import { describe, expect, it } from 'vitest'
import { version as PKG_VERSION } from '../../../package.json'
import {
  LATEST_PROTOCOL_VERSION,
  McpUnsupportedProtocolError,
  SUPPORTED_PROTOCOL_VERSIONS,
  initializeParams,
  negotiatedProtocolVersion,
  supportsElicitation
} from './version'

describe('MCP protocol-version negotiation', () => {
  it('requests the newest supported version', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
    expect([...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse()).toEqual([...SUPPORTED_PROTOCOL_VERSIONS])
    expect(initializeParams({ elicitation: false }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('accepts every supported version the server answers with', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiatedProtocolVersion({ protocolVersion: v, capabilities: {} })).toBe(v)
    }
  })

  it('rejects a version outside the supported list', () => {
    expect(() => negotiatedProtocolVersion({ protocolVersion: '2023-01-01' })).toThrow(McpUnsupportedProtocolError)
    expect(() => negotiatedProtocolVersion({ protocolVersion: '2099-12-31' })).toThrow(/does not support/)
    expect(() => negotiatedProtocolVersion({ protocolVersion: 20250618 })).toThrow(McpUnsupportedProtocolError)
  })

  it('caps the server-supplied version echoed into the error', () => {
    const err = (() => {
      try {
        negotiatedProtocolVersion({ protocolVersion: 'x'.repeat(10_000) })
      } catch (e) {
        return e as McpUnsupportedProtocolError
      }
      throw new Error('expected a throw')
    })()
    expect(err.message.length).toBeLessThan(300)
  })

  it('assumes the oldest version when the server omits it', () => {
    expect(negotiatedProtocolVersion({})).toBe('2024-11-05')
    expect(negotiatedProtocolVersion(null)).toBe('2024-11-05')
  })

  it('gates elicitation on 2025-06-18 and later', () => {
    expect(supportsElicitation('2024-11-05')).toBe(false)
    expect(supportsElicitation('2025-03-26')).toBe(false)
    expect(supportsElicitation('2025-06-18')).toBe(true)
  })

  it('declares elicitation only when asked, and sends the real app version', () => {
    expect(initializeParams({ elicitation: true }).capabilities).toEqual({ elicitation: {} })
    expect(initializeParams({ elicitation: false }).capabilities).toEqual({})
    expect(initializeParams({ elicitation: false }).clientInfo).toEqual({ name: 'Houston', version: PKG_VERSION })
  })
})

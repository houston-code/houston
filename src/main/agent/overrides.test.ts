import { describe, it, expect, afterEach } from 'vitest'
import {
  overrideForConversation,
  grantConversationOverride,
  grantConversationNetworkHost,
  grantConversationShellNetwork,
  clearConversationOverride,
  emptyOverride
} from './overrides'

const CONV = 'conv-1'

afterEach(() => clearConversationOverride(CONV))

describe('conversation overrides', () => {
  it('starts empty for an unknown conversation and for a headless run', () => {
    expect(overrideForConversation('never-seen')).toEqual(emptyOverride())
    expect(overrideForConversation(undefined)).toEqual(emptyOverride())
  })

  it('remembers a grant so a later turn of the same conversation inherits it', () => {
    grantConversationOverride(CONV, 'write', false)
    const next = overrideForConversation(CONV)
    expect(next.grants.has('write')).toBe(true)
    expect(next.unsandboxedShell).toBe(false)
  })

  it('is per-kind: granting one kind does not grant another', () => {
    grantConversationOverride(CONV, 'network', false)
    const next = overrideForConversation(CONV)
    expect(next.grants.has('network')).toBe(true)
    expect(next.grants.has('shell')).toBe(false)
    expect(next.grants.has('mcp')).toBe(false)
  })

  it('keeps tool- and server-scoped keys apart from the kind they share', () => {
    grantConversationOverride(CONV, 'write', false)
    grantConversationOverride(CONV, 'mcp:alpha', false)
    const next = overrideForConversation(CONV)
    expect(next.grants.has('tool:schedule_run')).toBe(false)
    expect(next.grants.has('mcp:beta')).toBe(false)
    expect(next.grants.has('mcp:alpha')).toBe(true)
  })

  it('accumulates grant keys across grants', () => {
    grantConversationOverride(CONV, 'write', false)
    grantConversationOverride(CONV, 'shell', false)
    expect(overrideForConversation(CONV).grants).toEqual(new Set(['write', 'shell']))
  })

  it('records unconfined-shell consent and keeps it sticky', () => {
    grantConversationOverride(CONV, 'shell', true)
    expect(overrideForConversation(CONV).unsandboxedShell).toBe(true)
    // A later grant for a different kind must not clear the prior consent.
    grantConversationOverride(CONV, 'network', false)
    expect(overrideForConversation(CONV).unsandboxedShell).toBe(true)
  })

  it('returns a copy — mutating it does not leak back into the store', () => {
    grantConversationOverride(CONV, 'write', false)
    const snapshot = overrideForConversation(CONV)
    snapshot.grants.add('shell')
    snapshot.unsandboxedShell = true
    const fresh = overrideForConversation(CONV)
    expect(fresh.grants.has('shell')).toBe(false)
    expect(fresh.unsandboxedShell).toBe(false)
  })

  it('grant is a no-op for a headless run (no conversation to remember it on)', () => {
    grantConversationOverride(undefined, 'write', false)
    expect(overrideForConversation(undefined)).toEqual(emptyOverride())
  })

  it('clear forgets a conversation’s grants', () => {
    grantConversationOverride(CONV, 'write', true)
    clearConversationOverride(CONV)
    expect(overrideForConversation(CONV)).toEqual(emptyOverride())
  })

  it('remembers per-destination network grants, and they are independent', () => {
    grantConversationNetworkHost(CONV, 'api.github.com')
    const next = overrideForConversation(CONV)
    expect(next.networkHosts.has('api.github.com')).toBe(true)
    expect(next.networkHosts.has('evil.example')).toBe(false)
    grantConversationNetworkHost(CONV, 'docs.example.com')
    expect(overrideForConversation(CONV).networkHosts).toEqual(
      new Set(['api.github.com', 'docs.example.com'])
    )
  })

  it('records the shell-network decision (grant vs decline), both sticky', () => {
    grantConversationShellNetwork(CONV, true)
    let next = overrideForConversation(CONV)
    expect(next.shellNetworkDecided).toBe(true)
    expect(next.shellNetworkGranted).toBe(true)

    clearConversationOverride(CONV)
    // A decline is remembered as "decided" but NOT granted, so later turns don't re-ask
    // yet still run shell offline.
    grantConversationShellNetwork(CONV, false)
    next = overrideForConversation(CONV)
    expect(next.shellNetworkDecided).toBe(true)
    expect(next.shellNetworkGranted).toBe(false)
  })

  it('network-host and shell-network grants are no-ops for a headless run', () => {
    grantConversationNetworkHost(undefined, 'api.github.com')
    grantConversationShellNetwork(undefined, true)
    expect(overrideForConversation(undefined)).toEqual(emptyOverride())
  })
})

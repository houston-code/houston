import { describe, it, expect, afterEach } from 'vitest'
import {
  overrideForConversation,
  grantConversationOverride,
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
    expect(next.kinds.has('write')).toBe(true)
    expect(next.unsandboxedShell).toBe(false)
  })

  it('is per-kind: granting one kind does not grant another', () => {
    grantConversationOverride(CONV, 'network', false)
    const next = overrideForConversation(CONV)
    expect(next.kinds.has('network')).toBe(true)
    expect(next.kinds.has('shell')).toBe(false)
    expect(next.kinds.has('mcp')).toBe(false)
  })

  it('accumulates kinds across grants', () => {
    grantConversationOverride(CONV, 'write', false)
    grantConversationOverride(CONV, 'shell', false)
    expect(overrideForConversation(CONV).kinds).toEqual(new Set(['write', 'shell']))
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
    snapshot.kinds.add('shell')
    snapshot.unsandboxedShell = true
    const fresh = overrideForConversation(CONV)
    expect(fresh.kinds.has('shell')).toBe(false)
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
})

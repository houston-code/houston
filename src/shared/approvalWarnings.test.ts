import { describe, expect, it } from 'vitest'
import { approvalWarnings } from './approvalWarnings'

describe('approvalWarnings', () => {
  it('lists nothing for an ordinary prompt', () => {
    expect(approvalWarnings({ kind: 'shell' })).toEqual([])
    expect(approvalWarnings({ kind: 'shell', sandboxed: true })).toEqual([])
  })

  it('warns about an unsandboxed shell command only', () => {
    expect(approvalWarnings({ kind: 'shell', sandboxed: false })).toEqual(['unsandboxed'])
    // The flag means nothing on a call that is not a shell command.
    expect(approvalWarnings({ kind: 'write', sandboxed: false })).toEqual([])
  })

  it('keeps a sensitive-file warning alongside the unsandboxed one', () => {
    expect(approvalWarnings({ kind: 'shell', sandboxed: false, sensitiveWrite: true })).toEqual([
      'unsandboxed',
      'sensitiveWrite'
    ])
    expect(approvalWarnings({ kind: 'shell', sandboxed: false, sensitiveWrite: true, protectedWrite: true })).toEqual([
      'unsandboxed',
      'protectedWrite'
    ])
    expect(approvalWarnings({ kind: 'shell', sandboxed: false, sensitiveRead: true })).toEqual([
      'unsandboxed',
      'sensitiveRead'
    ])
  })

  it('gives a control file the control-file warning instead of the credential one', () => {
    expect(approvalWarnings({ kind: 'write', sensitiveWrite: true, protectedWrite: true })).toEqual(['protectedWrite'])
    expect(approvalWarnings({ kind: 'write', sensitiveWrite: true })).toEqual(['sensitiveWrite'])
    expect(approvalWarnings({ kind: 'read', sensitiveRead: true })).toEqual(['sensitiveRead'])
  })
})

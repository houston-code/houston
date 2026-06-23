import { describe, expect, it } from 'vitest'
import { resolveImportWorkspace, validateImportedConversation } from './conversation-io'

const valid = {
  id: 'old-id',
  title: 'My chat',
  workspace: '/some/where',
  providerId: 'anthropic',
  model: 'claude-opus-4-8',
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }]
    },
    { role: 'tool', content: 'data', toolCallId: 'c1', toolName: 'read_file' }
  ]
}

describe('validateImportedConversation', () => {
  it('accepts a well-formed export and keeps the known fields', () => {
    const r = validateImportedConversation(valid)
    expect(r.title).toBe('My chat')
    expect(r.workspace).toBe('/some/where')
    expect(r.providerId).toBe('anthropic')
    expect(r.messages).toHaveLength(3)
    expect(r.messages[1].toolCalls?.[0].name).toBe('read_file')
    expect(r.messages[2].toolName).toBe('read_file')
  })

  it('drops unknown fields on messages', () => {
    const r = validateImportedConversation({
      messages: [{ role: 'user', content: 'hi', evil: 'x', injected: true }]
    })
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('defaults a missing/blank title', () => {
    expect(validateImportedConversation({ messages: [] }).title).toBe('Imported chat')
    expect(validateImportedConversation({ title: '  ', messages: [] }).title).toBe('Imported chat')
  })

  it('rejects non-objects', () => {
    expect(() => validateImportedConversation(null)).toThrow(/Not a conversation file/)
    expect(() => validateImportedConversation('x')).toThrow(/Not a conversation file/)
  })

  it('rejects a missing messages array', () => {
    expect(() => validateImportedConversation({ title: 't' })).toThrow(/no "messages" array/)
  })

  it('rejects an invalid role or non-string content', () => {
    expect(() => validateImportedConversation({ messages: [{ role: 'wizard', content: 'x' }] })).toThrow(
      /invalid role/
    )
    expect(() => validateImportedConversation({ messages: [{ role: 'user', content: 5 }] })).toThrow(
      /missing string content/
    )
  })

  it('validates and strips tool calls to the known shape', () => {
    const r = validateImportedConversation({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' }, extra: 'drop me' }]
        }
      ]
    })
    expect(r.messages[0].toolCalls).toEqual([{ id: 'c1', name: 'read_file', arguments: { path: 'a' } }])
  })

  it('rejects a malformed tool call (missing id/name)', () => {
    expect(() =>
      validateImportedConversation({
        messages: [{ role: 'assistant', content: '', toolCalls: [{ name: 'read_file' }] }]
      })
    ).toThrow(/tool call 0 is missing/)
  })

  it('defaults non-object tool-call arguments to an empty object', () => {
    const r = validateImportedConversation({
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: 'nope' }] }]
    })
    expect(r.messages[0].toolCalls?.[0].arguments).toEqual({})
  })
})

describe('resolveImportWorkspace', () => {
  it('honors an imported workspace only when it is a known recent dir', () => {
    expect(resolveImportWorkspace('/projects/foo', ['/projects/foo', '/projects/bar'])).toBe(
      '/projects/foo'
    )
  })

  it('falls back to the most recent workspace for an untrusted/unknown path', () => {
    expect(resolveImportWorkspace('/etc', ['/projects/foo'])).toBe('/projects/foo')
    expect(resolveImportWorkspace('/Users/victim', [])).toBe('')
  })

  it('falls back when the import omits a workspace', () => {
    expect(resolveImportWorkspace(undefined, ['/projects/foo'])).toBe('/projects/foo')
  })
})

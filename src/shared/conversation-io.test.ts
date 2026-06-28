import { describe, expect, it } from 'vitest'
import type { Conversation } from './agent'
import {
  forkConversationData,
  forkTitle,
  resolveImportWorkspace,
  validateImportedConversation,
  MAX_IMPORT_MESSAGES,
  MAX_IMPORT_BYTES
} from './conversation-io'

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

  describe('size caps (hostile / huge files)', () => {
    it('exposes a positive byte cap for the import handler to enforce', () => {
      expect(MAX_IMPORT_BYTES).toBeGreaterThan(0)
    })

    it('rejects a file with too many messages', () => {
      const messages = Array.from({ length: MAX_IMPORT_MESSAGES + 1 }, () => ({
        role: 'user',
        content: 'x'
      }))
      expect(() => validateImportedConversation({ messages })).toThrow(/too many messages/)
    })

    it('clamps an enormous message content instead of keeping it whole', () => {
      const huge = 'a'.repeat(2_000_000)
      const r = validateImportedConversation({ messages: [{ role: 'user', content: huge }] })
      expect(r.messages[0].content.length).toBeLessThan(huge.length)
      expect(r.messages[0].content).toMatch(/\[truncated\]$/)
    })

    it('clamps an over-long title and tool fields', () => {
      const r = validateImportedConversation({
        title: 'T'.repeat(5000),
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'i'.repeat(5000), name: 'n'.repeat(5000), arguments: {} }]
          }
        ]
      })
      expect(r.title.length).toBeLessThan(5000)
      expect(r.messages[0].toolCalls?.[0].id.length).toBeLessThan(5000)
      expect(r.messages[0].toolCalls?.[0].name.length).toBeLessThan(5000)
    })

    it('caps the number of tool calls kept per message', () => {
      const toolCalls = Array.from({ length: 5000 }, (_, i) => ({
        id: `c${i}`,
        name: 'x',
        arguments: {}
      }))
      const r = validateImportedConversation({
        messages: [{ role: 'assistant', content: '', toolCalls }]
      })
      expect(r.messages[0].toolCalls!.length).toBeLessThanOrEqual(1000)
    })
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

describe('forkTitle', () => {
  it('appends "(fork)"', () => {
    expect(forkTitle('Add auth')).toBe('Add auth (fork)')
  })

  it('does not stack suffixes', () => {
    expect(forkTitle('Add auth (fork)')).toBe('Add auth (fork)')
    expect(forkTitle('Add auth (fork 2)')).toBe('Add auth (fork)')
  })

  it('falls back to "Chat" for an empty title', () => {
    expect(forkTitle('   ')).toBe('Chat (fork)')
  })
})

describe('forkConversationData', () => {
  const src: Conversation = {
    id: 'src-id',
    title: 'Original',
    workspace: '/proj',
    providerId: 'anthropic',
    model: 'claude',
    createdAt: 1,
    updatedAt: 2,
    pinned: true,
    archived: true,
    groupId: 'g1',
    usage: { inputTokens: 10, outputTokens: 20, cost: 0.01 },
    messages: [{ role: 'user', content: 'hi' }]
  }

  it('gives the fork a fresh id, timestamps, and "(fork)" title', () => {
    const fork = forkConversationData(src, 'new-id', 99)
    expect(fork.id).toBe('new-id')
    expect(fork.title).toBe('Original (fork)')
    expect(fork.createdAt).toBe(99)
    expect(fork.updatedAt).toBe(99)
  })

  it('clears pin, archive, and group so the fork lands in the default list', () => {
    const fork = forkConversationData(src, 'new-id', 99)
    expect(fork.pinned).toBeUndefined()
    expect(fork.archived).toBeUndefined()
    expect(fork.groupId).toBeUndefined()
  })

  it('copies messages into an independent array', () => {
    const fork = forkConversationData(src, 'new-id', 99)
    expect(fork.messages).toEqual(src.messages)
    expect(fork.messages).not.toBe(src.messages)
    fork.messages.push({ role: 'assistant', content: 'yo' })
    expect(src.messages).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { toGeminiContents } from './gemini'

describe('toGeminiContents', () => {
  it('maps a user turn and a tool result (functionResponse)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { result: 'file body' } } }]
      }
    ])
  })

  it('follows a tool result that has images with a separate inlineData user turn', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Loaded http://localhost:3000/',
        toolCallId: 'call_1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'view_localhost', response: { result: 'Loaded http://localhost:3000/' } } }
        ]
      },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'SHOT' } }] }
    ])
  })

  it('folds a plain user message following a tool result onto the same user turn', () => {
    // Gemini enforces user/model alternation, so the nudge that a stall/landing
    // check pushes after a tool-using turn must not become a second `user` turn.
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run', arguments: {} }] },
      { role: 'tool', content: 'exit 0', toolCallId: 'c1', toolName: 'run' },
      { role: 'user', content: 'Wrap up.' }
    ]
    const out = toGeminiContents(msgs)

    // No two adjacent turns share a role.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role)
    }
    // model turn, then one user turn carrying both the functionResponse and the nudge.
    expect(out).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'run', args: {} } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'run', response: { result: 'exit 0' } } }, { text: 'Wrap up.' }]
      }
    ])
  })

  it('merges parallel tool results into a single user turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: 'r1', toolCallId: 'c1', toolName: 'run' },
      { role: 'tool', content: 'r2', toolCallId: 'c2', toolName: 'run' }
    ]
    expect(toGeminiContents(msgs)).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'run', response: { result: 'r1' } } },
          { functionResponse: { name: 'run', response: { result: 'r2' } } }
        ]
      }
    ])
  })
})

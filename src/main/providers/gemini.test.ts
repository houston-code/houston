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
})

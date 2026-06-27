import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { toOpenAIMessages } from './openai'

describe('toOpenAIMessages', () => {
  it('maps a plain user + tool result to text-only messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' }
    ])
  })

  it('carries user images as image_url content parts', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'see this', images: [{ mediaType: 'image/png', data: 'AAA' }] }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
        ]
      }
    ])
  })

  it('follows a tool result that has images with a user image_url turn', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Loaded http://localhost:3000/',
        toolCallId: 'call_1',
        toolName: 'view_localhost',
        images: [{ mediaType: 'image/png', data: 'SHOT' }]
      }
    ]
    expect(toOpenAIMessages(undefined, msgs)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'Loaded http://localhost:3000/' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SHOT' } }]
      }
    ])
  })
})

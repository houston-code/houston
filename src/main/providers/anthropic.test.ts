import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { markMessagesCacheBreakpoint } from './anthropic'

describe('markMessagesCacheBreakpoint', () => {
  it('converts a trailing string message into a cached text block', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }]
    markMessagesCacheBreakpoint(messages)
    const content = messages[0].content as Array<{ type: string; cache_control?: unknown }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toMatchObject({ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } })
  })

  it('marks the last block of an array-content message', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b' }
        ]
      }
    ]
    markMessagesCacheBreakpoint(messages)
    const content = messages[0].content as Array<{ cache_control?: unknown }>
    expect(content[0].cache_control).toBeUndefined()
    expect(content[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('only marks the most recent message', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' }
    ]
    markMessagesCacheBreakpoint(messages)
    expect(typeof messages[0].content).toBe('string') // untouched
    expect(Array.isArray(messages[2].content)).toBe(true) // breakpoint here
  })

  it('is a no-op on an empty list', () => {
    expect(() => markMessagesCacheBreakpoint([])).not.toThrow()
  })
})

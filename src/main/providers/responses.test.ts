import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { toResponsesInput, toResponsesTools } from './responses'
import { openaiResponsesReasoning } from './reasoning'

describe('toResponsesInput', () => {
  it('maps a user message to input_text', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    expect(toResponsesInput(msgs)).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }])
  })

  it('includes images as input_image parts', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'see this', images: [{ mediaType: 'image/png', data: 'AAA' }] }
    ]
    const out = toResponsesInput(msgs)
    expect(out[0].content).toEqual([
      { type: 'input_text', text: 'see this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' }
    ])
  })

  it('maps an assistant turn with text + tool calls to output_text + function_call items', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]
      }
    ]
    expect(toResponsesInput(msgs)).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'let me check' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }
    ])
  })

  it('maps a tool result to function_call_output', () => {
    const msgs: ChatMessage[] = [{ role: 'tool', content: 'file body', toolCallId: 'call_1', toolName: 'read_file' }]
    expect(toResponsesInput(msgs)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' }
    ])
  })

  it('emits an empty input_text for a contentless user turn (never empty content)', () => {
    expect(toResponsesInput([{ role: 'user', content: '' }])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '' }] }
    ])
  })
})

describe('toResponsesTools', () => {
  it('flattens tool schemas (no nested function wrapper)', () => {
    const tools = [{ name: 'glob', description: 'find', parameters: { type: 'object', properties: {} } }]
    expect(toResponsesTools(tools)).toEqual([
      { type: 'function', name: 'glob', description: 'find', parameters: { type: 'object', properties: {} }, strict: false }
    ])
  })

  it('returns undefined when there are no tools', () => {
    expect(toResponsesTools(undefined)).toBeUndefined()
    expect(toResponsesTools([])).toBeUndefined()
  })
})

describe('openaiResponsesReasoning', () => {
  it('requests effort + summary for a reasoning model when on', () => {
    expect(openaiResponsesReasoning('gpt-5.1', 'high')).toEqual({ effort: 'high', summary: 'auto' })
    expect(openaiResponsesReasoning('o3', 'low')).toEqual({ effort: 'low', summary: 'auto' })
  })

  it('returns undefined when off or unsupported', () => {
    expect(openaiResponsesReasoning('gpt-5.1', 'off')).toBeUndefined()
    expect(openaiResponsesReasoning('gpt-4o', 'high')).toBeUndefined()
  })
})

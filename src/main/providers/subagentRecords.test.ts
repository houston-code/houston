import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { toAnthropicMessages } from './anthropic'
import { toOpenAIMessages } from './openai'
import { toResponsesInput } from './responses'
import { toGeminiContents } from './gemini'

/**
 * A dispatch's saved subagent records are display-only: no provider adapter may
 * send them (they would cost tokens and expose the agent's internals to the model
 * as if it were conversation).
 */
const messages: ChatMessage[] = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'dispatch_agent', arguments: { prompt: 'p' } }] },
  {
    role: 'tool',
    content: 'the report',
    toolCallId: 'c1',
    toolName: 'dispatch_agent',
    subagents: [
      {
        id: 'sa1',
        kind: 'research',
        label: 'RECORD_LABEL_MARKER',
        model: 'm',
        modelSource: 'run',
        prompt: 'RECORD_PROMPT_MARKER',
        tools: [],
        status: 'done',
        startedAt: 0,
        steps: [{ index: 0, turn: 1, kind: 'tool', summary: 'RECORD_STEP_MARKER', ok: true }]
      }
    ]
  }
]

describe('subagent records never reach a provider', () => {
  it.each([
    ['anthropic', () => toAnthropicMessages(messages, false)],
    ['openai', () => toOpenAIMessages(undefined, messages)],
    ['responses', () => toResponsesInput(messages)],
    ['gemini', () => toGeminiContents(messages)]
  ])('%s', (_name, convert) => {
    const sent = JSON.stringify(convert())
    expect(sent).toContain('the report')
    expect(sent).not.toMatch(/RECORD_(LABEL|PROMPT|STEP)_MARKER|subagents/)
  })
})

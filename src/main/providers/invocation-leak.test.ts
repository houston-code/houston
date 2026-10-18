import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { toAnthropicMessages } from './anthropic'
import { toGeminiContents } from './gemini'
import { toOpenAIMessages } from './openai'
import { toResponsesInput } from './responses'

// `invokedAs` is how the clients know to show "/review" instead of the prompt. It is
// display-only: the model must get the prompt exactly as before and never the tag,
// whichever wire format the conversation goes out in.
const MARKER = 'invoked-as-marker-7f3a'
const messages: ChatMessage[] = [
  {
    role: 'user',
    content: 'Review my current uncommitted changes.',
    invokedAs: { kind: 'command', label: `/${MARKER}`, detail: MARKER, typed: MARKER }
  }
]

describe('invokedAs never reaches a provider', () => {
  it.each([
    ['anthropic', () => toAnthropicMessages(messages, false)],
    ['openai chat completions', () => toOpenAIMessages(undefined, messages)],
    ['openai responses', () => toResponsesInput(messages)],
    ['gemini', () => toGeminiContents(messages)]
  ])('%s sends the prompt and not the tag', (_name, convert) => {
    const wire = JSON.stringify(convert())
    expect(wire).toContain('Review my current uncommitted changes.')
    expect(wire).not.toContain(MARKER)
    expect(wire).not.toContain('invokedAs')
  })
})

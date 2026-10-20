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

// A turn's receipt is Houston's record of what ran, saved on the turn's last assistant
// message for the clients. It is display-only too: the model must never see it, or a
// later turn could read the harness's verdict as something it said itself.
const RECEIPT_MARKER = 'receipt-marker-5c1e'
const withReceipt: ChatMessage[] = [
  { role: 'user', content: 'Build the app.' },
  {
    role: 'assistant',
    content: 'Built it and ran the tests.',
    receipt: {
      v: 1,
      checks: [{ kind: 'test', label: `pytest -k ${RECEIPT_MARKER}`, ok: false, exitCode: 1, runs: 1 }],
      otherCommands: 0,
      filesChanged: [`${RECEIPT_MARKER}.py`],
      filesChangedCount: 1
    }
  },
  { role: 'user', content: 'Thanks.' }
]

describe('a turn receipt never reaches a provider', () => {
  it.each([
    ['anthropic', () => toAnthropicMessages(withReceipt, false)],
    ['openai chat completions', () => toOpenAIMessages(undefined, withReceipt)],
    ['openai responses', () => toResponsesInput(withReceipt)],
    ['gemini', () => toGeminiContents(withReceipt)]
  ])('%s sends the reply and not the receipt', (_name, convert) => {
    const wire = JSON.stringify(convert())
    expect(wire).toContain('Built it and ran the tests.')
    expect(wire).not.toContain(RECEIPT_MARKER)
    expect(wire).not.toContain('receipt')
  })
})

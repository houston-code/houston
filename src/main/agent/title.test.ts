import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage, Provider, ProviderStreamEvent } from '@shared/agent'
import { sanitizeTitle, buildTitleMessages, generateTitle } from './title'

/** A provider that replays one pre-scripted stream of events. */
function scripted(events: ProviderStreamEvent[]): Provider {
  return {
    async *streamChat() {
      for (const ev of events) yield ev
    }
  }
}

const signal = new AbortController().signal

describe('sanitizeTitle', () => {
  it('passes a clean title through unchanged', () => {
    expect(sanitizeTitle('Fix flaky auth test')).toBe('Fix flaky auth test')
  })

  it('strips wrapping quotes and backticks', () => {
    expect(sanitizeTitle('"Add dark mode toggle"')).toBe('Add dark mode toggle')
    expect(sanitizeTitle('`Explain the build`')).toBe('Explain the build')
    expect(sanitizeTitle('“Smart quotes here”')).toBe('Smart quotes here')
  })

  it('drops a trailing period but keeps the words', () => {
    expect(sanitizeTitle('Refactor the parser.')).toBe('Refactor the parser')
  })

  it('takes the first non-empty line and collapses whitespace', () => {
    expect(sanitizeTitle('\n\n  Set up   CI   \nand more')).toBe('Set up CI')
  })

  it('caps overlong output at 60 chars with an ellipsis', () => {
    const long = 'a'.repeat(80)
    const out = sanitizeTitle(long)!
    expect(out.length).toBe(60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns null when nothing usable remains', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   \n  ')).toBeNull()
    expect(sanitizeTitle('"""')).toBeNull()
  })
})

describe('buildTitleMessages', () => {
  const msgs = (m: ChatMessage[]): ChatMessage[] => m

  it('returns null when there is no user message', () => {
    expect(buildTitleMessages(msgs([{ role: 'assistant', content: 'hi' }]))).toBeNull()
  })

  it('frames the first user message as a single synthetic user turn with the instruction', () => {
    const built = buildTitleMessages(msgs([{ role: 'user', content: 'How do I parse YAML?' }]))!
    expect(built).toHaveLength(1)
    expect(built[0].role).toBe('user')
    expect(built[0].content).toContain('How do I parse YAML?')
    expect(built[0].content).toContain('Output only the title text.')
  })

  it('includes the first non-empty assistant reply', () => {
    const built = buildTitleMessages(
      msgs([
        { role: 'user', content: 'fix the build' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'Updated the webpack config.' }
      ])
    )!
    expect(built[0].content).toContain('fix the build')
    expect(built[0].content).toContain('Updated the webpack config.')
  })

  it('clips overlong source content instead of sending the whole turn', () => {
    const huge = 'x'.repeat(5000)
    const built = buildTitleMessages(msgs([{ role: 'user', content: huge }]))!
    expect(built[0].content).toContain('…')
    // Far smaller than the raw 5000-char message even with the framing text.
    expect(built[0].content.length).toBeLessThan(1300)
  })
})

describe('generateTitle', () => {
  const opening: ChatMessage[] = [
    { role: 'user', content: 'Help me add a dark mode toggle' },
    { role: 'assistant', content: 'Sure, I will add a theme switch.' }
  ]

  it('concatenates streamed text deltas and sanitizes the result', async () => {
    const provider = scripted([
      { type: 'text', text: '"Add dark' },
      { type: 'text', text: ' mode toggle"' },
      { type: 'done', stopReason: 'end_turn' }
    ])
    expect(await generateTitle(provider, 'm', opening, signal)).toBe('Add dark mode toggle')
  })

  it('returns null when there is no user message to summarize', async () => {
    const provider = scripted([{ type: 'text', text: 'whatever' }])
    expect(await generateTitle(provider, 'm', [{ role: 'assistant', content: 'hi' }], signal)).toBeNull()
  })

  it('throws when the provider streams an error', async () => {
    const provider = scripted([{ type: 'error', message: 'invalid api key' }])
    await expect(generateTitle(provider, 'm', opening, signal)).rejects.toThrow('invalid api key')
  })

  it('rides out a transient blip and still produces a title', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const provider: Provider = {
        async *streamChat() {
          calls++
          if (calls === 1) {
            yield { type: 'error', message: 'overloaded' } as ProviderStreamEvent
            return
          }
          yield { type: 'text', text: 'Add dark mode' } as ProviderStreamEvent
          yield { type: 'done', stopReason: 'end_turn' } as ProviderStreamEvent
        }
      }
      const p = generateTitle(provider, 'm', opening, signal)
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBe('Add dark mode')
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up on a transient error well inside the caller's timeout", async () => {
    // A title is cosmetic and bounded at TITLE_TIMEOUT_MS, so it takes a much smaller
    // budget than a turn: spending the full one here could only ever exhaust the window
    // on backoff and still leave the placeholder.
    vi.useFakeTimers()
    try {
      let calls = 0
      const provider: Provider = {
        async *streamChat() {
          calls++
          yield { type: 'error', message: 'rate limited' } as ProviderStreamEvent
        }
      }
      const p = generateTitle(provider, 'm', opening, signal)
      const settled = expect(p).rejects.toThrow('rate limited')
      await vi.runAllTimersAsync()
      await settled
      expect(calls).toBe(3) // the initial attempt plus two retries
    } finally {
      vi.useRealTimers()
    }
  })
})

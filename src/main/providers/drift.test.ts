import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { driftCandidates, renderDriftSection, MAX_AGE_DAYS } from './drift'

const NOW = new Date('2026-10-18T12:00:00Z')
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const none = new Set<string>()

describe('driftCandidates', () => {
  it('flags a recent first-party chat model Houston does not ship', () => {
    const out = driftCandidates(
      'anthropic',
      [
        { id: 'claude-opus-5-5', caps: { releasedAt: daysAgo(30) } }, // shipped
        { id: 'claude-opus-6', caps: { releasedAt: daysAgo(3) } } // new
      ],
      ['claude-opus-5-5'],
      none,
      NOW
    )
    expect(out).toEqual([
      { id: 'claude-opus-6', releasedAt: daysAgo(3), missing: [] } // the opus rules already price and place it
    ])
  })

  it('reports what an unrecognized newcomer still needs', () => {
    const [c] = driftCandidates('openai', [{ id: 'gpt-omega', caps: { releasedAt: daysAgo(1) } }], [], none, NOW)
    expect(c.missing).toEqual(['price', 'context window', 'family'])
  })

  it('skips old releases, ignored ids, dated snapshots, non-chat models and other vendors', () => {
    const out = driftCandidates(
      'openai',
      [
        { id: 'gpt-4o', caps: { releasedAt: daysAgo(MAX_AGE_DAYS + 1) } },
        { id: 'gpt-6-sol', caps: { releasedAt: daysAgo(5) } },
        { id: 'gpt-6.1-sol-2026-09-01', caps: { releasedAt: daysAgo(5) } },
        { id: 'gpt-6-tts', caps: { releasedAt: daysAgo(5) } },
        { id: 'ft:gpt-6-luna:acme::abc', caps: { releasedAt: daysAgo(5) } },
        { id: 'chatgpt-6-latest', caps: { releasedAt: daysAgo(5) } },
        { id: 'whisper-2', caps: { releasedAt: daysAgo(5) } }
      ],
      [],
      new Set(['gpt-6-sol']),
      NOW
    )
    expect(out).toEqual([])
  })

  it('keeps a model with no listed date rather than dropping it unseen', () => {
    expect(driftCandidates('openai', [{ id: 'o7' }], [], none, NOW).map((c) => c.id)).toEqual(['o7'])
  })

  it('sorts newest release first', () => {
    const out = driftCandidates(
      'openai',
      [
        { id: 'gpt-6.2-sol', caps: { releasedAt: daysAgo(10) } },
        { id: 'gpt-6.2-astra', caps: { releasedAt: daysAgo(2) } }
      ],
      [],
      none,
      NOW
    )
    expect(out.map((c) => c.id)).toEqual(['gpt-6.2-astra', 'gpt-6.2-sol'])
  })

  describe('Gemini, which lists no release dates', () => {
    const shipped = ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']
    const flagged = (ids: string[]): string[] =>
      driftCandidates('gemini', ids.map((id) => ({ id })), shipped, none, NOW).map((c) => c.id)

    it('flags a newer version within a tier, and the stable release of a shipped preview', () => {
      expect(flagged(['gemini-3.9-flash', 'gemini-3.6-flash-lite', 'gemini-3.1-pro'])).toEqual([
        'gemini-3.1-pro',
        'gemini-3.6-flash-lite',
        'gemini-3.9-flash'
      ])
    })

    it('ignores older versions, aliases, experiments and the open models the API also lists', () => {
      expect(
        flagged(['gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-3.9-flash-exp', 'gemma-4-27b'])
      ).toEqual([])
    })
  })
})

describe('renderDriftSection', () => {
  it('renders a table naming what each model needs', () => {
    const md = renderDriftSection('openai', [
      { id: 'gpt-omega', releasedAt: '2026-10-17', missing: ['price', 'family'] },
      { id: 'o7', missing: [] }
    ])
    expect(md).toContain('### OpenAI')
    expect(md).toContain('| `gpt-omega` | 2026-10-17 | needs price, family in model-facts.ts |')
    expect(md).toContain('| `o7` | not listed | already recognized: seed it |')
  })

  it('is empty when nothing is new', () => {
    expect(renderDriftSection('gemini', [])).toBe('')
  })
})

describe('model-drift-ignore.json', () => {
  const file = fileURLToPath(new URL('./model-drift-ignore.json', import.meta.url))
  const { ignore } = JSON.parse(readFileSync(file, 'utf8')) as { ignore: Array<{ id: string; reason: string }> }

  it('gives every ignored model a reason, once', () => {
    for (const e of ignore) expect(e.reason?.trim(), `${e.id} has no reason`).toBeTruthy()
    expect(new Set(ignore.map((e) => e.id)).size).toBe(ignore.length)
  })
})

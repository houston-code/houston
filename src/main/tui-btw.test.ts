import { describe, expect, it } from 'vitest'
import type { SideChatTurn } from '@shared/agent'
import { BTW_ANSWER_LINES, BTW_RECENT_TURNS, renderRecentSideChat } from './tui-btw'
import type { Painter } from './tui'

const plain: Painter = (s) => s
const turn = (i: number, extra: Partial<SideChatTurn> = {}): SideChatTurn => ({
  id: `t${i}`,
  question: `question ${i}`,
  answer: `answer ${i}`,
  at: i,
  ...extra
})

describe('renderRecentSideChat', () => {
  it('is empty when the side chat has nothing yet', () => {
    expect(renderRecentSideChat([], plain)).toBe('')
  })

  it('shows the latest exchanges, newest last, and how many there are', () => {
    const turns = Array.from({ length: BTW_RECENT_TURNS + 2 }, (_, i) => turn(i + 1))
    const out = renderRecentSideChat(turns, plain)
    expect(out).toContain(`latest ${BTW_RECENT_TURNS} of ${turns.length}`)
    expect(out).not.toContain('question 1\n')
    expect(out.indexOf('question 3')).toBeLessThan(out.indexOf('question 5'))
    expect(out).toContain('answer 5')
  })

  it('cuts a long answer and says how much is left', () => {
    const answer = Array.from({ length: BTW_ANSWER_LINES + 3 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = renderRecentSideChat([turn(1, { answer })], plain)
    expect(out).toContain(`line ${BTW_ANSWER_LINES}`)
    expect(out).not.toContain(`line ${BTW_ANSWER_LINES + 1}`)
    expect(out).toContain('… 3 more lines')
  })

  it('says why an exchange has no answer, and drops control characters', () => {
    const out = renderRecentSideChat(
      [turn(1, { question: 'why\x1b[2J?', answer: undefined, error: 'rate\x07 limited' })],
      plain
    )
    expect(out).toContain('why[2J?')
    expect(out).toContain('(no answer: rate limited)')
    expect(out).not.toContain('\x07')
    expect(out).not.toContain('\x1b')
  })
})

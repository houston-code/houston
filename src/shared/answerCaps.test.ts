import { describe, expect, it } from 'vitest'
import { capAnswer, capPlanDecision, MAX_QUESTION_ANSWER_LEN } from './answerCaps'

describe('answer caps', () => {
  const huge = 'z'.repeat(MAX_QUESTION_ANSWER_LEN + 10)

  it('cuts an answer to the cap and leaves a short one alone', () => {
    expect(capAnswer(huge)).toHaveLength(MAX_QUESTION_ANSWER_LEN)
    expect(capAnswer('Postgres')).toBe('Postgres')
  })

  it('cuts a suggestion note and an edited plan, and passes other decisions through', () => {
    const note = capPlanDecision({ kind: 'suggest', note: huge })
    expect(note.kind === 'suggest' && note.note.length).toBe(MAX_QUESTION_ANSWER_LEN)
    const edited = capPlanDecision({ kind: 'accept', mode: 'ask', editedBody: huge })
    expect(edited).toEqual({ kind: 'accept', mode: 'ask', editedBody: huge.slice(0, MAX_QUESTION_ANSWER_LEN) })
    expect(capPlanDecision({ kind: 'accept', mode: 'auto-edit' })).toEqual({ kind: 'accept', mode: 'auto-edit' })
    expect(capPlanDecision({ kind: 'reject' })).toEqual({ kind: 'reject' })
  })
})

import { describe, expect, it } from 'vitest'
import {
  APPROVAL_INTERRUPTED_NOTE,
  QUESTION_EMPTY_ANSWER,
  QUESTION_STOPPED_ANSWER,
  isUnansweredQuestion,
  planOutcome,
  stoppedPromptText
} from './promptOutcome'

describe('stoppedPromptText', () => {
  it('describes a question the run was stopped in front of', () => {
    expect(stoppedPromptText(QUESTION_STOPPED_ANSWER)).toBe('Not answered: the run was stopped.')
  })

  it('describes an approval the run was stopped in front of', () => {
    // The loop wraps the note in its usual denial text for the model.
    const output = `Denied by the user. They said: ${APPROVAL_INTERRUPTED_NOTE}`
    expect(stoppedPromptText(output)).toBe('Not run: the run was stopped before it was approved.')
  })

  it('leaves real answers and real denials alone', () => {
    expect(stoppedPromptText('Postgres')).toBeNull()
    expect(stoppedPromptText('Denied by the user. They said: use staging')).toBeNull()
    expect(stoppedPromptText('Denied by the user.')).toBeNull()
    expect(stoppedPromptText(undefined)).toBeNull()
  })
})

describe('isUnansweredQuestion', () => {
  it('is true for a stopped or empty answer only', () => {
    expect(isUnansweredQuestion(QUESTION_STOPPED_ANSWER)).toBe(true)
    expect(isUnansweredQuestion(QUESTION_EMPTY_ANSWER)).toBe(true)
    expect(isUnansweredQuestion('SQLite')).toBe(false)
    expect(isUnansweredQuestion(undefined)).toBe(false)
  })
})

describe('planOutcome', () => {
  it('reads the decision from the present_plan result', () => {
    expect(planOutcome('The user ACCEPTED the plan and switched off Plan mode.')).toBe('accepted')
    expect(planOutcome('The user REJECTED this plan. Do not make any changes.')).toBe('rejected')
    expect(planOutcome('The user wants changes before you proceed:\n\nuse sqlite')).toBe('superseded')
    expect(planOutcome(undefined)).toBe('superseded')
  })
})

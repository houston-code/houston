import { describe, expect, it } from 'vitest'
import {
  APPROVAL_DENIED,
  APPROVAL_INTERRUPTED_NOTE,
  QUESTION_EMPTY_ANSWER,
  QUESTION_STOPPED_ANSWER,
  deniedPromptText,
  denialText,
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

describe('deniedPromptText', () => {
  it('says the call was denied, with the reason the user gave', () => {
    expect(deniedPromptText(denialText(APPROVAL_DENIED))).toBe('Denied')
    expect(deniedPromptText(denialText(APPROVAL_DENIED, 'put it in lib/ instead'))).toBe(
      'Denied: put it in lib/ instead'
    )
  })

  it('reads a subagent gate denial, whose base carries the do-not-retry instruction', () => {
    const base = `${APPROVAL_DENIED} Do not retry this call; work around it or note it in your report.`
    expect(deniedPromptText(denialText(base))).toBe('Denied')
    expect(deniedPromptText(denialText(base, 'use staging'))).toBe('Denied: use staging')
  })

  it('keeps a reason that itself says "They said:" whole', () => {
    expect(deniedPromptText(denialText(APPROVAL_DENIED, 'They said: no'))).toBe('Denied: They said: no')
  })

  it('leaves a stopped prompt, other results, and nothing alone', () => {
    expect(deniedPromptText(denialText(APPROVAL_DENIED, APPROVAL_INTERRUPTED_NOTE))).toBeNull()
    expect(deniedPromptText('Blocked by a permission rule.')).toBeNull()
    expect(deniedPromptText('Wrote 12 bytes to a.ts.')).toBeNull()
    expect(deniedPromptText(undefined)).toBeNull()
  })
})

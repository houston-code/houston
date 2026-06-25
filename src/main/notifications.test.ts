import { describe, expect, it } from 'vitest'
import { notificationFor, workspaceLabel } from './notifications'

describe('notificationFor', () => {
  it('pings when a turn finishes', () => {
    expect(notificationFor({ runId: 'r', type: 'done', stopReason: 'end_turn' })).toEqual({
      title: 'Houston',
      body: 'Finished responding.'
    })
  })

  it('stays quiet when the user aborted the run', () => {
    expect(notificationFor({ runId: 'r', type: 'done', stopReason: 'aborted' })).toBeNull()
  })

  it('pings for approval, question, and error with a useful body', () => {
    expect(
      notificationFor({
        runId: 'r',
        type: 'tool_approval',
        callId: 'c',
        name: 'run_shell',
        summary: 'rm -rf /tmp/x',
        kind: 'shell'
      })
    ).toMatchObject({ body: 'run_shell: rm -rf /tmp/x' })
    expect(
      notificationFor({
        runId: 'r',
        type: 'tool_question',
        callId: 'c',
        question: 'Which database?',
        options: []
      })
    ).toMatchObject({ body: 'Which database?' })
    expect(notificationFor({ runId: 'r', type: 'error', message: 'boom' })).toMatchObject({
      body: 'boom'
    })
  })

  it('folds a workspace label into the title', () => {
    expect(
      notificationFor({ runId: 'r', type: 'done', stopReason: 'end_turn' }, 'my-proj')?.title
    ).toBe('Houston · my-proj')
  })

  it('ignores streaming and bookkeeping events', () => {
    expect(notificationFor({ runId: 'r', type: 'text', delta: 'hi' })).toBeNull()
    expect(
      notificationFor({ runId: 'r', type: 'tool_start', callId: 'c', name: 'read_file', args: {} })
    ).toBeNull()
    expect(
      notificationFor({ runId: 'r', type: 'usage', inputTokens: 1, outputTokens: 2, cost: 0 })
    ).toBeNull()
  })
})

describe('workspaceLabel', () => {
  it('uses the basename of the path', () => {
    expect(workspaceLabel('/Users/me/code/houston')).toBe('houston')
  })
  it('returns undefined when there is no workspace', () => {
    expect(workspaceLabel(undefined)).toBeUndefined()
    expect(workspaceLabel('')).toBeUndefined()
  })
})

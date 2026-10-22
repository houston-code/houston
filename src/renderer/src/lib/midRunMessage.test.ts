import { describe, expect, it, vi } from 'vitest'
import type { SteerOutcome } from '@shared/queue'
import { deliverMidRunMessage, type MidRunDeps } from './midRunMessage'

function deps(over: Partial<MidRunDeps> = {}): MidRunDeps {
  return {
    openQuestionId: null,
    conversationId: 'c1',
    canSend: true,
    answer: vi.fn(),
    steer: vi.fn(async (): Promise<SteerOutcome> => ({ status: 'steered', items: [] })),
    isOpen: vi.fn(() => true),
    sendNow: vi.fn(),
    enqueue: vi.fn(),
    giveBack: vi.fn(),
    ...over
  }
}

describe('deliverMidRunMessage', () => {
  // The reported bug: the agent was waiting on its own question, the steer sat unread
  // behind it, and nothing showed it. Now the message answers the question.
  it('answers the open question instead of steering', async () => {
    const d = deps({ openQuestionId: 'q1' })
    expect(await deliverMidRunMessage('Postgres', d)).toBe('answered')
    expect(d.answer).toHaveBeenCalledWith('q1', 'Postgres')
    expect(d.steer).not.toHaveBeenCalled()
  })

  it("reports main's steer or queue decision (stored before it replies)", async () => {
    expect(await deliverMidRunMessage('use YAML', deps())).toBe('steered')
    const d = deps({ steer: vi.fn(async (): Promise<SteerOutcome> => ({ status: 'queued', items: [] })) })
    expect(await deliverMidRunMessage('use YAML', d)).toBe('queued')
    expect(d.steer).toHaveBeenCalledWith('c1', 'use YAML')
    expect(d.sendNow).not.toHaveBeenCalled()
  })

  // The run ended between Enter and main seeing it. The old fallback queued it
  // behind a run that had already drained its queue, where it sat unsent.
  it('sends it as a turn when the run has already ended', async () => {
    const d = deps({ steer: vi.fn(async (): Promise<SteerOutcome> => ({ status: 'idle' })) })
    expect(await deliverMidRunMessage('and add tests', d)).toBe('sent')
    expect(d.sendNow).toHaveBeenCalledWith('and add tests')
  })

  it('queues it in its own chat when the user has moved to another one meanwhile', async () => {
    const d = deps({
      steer: vi.fn(async (): Promise<SteerOutcome> => ({ status: 'idle' })),
      isOpen: vi.fn(() => false)
    })
    expect(await deliverMidRunMessage('and add tests', d)).toBe('queued-elsewhere')
    expect(d.enqueue).toHaveBeenCalledWith('c1', 'and add tests')
    expect(d.sendNow).not.toHaveBeenCalled()
  })

  it('gives the text back when the bridge fails, so nothing is lost', async () => {
    const d = deps({ steer: vi.fn(async () => Promise.reject(new Error('bridge down'))) })
    expect(await deliverMidRunMessage('important', d)).toBe('given-back')
    expect(d.giveBack).toHaveBeenCalledWith('important', 'c1', true)
  })

  it('gives the text back when there is no chat or model to send it with', async () => {
    const noModel = deps({ canSend: false })
    expect(await deliverMidRunMessage('x', noModel)).toBe('given-back')
    expect(noModel.giveBack).toHaveBeenCalledWith('x', 'c1', false)
    const noChat = deps({ conversationId: null })
    expect(await deliverMidRunMessage('y', noChat)).toBe('given-back')
    expect(noChat.steer).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { INTERRUPTED_TOOL_RESULT } from './repair'
import {
  PROPOSAL_ACCEPTED_PREFIX,
  PROPOSE_SESSION_NAME,
  SPAWN_SESSION_NAME,
  acceptedProposalCalls,
  forkableHistory,
  isSpawnBackendConfigured,
  resetSpawnBackend,
  setSpawnBackend,
  spawnSession,
  type SpawnSessionInput,
  type SpawnSessionResult
} from './spawn'

afterEach(() => resetSpawnBackend())

const input: SpawnSessionInput = {
  prompt: 'do the thing',
  providerId: 'anthropic',
  model: 'claude-opus-4-8',
  approvalPolicy: 'ask',
  workspace: '/repo'
}

describe('spawn backend seam', () => {
  it('has a stable tool name', () => {
    expect(SPAWN_SESSION_NAME).toBe('spawn_session')
  })

  it('is unconfigured until a backend is wired', () => {
    expect(isSpawnBackendConfigured()).toBe(false)
    setSpawnBackend({ spawn: async () => ({ conversationId: 'c', title: 't', workspace: '/repo' }) })
    expect(isSpawnBackendConfigured()).toBe(true)
    resetSpawnBackend()
    expect(isSpawnBackendConfigured()).toBe(false)
  })

  it('throws a guiding error when spawnSession is called with no backend', () => {
    expect(() => spawnSession(input)).toThrow(/not configured/)
  })

  it('delegates to the wired backend and returns its result', async () => {
    let received: SpawnSessionInput | undefined
    const result: SpawnSessionResult = { conversationId: 'c1', title: 'Task', workspace: '/repo' }
    setSpawnBackend({
      spawn: async (i) => {
        received = i
        return result
      }
    })
    await expect(spawnSession(input)).resolves.toBe(result)
    expect(received).toBe(input)
  })
})

describe('forkableHistory', () => {
  const call = (id: string, name = 'read_file'): ChatMessage['toolCalls'] => [
    { id, name, arguments: { path: 'a.ts' } }
  ]

  it('drops the in-flight turn: the assistant message still waiting on results', () => {
    const log: ChatMessage[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: '', toolCalls: call('r1') },
      { role: 'tool', content: 'file', toolCallId: 'r1', toolName: 'read_file' },
      // The turn handing off: spawn_session + a parallel read, only the read answered.
      {
        role: 'assistant',
        content: 'handing off',
        toolCalls: [
          { id: 's1', name: SPAWN_SESSION_NAME, arguments: { prompt: 'x' } },
          { id: 'r2', name: 'read_file', arguments: { path: 'b.ts' } }
        ]
      },
      { role: 'tool', content: 'b', toolCallId: 'r2', toolName: 'read_file' }
    ]
    expect(forkableHistory(log)).toEqual(log.slice(0, 3))
  })

  it('keeps a log whose last tool turn is fully answered', () => {
    const log: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: call('r1') },
      { role: 'tool', content: 'ok', toolCallId: 'r1', toolName: 'read_file' },
      { role: 'assistant', content: 'done' }
    ]
    expect(forkableHistory(log)).toEqual(log)
  })

  it('backfills an older call left unanswered, so the fork never replays a dangling call', () => {
    const log: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: call('old') },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: '', toolCalls: call('r2') },
      { role: 'tool', content: 'ok', toolCallId: 'r2', toolName: 'read_file' },
      { role: 'assistant', content: 'fine' }
    ]
    const out = forkableHistory(log)
    expect(out[2]).toMatchObject({ role: 'tool', toolCallId: 'old', content: INTERRUPTED_TOOL_RESULT })
  })

  it('copies the messages rather than sharing them with the parent', () => {
    const log: ChatMessage[] = [{ role: 'user', content: 'q' }]
    const out = forkableHistory(log)
    out[0].content = 'changed'
    expect(log[0].content).toBe('q')
  })
})

describe('acceptedProposalCalls', () => {
  it('returns only proposals whose result says they went through, oldest first', () => {
    const log: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'p1', name: PROPOSE_SESSION_NAME, arguments: { title: 'Docs', prompt: 'x' } },
          { id: 'p2', name: PROPOSE_SESSION_NAME, arguments: { title: 'Too many', prompt: 'y' } },
          { id: 'r1', name: 'read_file', arguments: {} }
        ]
      },
      { role: 'tool', content: `${PROPOSAL_ACCEPTED_PREFIX}Docs" to the user`, toolCallId: 'p1', toolName: PROPOSE_SESSION_NAME },
      { role: 'tool', content: 'Error: already proposed 3', toolCallId: 'p2', toolName: PROPOSE_SESSION_NAME },
      { role: 'tool', content: `${PROPOSAL_ACCEPTED_PREFIX}fake`, toolCallId: 'r1', toolName: 'read_file' }
    ]
    expect(acceptedProposalCalls(log).map((c) => c.id)).toEqual(['p1'])
  })
})

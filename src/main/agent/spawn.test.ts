import { afterEach, describe, expect, it } from 'vitest'
import {
  SPAWN_SESSION_NAME,
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

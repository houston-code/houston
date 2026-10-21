import { describe, expect, it } from 'vitest'
import type { ChatMessage, ConversationWorktree } from '@shared/agent'
import type { SpawnSessionInput } from './agent/spawn'
import { createSpawnBackend, MAX_LIVE_SPAWNED_SESSIONS, type SpawnDeps } from './spawnSession'

/** A recording set of fake deps, so the orchestration is testable without Electron. */
function fakeDeps(overrides: Partial<SpawnDeps> = {}): {
  deps: SpawnDeps
  calls: {
    worktree: Array<{ workspace: string; branch: string; base?: string }>
    created: Array<{
      workspace: string
      providerId: string
      model: string
      reasoningEffort?: string
      approvalPolicy?: string
      worktree?: ConversationWorktree
      spawnedFrom?: { conversationId: string; title: string }
    }>
    seeded: Array<{ id: string; messages: ChatMessage[] }>
    titled: Array<{ id: string; title: string }>
    remembered: string[]
    removed: ConversationWorktree[]
    runs: Array<{ id: string; req: Parameters<SpawnDeps['startBackgroundRun']>[1] }>
  }
  titles: Map<string, string>
} {
  const titles = new Map<string, string>()
  const calls = {
    worktree: [] as Array<{ workspace: string; branch: string; base?: string }>,
    created: [] as Array<{ workspace: string; providerId: string; model: string; worktree?: ConversationWorktree }>,
    seeded: [] as Array<{ id: string; messages: ChatMessage[] }>,
    titled: [] as Array<{ id: string; title: string }>,
    remembered: [] as string[],
    removed: [] as ConversationWorktree[],
    runs: [] as Array<{ id: string; req: Parameters<SpawnDeps['startBackgroundRun']>[1] }>
  }
  const deps: SpawnDeps = {
    createWorktree: async (input) => {
      calls.worktree.push(input)
      return {
        path: `/repo/.houston/worktrees/${input.branch.replace(/\//g, '-')}`,
        branch: input.branch,
        repoRoot: '/repo'
      }
    },
    createConversation: (input) => {
      calls.created.push(input)
      // Mimic the store: the derived title starts as the first line of the message,
      // filled in by seedMessages below; here we just seed a placeholder.
      titles.set('conv-1', 'New chat')
      return { id: 'conv-1', title: 'New chat' }
    },
    seedMessages: (id, messages) => {
      calls.seeded.push({ id, messages })
      // Store's setMessages derives a title from the first user message.
      const first = messages.find((m) => m.role === 'user')
      if (first) titles.set(id, first.content.slice(0, 57))
    },
    setTitle: (id, title) => {
      calls.titled.push({ id, title })
      titles.set(id, title)
    },
    getTitle: (id) => titles.get(id),
    rememberWorkspace: (dir) => {
      calls.remembered.push(dir)
    },
    liveSpawnCount: () => 0,
    removeWorktree: async (wt) => {
      calls.removed.push(wt)
    },
    startBackgroundRun: (id, req) => {
      calls.runs.push({ id, req })
    },
    ...overrides
  }
  return { deps, calls, titles }
}

// The seeded brief is tagged so the new chat shows a chip, with the brief's opening
// line as its detail (the full text is still what the model gets).
const HANDOFF = {
  kind: 'spawned',
  label: 'Handed-off task',
  detail: 'Add OAuth login. Wire the callback route and add tests.'
} as const

const baseInput: SpawnSessionInput = {
  prompt: 'Add OAuth login. Wire the callback route and add tests.',
  providerId: 'anthropic',
  model: 'claude-opus-4-8',
  approvalPolicy: 'ask',
  workspace: '/repo'
}

describe('createSpawnBackend', () => {
  it('creates a conversation, seeds the prompt, and starts a background run', async () => {
    const { deps, calls } = fakeDeps()
    const result = await createSpawnBackend(deps).spawn(baseInput)

    // No worktree requested → reuses the parent workspace, nothing remembered.
    expect(calls.worktree).toHaveLength(0)
    expect(calls.remembered).toHaveLength(0)
    expect(calls.created[0]).toMatchObject({
      workspace: '/repo',
      providerId: 'anthropic',
      model: 'claude-opus-4-8'
    })
    expect(calls.created[0].worktree).toBeUndefined()

    // The prompt becomes the first user message.
    expect(calls.seeded[0].messages).toEqual([{ role: 'user', content: baseInput.prompt, invokedAs: HANDOFF }])

    // Background run inherits provider/model/policy and carries the same seed.
    expect(calls.runs).toHaveLength(1)
    expect(calls.runs[0].id).toBe('conv-1')
    expect(calls.runs[0].req).toMatchObject({
      workspace: '/repo',
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      approvalPolicy: 'ask',
      messages: [{ role: 'user', content: baseInput.prompt, invokedAs: HANDOFF }]
    })
    expect(calls.runs[0].req.runId).toBeTruthy()

    expect(result).toMatchObject({ conversationId: 'conv-1', workspace: '/repo' })
    expect(result.worktree).toBeUndefined()
  })

  it("stores the parent's policy and effort on the child, and runs it under them", async () => {
    const { deps, calls } = fakeDeps()
    await createSpawnBackend(deps).spawn({ ...baseInput, approvalPolicy: 'plan', reasoningEffort: 'low' })
    // The child keeps them as its own, so a later change in the parent doesn't reach it.
    expect(calls.created[0]).toMatchObject({ approvalPolicy: 'plan', reasoningEffort: 'low' })
    expect(calls.runs[0].req).toMatchObject({ approvalPolicy: 'plan', reasoningEffort: 'low' })
  })

  it('leaves the child on the default effort when the parent had none of its own', async () => {
    const { deps, calls } = fakeDeps()
    await createSpawnBackend(deps).spawn(baseInput)
    expect(calls.created[0]).not.toHaveProperty('reasoningEffort')
    expect(calls.runs[0].req).not.toHaveProperty('reasoningEffort')
  })

  it('branches off a worktree, runs there, and remembers the repo root (not the worktree)', async () => {
    const { deps, calls } = fakeDeps()
    const result = await createSpawnBackend(deps).spawn({
      ...baseInput,
      worktree: { branch: 'feat/oauth', base: 'main' }
    })

    expect(calls.worktree[0]).toEqual({ workspace: '/repo', branch: 'feat/oauth', base: 'main' })
    // Recent-workspace pointer tracks the durable repo root, not the ephemeral worktree.
    expect(calls.remembered).toEqual(['/repo'])

    const wtPath = '/repo/.houston/worktrees/feat-oauth'
    expect(calls.created[0].workspace).toBe(wtPath)
    expect(calls.created[0].worktree?.branch).toBe('feat/oauth')
    expect(calls.runs[0].req.workspace).toBe(wtPath)

    expect(result.workspace).toBe(wtPath)
    expect(result.worktree).toEqual({ path: wtPath, branch: 'feat/oauth', repoRoot: '/repo' })
  })

  it('uses a caller title (marking it generated) and returns it', async () => {
    const { deps, calls } = fakeDeps()
    const result = await createSpawnBackend(deps).spawn({ ...baseInput, title: 'Add OAuth login' })

    expect(calls.titled).toEqual([{ id: 'conv-1', title: 'Add OAuth login' }])
    expect(result.title).toBe('Add OAuth login')
  })

  it('falls back to the prompt-derived title when none is given', async () => {
    const { deps, calls } = fakeDeps()
    const result = await createSpawnBackend(deps).spawn(baseInput)

    // No explicit title set; the derived one from seedMessages stands.
    expect(calls.titled).toHaveLength(0)
    expect(result.title).toBe(baseInput.prompt.slice(0, 57))
  })

  it('records the handoff (parent id + resolved title) when spawned from a chat', async () => {
    const { deps, calls, titles } = fakeDeps()
    titles.set('parent-1', 'Ship the billing dashboard')
    await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent-1' })
    expect(calls.created[0].spawnedFrom).toEqual({
      conversationId: 'parent-1',
      title: 'Ship the billing dashboard'
    })
  })

  it('omits the handoff when the parent has no resolvable title', async () => {
    const { deps, calls } = fakeDeps()
    // titles map has nothing for 'parent-x' → getTitle returns undefined.
    await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent-x' })
    expect(calls.created[0].spawnedFrom).toBeUndefined()
  })

  it('omits the handoff when there is no parent conversation', async () => {
    const { deps, calls } = fakeDeps()
    await createSpawnBackend(deps).spawn(baseInput)
    expect(calls.created[0].spawnedFrom).toBeUndefined()
  })

  it('rejects an empty prompt before touching any dep', async () => {
    const { deps, calls } = fakeDeps()
    await expect(createSpawnBackend(deps).spawn({ ...baseInput, prompt: '   ' })).rejects.toThrow(
      /prompt/
    )
    expect(calls.created).toHaveLength(0)
    expect(calls.runs).toHaveLength(0)
  })

  it('does not create a conversation or run if the worktree fails', async () => {
    const { deps, calls } = fakeDeps({
      createWorktree: async () => {
        throw new Error('branch exists')
      }
    })
    await expect(
      createSpawnBackend(deps).spawn({ ...baseInput, worktree: { branch: 'feat/oauth' } })
    ).rejects.toThrow(/branch exists/)
    expect(calls.created).toHaveLength(0)
    expect(calls.runs).toHaveLength(0)
  })

  it('refuses when the concurrent-session cap is reached, before creating anything', async () => {
    const { deps, calls } = fakeDeps({ liveSpawnCount: () => MAX_LIVE_SPAWNED_SESSIONS })
    await expect(
      createSpawnBackend(deps).spawn({ ...baseInput, worktree: { branch: 'feat/oauth' } })
    ).rejects.toThrow(/Too many background sessions/)
    // Refused up front — no worktree, no conversation, no run.
    expect(calls.worktree).toHaveLength(0)
    expect(calls.created).toHaveLength(0)
    expect(calls.runs).toHaveLength(0)
  })

  it('lets the user start a session past the cap, and does not count it', async () => {
    const counted: boolean[] = []
    const { deps, calls } = fakeDeps({
      liveSpawnCount: () => MAX_LIVE_SPAWNED_SESSIONS,
      startBackgroundRun: (_id, _req, opts) => {
        counted.push(opts.countsTowardCap)
      }
    })
    await createSpawnBackend(deps).spawn({ ...baseInput, startedBy: 'user' })
    expect(calls.created).toHaveLength(1)
    expect(counted).toEqual([false])
  })

  it('counts an agent-started session toward the cap', async () => {
    const counted: boolean[] = []
    const { deps } = fakeDeps({
      startBackgroundRun: (_id, _req, opts) => {
        counted.push(opts.countsTowardCap)
      }
    })
    await createSpawnBackend(deps).spawn(baseInput)
    await createSpawnBackend(deps).spawn({ ...baseInput, startedBy: 'agent' })
    expect(counted).toEqual([true, true])
  })

  it('allows a spawn when live sessions are below the cap', async () => {
    const { deps, calls } = fakeDeps({ liveSpawnCount: () => MAX_LIVE_SPAWNED_SESSIONS - 1 })
    await createSpawnBackend(deps).spawn(baseInput)
    expect(calls.runs).toHaveLength(1)
  })

  it('tears down a freshly created worktree if a later step throws', async () => {
    const { deps, calls } = fakeDeps({
      createConversation: () => {
        throw new Error('disk full')
      }
    })
    await expect(
      createSpawnBackend(deps).spawn({ ...baseInput, worktree: { branch: 'feat/oauth' } })
    ).rejects.toThrow(/disk full/)
    // The worktree was created, then removed to avoid orphaning it.
    expect(calls.worktree).toHaveLength(1)
    expect(calls.removed).toHaveLength(1)
    expect(calls.removed[0].branch).toBe('feat/oauth')
    expect(calls.runs).toHaveLength(0)
  })

  it('does not attempt worktree teardown when no worktree was created', async () => {
    const { deps, calls } = fakeDeps({
      createConversation: () => {
        throw new Error('disk full')
      }
    })
    await expect(createSpawnBackend(deps).spawn(baseInput)).rejects.toThrow(/disk full/)
    expect(calls.removed).toHaveLength(0)
  })
})

describe('createSpawnBackend: forked context and reporting back', () => {
  it('seeds a forked history ahead of the prompt, in both the log and the run', async () => {
    const { deps, calls } = fakeDeps()
    const history: ChatMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' }
    ]
    await createSpawnBackend(deps).spawn({ ...baseInput, history })
    expect(calls.seeded[0].messages.slice(0, 2)).toEqual(history)
    expect(calls.seeded[0].messages[2]).toMatchObject({
      role: 'user',
      content: baseInput.prompt,
      invokedAs: { kind: 'spawned' }
    })
    expect(calls.runs[0].req.messages).toEqual(calls.seeded[0].messages)
  })

  it('reports the finished child to its parent once the run settles', async () => {
    let finish!: () => void
    const reported: Array<[string, string]> = []
    const { deps } = fakeDeps({
      getTitle: (id) => (id === 'parent' ? 'Parent chat' : 'Child'),
      startBackgroundRun: () => new Promise<void>((r) => (finish = r)),
      reportToParent: (parentId, childId) => {
        reported.push([parentId, childId])
      }
    })
    const result = await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent' })
    expect(result.reportsBack).toBe(true)
    expect(reported).toEqual([])
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(reported).toEqual([['parent', 'conv-1']])
  })

  it('reports a failed child too, and never throws a report failure into the caller', async () => {
    const reported: string[] = []
    const { deps } = fakeDeps({
      startBackgroundRun: () => Promise.reject(new Error('boom')),
      reportToParent: (_p, child) => {
        reported.push(child)
        throw new Error('store full')
      }
    })
    await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent' })
    await new Promise((r) => setTimeout(r, 0))
    expect(reported).toEqual(['conv-1'])
  })

  it('does not promise a report when there is no parent or no run promise', async () => {
    const reported: string[] = []
    const { deps } = fakeDeps({ reportToParent: (_p, c) => void reported.push(c) })
    const noParent = await createSpawnBackend(deps).spawn(baseInput)
    expect(noParent.reportsBack).toBeUndefined()
    const noRunPromise = await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent' })
    expect(noRunPromise.reportsBack).toBeUndefined()
    expect(reported).toEqual([])
  })
})

describe('createSpawnBackend: where the hand-off starts', () => {
  it('records how much forked history precedes the hand-off prompt', async () => {
    const { deps, calls } = fakeDeps({ getTitle: (id) => (id === 'parent' ? 'Parent chat' : 'Child') })
    const history: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' }
    ]
    await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent', history })
    expect(calls.created[0].spawnedFrom).toEqual({ conversationId: 'parent', title: 'Parent chat', historyLength: 2 })
    await createSpawnBackend(deps).spawn({ ...baseInput, parentConversationId: 'parent' })
    expect(calls.created[1].spawnedFrom).toEqual({ conversationId: 'parent', title: 'Parent chat' })
  })
})

import { describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation, ProposalState } from '@shared/agent'
import { proposalHereTurn } from '@shared/promptInvocation'
import { PROPOSAL_ACCEPTED_PREFIX, PROPOSE_SESSION_NAME, type SpawnSessionInput } from './agent/spawn'
import {
  autoBranchFor,
  decideProposal,
  proposalArgsFrom,
  proposalsIn,
  startProposal,
  type ProposalDeps
} from './proposals'

/** A chat log holding one accepted proposal (call `p1`) with the given arguments. */
function logWith(args: Record<string, unknown>, extra: ChatMessage[] = []): ChatMessage[] {
  return [
    { role: 'user', content: 'add oauth' },
    {
      role: 'assistant',
      content: 'Working on it.',
      toolCalls: [{ id: 'p1', name: PROPOSE_SESSION_NAME, arguments: args }]
    },
    {
      role: 'tool',
      content: `${PROPOSAL_ACCEPTED_PREFIX}${String(args.title)}" to the user as a card.`,
      toolCallId: 'p1',
      toolName: PROPOSE_SESSION_NAME
    },
    ...extra
  ]
}

function fakeDeps(conv: Conversation | null, isRepo = true) {
  const spawned: SpawnSessionInput[] = []
  const states: Array<{ id: string; callId: string; state: ProposalState }> = []
  const deps: ProposalDeps = {
    getConversation: () => conv,
    setProposalState: (id, callId, state) => {
      states.push({ id, callId, state })
      return { ...(conv?.proposals ?? {}), [callId]: state }
    },
    spawn: async (input) => {
      spawned.push(input)
      return { conversationId: 'child-1', title: input.title ?? '', workspace: input.workspace }
    },
    isGitRepo: async () => isRepo,
    now: () => 42
  }
  return { deps, spawned, states }
}

const parent = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'parent',
  title: 'Add OAuth',
  workspace: '/repo',
  providerId: 'anthropic',
  model: 'claude-sonnet-5',
  createdAt: 0,
  updatedAt: 0,
  messages: logWith({ title: 'Update API docs', prompt: 'Document /auth/*' }),
  ...over
})

describe('proposalArgsFrom', () => {
  const call = (args: Record<string, unknown>) => ({ id: 'p', name: PROPOSE_SESSION_NAME, arguments: args })

  it('re-reads a valid proposal, normalizing the title and defaulting the context', () => {
    expect(proposalArgsFrom(call({ title: '  Update   docs ', prompt: ' Do it ' }))).toEqual({
      title: 'Update docs',
      prompt: 'Do it',
      context: 'fresh'
    })
    expect(
      proposalArgsFrom(call({ title: 't', prompt: 'p', context: 'fork', worktree: { branch: 'a/b', base: 'main' } }))
    ).toEqual({ title: 't', prompt: 'p', context: 'fork', worktree: { branch: 'a/b', base: 'main' } })
  })

  it('rejects what the persisted log should never hold', () => {
    expect(proposalArgsFrom(call({ title: '', prompt: 'p' }))).toBeNull()
    expect(proposalArgsFrom(call({ title: 't' }))).toBeNull()
    expect(proposalArgsFrom(call({ title: 't', prompt: 'p', worktree: { branch: '--force' } }))).toBeNull()
    expect(proposalArgsFrom(call({ title: 't', prompt: 'p', worktree: { branch: 'ok', base: '-x' } }))).toBeNull()
    expect(proposalArgsFrom({ id: 'x', name: 'spawn_session', arguments: { title: 't', prompt: 'p' } })).toBeNull()
  })
})

describe('proposalsIn', () => {
  it('lists accepted proposals with their parsed arguments', () => {
    expect(proposalsIn(parent().messages)).toEqual([
      { callId: 'p1', args: { title: 'Update API docs', prompt: 'Document /auth/*', context: 'fresh' } }
    ])
  })
})

describe('autoBranchFor', () => {
  it('builds a safe, bounded branch from the title', () => {
    expect(autoBranchFor('Update API docs for /auth/*!', 'abc123')).toBe('houston/update-api-docs-for-auth-abc123')
    expect(autoBranchFor('x'.repeat(100), 'f00').length).toBeLessThanOrEqual('houston/'.length + 40 + 4)
    expect(autoBranchFor('???', 'f00')).toBe('houston/work-f00')
  })
})

describe('startProposal', () => {
  it("spawns under the parent's model, the caller's policy, and its own worktree in a git repo", async () => {
    const { deps, spawned, states } = fakeDeps(parent())
    const out = await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'auto-edit' }, deps)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      title: 'Update API docs',
      prompt: 'Document /auth/*',
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
      approvalPolicy: 'auto-edit',
      workspace: '/repo',
      parentConversationId: 'parent',
      // The user's own click, so the agent's concurrency cap doesn't apply.
      startedBy: 'user'
    })
    expect(spawned[0].worktree?.branch).toMatch(/^houston\/update-api-docs-[0-9a-f]{6}$/)
    expect(spawned[0].history).toBeUndefined()
    expect(states).toEqual([
      { id: 'parent', callId: 'p1', state: { status: 'started', conversationId: 'child-1', at: 42 } }
    ])
    expect(out.proposals.p1.status).toBe('started')
  })

  it("starts the session on the parent chat's own reasoning effort", async () => {
    const { deps, spawned } = fakeDeps(parent({ reasoningEffort: 'xhigh' }))
    await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    expect(spawned[0]).toMatchObject({ reasoningEffort: 'xhigh', approvalPolicy: 'ask' })
  })

  it('shares the checkout outside a git repo, and honors a named branch', async () => {
    const plain = fakeDeps(parent(), false)
    await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, plain.deps)
    expect(plain.spawned[0].worktree).toBeUndefined()

    const named = fakeDeps(
      parent({ messages: logWith({ title: 'Docs', prompt: 'p', worktree: { branch: 'docs/auth' } }) })
    )
    await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, named.deps)
    expect(named.spawned[0].worktree).toEqual({ branch: 'docs/auth' })
  })

  it("forks the parent's history when the proposal asked for it", async () => {
    const conv = parent({
      messages: logWith({ title: 'Docs', prompt: 'p', context: 'fork' }, [{ role: 'assistant', content: 'done' }])
    })
    const { deps, spawned } = fakeDeps(conv)
    await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    expect(spawned[0].history).toEqual(conv.messages)
  })

  it('refuses a missing chat, an unknown proposal, and one already started', async () => {
    await expect(
      startProposal({ conversationId: 'x', callId: 'p1', approvalPolicy: 'ask' }, fakeDeps(null).deps)
    ).rejects.toThrow(/no longer exists/)
    await expect(
      startProposal({ conversationId: 'parent', callId: 'nope', approvalPolicy: 'ask' }, fakeDeps(parent()).deps)
    ).rejects.toThrow(/no longer in this chat/)
    const started = fakeDeps(parent({ proposals: { p1: { status: 'started', conversationId: 'c', at: 1 } } }))
    await expect(
      startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, started.deps)
    ).rejects.toThrow(/already started/)
    expect(started.spawned).toHaveLength(0)
  })

  it('records nothing when the spawn itself fails', async () => {
    const { deps, states } = fakeDeps(parent())
    deps.spawn = async () => {
      throw new Error('Too many background sessions')
    }
    await expect(
      startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    ).rejects.toThrow(/Too many/)
    expect(states).toEqual([])
  })
})

describe('decideProposal', () => {
  it('records here / dismissed, and refuses one already started or unknown', () => {
    const { deps, states } = fakeDeps(parent())
    decideProposal({ conversationId: 'parent', callId: 'p1', status: 'dismissed' }, deps)
    expect(states[0].state).toEqual({ status: 'dismissed', at: 42 })
    expect(() => decideProposal({ conversationId: 'parent', callId: 'zz', status: 'here' }, deps)).toThrow()
    const started = fakeDeps(parent({ proposals: { p1: { status: 'started', at: 1 } } }))
    expect(() => decideProposal({ conversationId: 'parent', callId: 'p1', status: 'here' }, started.deps)).toThrow(
      /already started/
    )
  })
})

describe('proposalHereTurn', () => {
  it('asks for the proposal here, carrying its brief, shown as a chip', () => {
    const turn = proposalHereTurn({ title: 'Docs', prompt: 'Document /auth/*' })
    expect(turn.text).toContain('"Docs"')
    expect(turn.text.endsWith('Document /auth/*')).toBe(true)
    expect(turn.invokedAs).toEqual({ kind: 'action', label: 'Do it here', detail: 'Docs' })
  })
})

describe('startProposal: concurrent starts', () => {
  it('refuses a second start of the same proposal while the first is still spawning', async () => {
    const { deps, spawned } = fakeDeps(parent())
    let release!: () => void
    const slowSpawn = deps.spawn
    deps.spawn = async (input) => {
      await new Promise<void>((r) => (release = r))
      return slowSpawn(input)
    }
    const first = startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    await new Promise((r) => setTimeout(r, 0))
    await expect(
      startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    ).rejects.toThrow(/already starting/)
    release()
    await first
    expect(spawned).toHaveLength(1)
  })

  it('lets a proposal be retried after a failed start', async () => {
    const { deps, spawned } = fakeDeps(parent())
    const real = deps.spawn
    deps.spawn = async () => {
      throw new Error('boom')
    }
    await expect(
      startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    ).rejects.toThrow('boom')
    deps.spawn = real
    await startProposal({ conversationId: 'parent', callId: 'p1', approvalPolicy: 'ask' }, deps)
    expect(spawned).toHaveLength(1)
  })
})

describe('proposalArgsFrom: shares the tool validation', () => {
  it('refuses an unknown context, as the tool does', () => {
    expect(
      proposalArgsFrom({ id: 'p', name: PROPOSE_SESSION_NAME, arguments: { title: 't', prompt: 'p', context: 'all' } })
    ).toBeNull()
  })
})

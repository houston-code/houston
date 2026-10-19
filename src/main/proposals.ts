import { randomBytes } from 'node:crypto'
import type { ApprovalPolicy } from '@shared/types'
import type { ChatMessage, Conversation, ProposalState, ToolCall } from '@shared/agent'
import {
  PROPOSE_SESSION_NAME,
  acceptedProposalCalls,
  forkableHistory,
  spawnSession,
  type SessionContext,
  type SpawnSessionInput,
  type SpawnSessionResult
} from './agent/spawn'
import { parseContextArg, parseWorktreeArg } from './agent/tools'
import { getRepoInfo, slugifyBranch } from './agent/worktree'
import { getConversation, setProposalState } from './conversations'

/**
 * Starting (or declining) a `propose_session` card. The tool call only recorded the
 * proposal; this is the user's side of it, shared by the desktop app (IPC) and the
 * TUI (`/proposals`), so both start a proposal the same way.
 *
 * A started proposal becomes an ordinary spawned session: the parent chat's provider
 * and model, the user's CURRENT approval policy (passed in by the client, never
 * read from the call), and, when the project is a git repository and the proposal
 * named no branch, its own fresh worktree. That last rule is what keeps a proposed
 * session from editing the same checkout as the chat that proposed it.
 */

/** A proposal's arguments, re-read from its tool call. */
export interface ProposalArgs {
  title: string
  prompt: string
  context: SessionContext
  worktree?: { branch: string; base?: string }
}

/** One proposal in a chat: the call that raised it and its parsed arguments. */
export interface ProposalEntry {
  callId: string
  args: ProposalArgs
}

/**
 * Re-parse a `propose_session` call's arguments. The tool validated them when the
 * model made the call; this is the trust boundary on the way back out of the
 * persisted log, so it re-checks rather than trusting the file. Null when unusable.
 */
export function proposalArgsFrom(call: ToolCall): ProposalArgs | null {
  if (call.name !== PROPOSE_SESSION_NAME) return null
  const a = call.arguments ?? {}
  const title = typeof a.title === 'string' ? a.title.replace(/\s+/g, ' ').trim() : ''
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
  if (!title || !prompt) return null
  // The same validation the tool ran when the model made the call, so a card the
  // tool accepted always starts, and nothing the tool would refuse ever does.
  let context: SessionContext
  let worktree: ProposalArgs['worktree']
  try {
    context = parseContextArg(a)
    worktree = parseWorktreeArg(a)
  } catch {
    return null
  }
  return { title, prompt, context, ...(worktree ? { worktree } : {}) }
}

/**
 * Every proposal the chat raised, oldest first: `propose_session` calls whose result
 * says the proposal went through (a refused call, e.g. over the per-turn cap, is not
 * a card).
 */
export function proposalsIn(messages: ChatMessage[]): ProposalEntry[] {
  const out: ProposalEntry[] = []
  for (const c of acceptedProposalCalls(messages)) {
    const args = proposalArgsFrom(c)
    if (args) out.push({ callId: c.id, args })
  }
  return out
}

/**
 * The branch a proposal gets when it didn't name one: `houston/<title-slug>-<suffix>`.
 * The random suffix keeps two proposals with similar titles from colliding.
 */
export function autoBranchFor(title: string, suffix: string = randomBytes(3).toString('hex')): string {
  const slug = slugifyBranch(title).slice(0, 40).replace(/-+$/, '') || 'session'
  return `houston/${slug}-${suffix}`
}

/** The store and spawn operations a proposal needs, injected so this stays testable. */
export interface ProposalDeps {
  getConversation(id: string): Conversation | null
  setProposalState(id: string, callId: string, state: ProposalState): Record<string, ProposalState>
  spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>
  /** Whether `workspace` is inside a git repository (so a worktree can be cut). */
  isGitRepo(workspace: string): Promise<boolean>
  now?: () => number
}

/**
 * The real store, spawn backend, and git probe, shared by every host (desktop IPC
 * and the terminal) so they can't drift.
 */
export function hostProposalDeps(): ProposalDeps {
  return {
    getConversation,
    setProposalState,
    spawn: spawnSession,
    isGitRepo: async (workspace) => (await getRepoInfo(workspace)).isRepo
  }
}

/**
 * Proposals being started right now (`<chat>:<call>`). Spawning can take seconds
 * (a worktree is cut first), and the "already started" record is written only after
 * it, so without this two clicks (two windows, or the app and its terminal) could
 * both get past the check and start the same proposal twice.
 */
const starting = new Set<string>()

/** Start a proposal as its own session, and record that on the proposing chat. */
export async function startProposal(
  input: { conversationId: string; callId: string; approvalPolicy: ApprovalPolicy },
  deps: ProposalDeps
): Promise<{ result: SpawnSessionResult; proposals: Record<string, ProposalState> }> {
  const conv = deps.getConversation(input.conversationId)
  if (!conv) throw new Error('That chat no longer exists.')
  const entry = proposalsIn(conv.messages).find((p) => p.callId === input.callId)
  if (!entry) throw new Error('That proposal is no longer in this chat.')
  const prior = conv.proposals?.[input.callId]
  if (prior?.status === 'started') throw new Error('That proposal was already started.')
  const key = `${conv.id}:${input.callId}`
  if (starting.has(key)) throw new Error('That proposal is already starting.')
  starting.add(key)
  try {
    return await spawnProposal(conv, input.callId, entry.args, input.approvalPolicy, deps)
  } finally {
    starting.delete(key)
  }
}

async function spawnProposal(
  conv: Conversation,
  callId: string,
  args: ProposalArgs,
  approvalPolicy: ApprovalPolicy,
  deps: ProposalDeps
): Promise<{ result: SpawnSessionResult; proposals: Record<string, ProposalState> }> {
  // Never let a proposed session share the proposing chat's checkout when a
  // worktree is possible: two writers in one folder overwrite each other.
  const worktree =
    args.worktree ?? ((await deps.isGitRepo(conv.workspace)) ? { branch: autoBranchFor(args.title) } : undefined)

  const result = await deps.spawn({
    title: args.title,
    prompt: args.prompt,
    providerId: conv.providerId,
    model: conv.model,
    approvalPolicy,
    workspace: conv.workspace,
    parentConversationId: conv.id,
    ...(worktree ? { worktree } : {}),
    ...(args.context === 'fork' ? { history: forkableHistory(conv.messages) } : {})
  })
  const proposals = deps.setProposalState(conv.id, callId, {
    status: 'started',
    conversationId: result.conversationId,
    at: (deps.now ?? Date.now)()
  })
  return { result, proposals }
}

/** Record "do it here" or "dismiss" on a proposal. Refuses one already started. */
export function decideProposal(
  input: { conversationId: string; callId: string; status: 'here' | 'dismissed' },
  deps: Pick<ProposalDeps, 'getConversation' | 'setProposalState' | 'now'>
): Record<string, ProposalState> {
  const conv = deps.getConversation(input.conversationId)
  if (!conv) throw new Error('That chat no longer exists.')
  if (!proposalsIn(conv.messages).some((p) => p.callId === input.callId)) {
    throw new Error('That proposal is no longer in this chat.')
  }
  if (conv.proposals?.[input.callId]?.status === 'started') {
    throw new Error('That proposal was already started.')
  }
  return deps.setProposalState(conv.id, input.callId, { status: input.status, at: (deps.now ?? Date.now)() })
}

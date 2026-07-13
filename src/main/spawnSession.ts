import { randomUUID } from 'node:crypto'
import type { ApprovalPolicy } from '@shared/types'
import type { ChatMessage, ConversationWorktree } from '@shared/agent'
import type { SpawnBackend, SpawnSessionInput, SpawnSessionResult } from './agent/spawn'

/**
 * Shell-side implementation of the agent's `spawn_session` tool — the runtime
 * capability behind the injection seam in `agent/spawn.ts`.
 *
 * It creates a real, persisted conversation (optionally on a fresh git worktree),
 * seeds it with the handed-off prompt as the first user message, and kicks off a
 * background run on it. This lives in the shell (not under `agent/`) so the engine
 * stays free of `electron`/store: the orchestration is expressed over injected
 * {@link SpawnDeps}, and `ipc.ts` wires the real ones — createConversation, the
 * worktree helper, the store, and `runAndDrain` with a broadcast IO — once at
 * startup via {@link setSpawnBackend}.
 *
 * The seams are all injected so this is unit-testable without a running app.
 */

/**
 * Ceiling on how many spawned sessions may be running in the background at once.
 * Each spawned session is itself an agent that can call `spawn_session`, and in
 * `auto-edit` / `full-auto` the call auto-approves — so without a bound a run could
 * fan out into an unbounded tree of autonomous background runs (LLM-credit and
 * on-disk-worktree amplification, with no user gate). Capping the *concurrent* live
 * count bounds the blast radius regardless of the tree's shape: the (N+1)-th spawn
 * is refused with a clear message until one of the live sessions finishes. Small on
 * purpose — parallel work is a handful of tracks, not a swarm.
 */
export const MAX_LIVE_SPAWNED_SESSIONS = 5

/** The concrete operations the spawn orchestration needs, abstracted from Electron/store. */
export interface SpawnDeps {
  /** Create a fresh branch + worktree for the session; returns its metadata (incl. `path`). */
  createWorktree(input: {
    workspace: string
    branch: string
    base?: string
  }): Promise<ConversationWorktree>
  /** Create the new conversation (already persisted); returns at least its id + title. */
  createConversation(input: {
    workspace: string
    providerId: string
    model: string
    worktree?: ConversationWorktree
    spawnedFrom?: { conversationId: string; title: string }
  }): { id: string; title: string }
  /** Seed the conversation's first user message (persists it and derives a title). */
  seedMessages(conversationId: string, messages: ChatMessage[]): void
  /** Persist a caller-supplied title (marks it generated so it isn't auto-retitled). */
  setTitle(conversationId: string, title: string): void
  /** Read a conversation's current title (after seeding derived one from the prompt). */
  getTitle(conversationId: string): string | undefined
  /**
   * Remember the durable repo root as the recent workspace (NOT the per-session
   * worktree path, which gets torn down). Mirrors the interactive new-worktree chat.
   */
  rememberWorkspace(dir: string): void
  /** How many spawned sessions are currently running (for the concurrency cap). */
  liveSpawnCount(): number
  /**
   * Tear down a worktree created moments ago, if a later step of the spawn fails —
   * so a half-built session never orphans a branch + checkout on disk with no
   * conversation referencing it.
   */
  removeWorktree(worktree: ConversationWorktree): Promise<unknown>
  /** Kick off the background run for the new session (fire-and-forget). */
  startBackgroundRun(
    conversationId: string,
    req: {
      runId: string
      workspace: string
      providerId: string
      model: string
      approvalPolicy: ApprovalPolicy
      messages: ChatMessage[]
      /** False for autonomous background runs (keeps the no-progress stall's hard stop). */
      interactive?: boolean
    }
  ): void
}

/**
 * Build a {@link SpawnBackend} over injected deps. Kept pure of Electron so a test
 * can exercise the full flow — worktree branch-off, conversation creation, message
 * seeding, title resolution, and the background-run kickoff — with fakes.
 */
export function createSpawnBackend(deps: SpawnDeps): SpawnBackend {
  return {
    async spawn(input: SpawnSessionInput): Promise<SpawnSessionResult> {
      const prompt = input.prompt.trim()
      if (!prompt) throw new Error('A prompt (the context to hand off) is required.')

      // Bound the concurrent fan-out before doing any work (so a refusal never
      // leaves a worktree behind). Checked here, not at approval time, so it holds
      // even in full-auto where the spawn call auto-approves.
      if (deps.liveSpawnCount() >= MAX_LIVE_SPAWNED_SESSIONS) {
        throw new Error(
          `Too many background sessions are already running (${MAX_LIVE_SPAWNED_SESSIONS}). ` +
            'Wait for one to finish before spawning another.'
        )
      }

      // Optionally branch off a fresh worktree; the worktree path then becomes the
      // session's workspace. The recent-workspace pointer tracks the durable repo
      // root, not the ephemeral worktree.
      let workspace = input.workspace
      let worktree: ConversationWorktree | undefined
      if (input.worktree) {
        worktree = await deps.createWorktree({
          workspace: input.workspace,
          branch: input.worktree.branch,
          base: input.worktree.base
        })
        deps.rememberWorkspace(worktree.repoRoot)
        workspace = worktree.path
      }

      try {
        // Record where the session was handed off from, resolving the spawning
        // chat's current title (skipped if it has none yet), so the new chat can
        // show a "handoff from …" label above its seeded message.
        const parentId = input.parentConversationId
        const parentTitle = parentId ? deps.getTitle(parentId)?.trim() : undefined
        const spawnedFrom =
          parentId && parentTitle ? { conversationId: parentId, title: parentTitle } : undefined

        const conv = deps.createConversation({
          workspace,
          providerId: input.providerId,
          model: input.model,
          worktree,
          ...(spawnedFrom ? { spawnedFrom } : {})
        })

        const userMessage: ChatMessage = { role: 'user', content: prompt }
        deps.seedMessages(conv.id, [userMessage])

        // A caller-supplied title wins and sticks (marked generated); otherwise the
        // title derived from the prompt stands, and the usual model summary upgrades
        // it after the first turn.
        const title = input.title?.trim()
        if (title) deps.setTitle(conv.id, title)
        const finalTitle = title || deps.getTitle(conv.id) || conv.title

        // Start the run in the background. No owning window (owner is undefined) so
        // any window that opens the chat can adopt it and answer its approvals; its
        // events broadcast to every window (see the IO in ipc.ts).
        deps.startBackgroundRun(conv.id, {
          runId: randomUUID(),
          workspace,
          providerId: input.providerId,
          model: input.model,
          approvalPolicy: input.approvalPolicy,
          messages: [userMessage],
          // Autonomous background run — no human is steering it, so keep the
          // no-progress stall's hard stop as a budget guard (see stall.ts). Runs
          // through runAndDrain, which would otherwise default this to interactive.
          interactive: false
        })

        return {
          conversationId: conv.id,
          title: finalTitle,
          workspace,
          ...(worktree ? { worktree } : {})
        }
      } catch (e) {
        // A step after the worktree was created failed — don't leave a branch +
        // checkout orphaned on disk. Best-effort teardown, then surface the original
        // error.
        if (worktree) {
          await deps.removeWorktree(worktree).catch(() => {})
        }
        throw e
      }
    }
  }
}

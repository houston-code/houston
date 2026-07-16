import type { ApprovalPolicy } from '@shared/types'
import type { ConversationWorktree } from '@shared/agent'

/**
 * The agent's `spawn_session` tool — spin off a *separate* chat, seeded with a
 * task handed to it, and set it running autonomously in the background.
 *
 * Unlike `dispatch_agent` (an ephemeral subagent that reports back into the
 * current turn), a spawned session is a real, persisted conversation: it shows up
 * in the sidebar with a live "running" dot, can run on its own git worktree, and
 * the user can open it to watch, answer an approval, or take over. The child run
 * inherits the parent's approval policy so it is never *more* permissive.
 *
 * The orchestration (create the conversation, optionally a worktree, seed the
 * first message, and start the background run) is Electron/shell work — it needs
 * the app's window set to route events and its recent-workspace store. So, like
 * `view_localhost`'s capture backend, the concrete implementation is injected at
 * startup via {@link setSpawnBackend} (see `src/main/spawnSession.ts` +
 * `ipc.ts`), keeping this engine module free of `electron` and the loop portable
 * to non-Electron hosts. Hosts that wire no backend (the standalone CLI, which
 * has no sidebar) drop the tool from the schema — see `isSpawnBackendConfigured`.
 */

/** Tool name — single source, imported by the loop's schema filter. */
export const SPAWN_SESSION_NAME = 'spawn_session'

/** What the loop hands the backend, with the run-scoped fields (provider/model/policy) filled in. */
export interface SpawnSessionInput {
  /**
   * Sidebar title for the new chat. When omitted, a title is derived from the
   * seeded prompt (and later upgraded to a model-generated summary like any chat).
   */
  title?: string
  /** The context handed to the new session — becomes its first user message. */
  prompt: string
  /** Provider + model the child run uses (inherited from the parent run). */
  providerId: string
  model: string
  /**
   * Approval policy the child run starts under — inherited from the parent run so
   * the spawned session is never more permissive than the one that spawned it.
   */
  approvalPolicy: ApprovalPolicy
  /** The parent run's workspace; the child reuses it unless a worktree is requested. */
  workspace: string
  /**
   * The spawning conversation's id (when the parent run has one — always true in
   * the desktop UI). Lets the backend record a "handoff from …" label on the new
   * chat, resolved to the parent's current title.
   */
  parentConversationId?: string
  /** When set, create a fresh branch + worktree and run the child there. */
  worktree?: { branch: string; base?: string }
}

/** What the backend returns once the session exists and its background run has started. */
export interface SpawnSessionResult {
  conversationId: string
  /** The resolved sidebar title (caller-supplied, or derived from the prompt). */
  title: string
  /** The workspace the child runs in (the worktree path when one was created). */
  workspace: string
  /** Set when the session was spawned onto a fresh git worktree. */
  worktree?: ConversationWorktree
  /**
   * Host-specific caveat appended to the tool result — e.g. a terminal host
   * noting the session runs non-interactively (approvals auto-declined) since it
   * has no window for the user to answer them in.
   */
  note?: string
}

/** The shell-side capability injected at startup. */
export interface SpawnBackend {
  spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>
}

let backend: SpawnBackend | null = null

/** Wire the real (Electron) spawn backend. Call once during startup, before any run. */
export function setSpawnBackend(impl: SpawnBackend): void {
  backend = impl
}

/** Test-only: clear the wired backend so a suite can restore an unconfigured state. */
export function resetSpawnBackend(): void {
  backend = null
}

/**
 * Whether a spawn backend has been wired. Only the Electron shell wires one, so
 * this is false on the standalone CLI — the loop uses it to drop `spawn_session`
 * from the toolset and system prompt rather than offering a tool that can only fail.
 */
export function isSpawnBackendConfigured(): boolean {
  return backend !== null
}

/** Spawn a new session via the injected backend. Throws if none is wired. */
export function spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
  if (!backend) {
    throw new Error(
      'Spawn backend not configured — call setSpawnBackend() during startup (see src/main/spawnSession.ts).'
    )
  }
  return backend.spawn(input)
}

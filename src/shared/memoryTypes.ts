/**
 * Cross-session memory: the facts the agent learns in one conversation and recalls in
 * later ones (see docs/memory-design.md). Distinct from the `#` capture in
 * ./memory.ts, which appends standing instructions to AGENTS.md. Shared so the main
 * process, the renderer, and the terminal agree on the record shape and limits.
 */

/** What a memory is about; also the order the prompt index prefers under its budget. */
export const MEMORY_TYPES = ['feedback', 'user', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** `repo`: one repository (every checkout and worktree of it). `global`: every project. */
export const MEMORY_STORE_SCOPES = ['repo', 'global'] as const
export type MemoryStoreScope = (typeof MEMORY_STORE_SCOPES)[number]

/** Who wrote the memory: the agent on its own, the user in a review surface, or an extraction pass. */
export const MEMORY_ORIGINS = ['agent', 'user', 'extracted'] as const
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number]

/** On-disk format version, written as `v:` in each file's front matter. */
export const MEMORY_FORMAT_VERSION = 1

export const MAX_MEMORY_NAME = 64
export const MAX_MEMORY_DESCRIPTION = 200
export const MAX_MEMORY_BODY = 2000
/** Memories one scope may hold. A full scope refuses new ones until something is deleted. */
export const MAX_MEMORIES_PER_SCOPE = 200

export interface MemoryRecord {
  id: string
  scope: MemoryStoreScope
  type: MemoryType
  /** Kebab-case handle, unique within a scope. */
  name: string
  /** One line: what the index shows so the model can decide whether to recall the body. */
  description: string
  body: string
  /** ISO timestamps. `updated` doubles as the edit-conflict token. */
  created: string
  updated: string
  origin: MemoryOrigin
  /** The conversation that last wrote it, when known. */
  conversation?: string
  pinned: boolean
}

/** A repository's memory folder, for listing other repos' memories (moved or re-cloned repos). */
export interface MemoryRepoInfo {
  key: string
  /** The repo root's folder name, for display. */
  label: string
  /** The repo root last seen when a memory was saved. */
  root: string
  count: number
}

/** Everything the Memory settings page shows. */
export interface MemoryOverview {
  /** The open project's repository, or null with no project open. */
  repo: { key: string; label: string } | null
  repoMemories: MemoryRecord[]
  globalMemories: MemoryRecord[]
  /** Other repositories' memory folders (a repo that moved or was cloned again shows here). */
  otherRepos: MemoryRepoInfo[]
}

/** A Memory settings page action. Every one answers with the refreshed overview. */
export type MemoryRequest =
  | { op: 'list'; workspace: string }
  | {
      op: 'update'
      workspace: string
      scope: MemoryStoreScope
      id: string
      type: MemoryType
      name: string
      description: string
      body: string
      /** The `updated` value the page last showed; a newer one on disk refuses the edit. */
      expectedUpdated: string
    }
  | { op: 'remove' | 'restore'; workspace: string; scope: MemoryStoreScope; id: string }
  | { op: 'pin'; workspace: string; scope: MemoryStoreScope; id: string; pinned: boolean }
  | { op: 'adoptRepo' | 'removeRepo'; workspace: string; key: string }

export type MemoryResponse = { ok: true; overview: MemoryOverview; note?: string } | { ok: false; error: string; overview: MemoryOverview }

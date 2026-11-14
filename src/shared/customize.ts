/**
 * Settings > Customize: the project's and the user's skills, custom commands and
 * custom agents, and the instruction files Houston loads. The main process lists and
 * changes them (src/main/customize.ts); the renderer refers to an item only by its id.
 */

export type CustomKind = 'skill' | 'command' | 'agent'
export type CustomScope = 'project' | 'user'

export interface CustomItem {
  /**
   * `<kind>:<scope>:<name>`, or `skill-agents:<scope>:<name>` for a skill in
   * `.agents/skills`; the only handle the renderer sends back.
   */
  id: string
  kind: CustomKind
  scope: CustomScope
  /** The file or folder name: what `/name`, `skill({ name })` or the agent picker use. */
  name: string
  description: string
  /** The file to edit, as shown: project-relative or `~/...`. */
  file: string
  /** False when its front matter says `disabled: true`. */
  enabled: boolean
  /**
   * An item hidden by another with the same name: a user item by a project one, or
   * a skill in `.agents/skills` by one in `.houston/skills` in the same place.
   */
  shadowed?: boolean
  /** A skill from `.agents/skills`, the Agent Skills format's own folder. */
  source?: 'agents'
  /** A skill's format fields worth showing: license, compatibility, allowed tools, paths. */
  details?: string[]
  /** Where a skill's front matter breaks the format (an `.agents` skill with these is not loaded). */
  problems?: string[]
}

export interface InstructionFile {
  /** What the rules loader calls it: `~/.houston/AGENTS.md (global)`, `AGENTS.md`, `pkg/AGENTS.md`. */
  label: string
  scope: 'global' | 'project' | 'nested'
  /** Shortened or left out to fit the rules budget. */
  truncated?: boolean
}

export interface CustomizeOverview {
  items: CustomItem[]
  instructions: InstructionFile[]
}

/** The result of a change: ok, or an error to show. */
export interface CustomizeResult {
  ok: boolean
  error?: string
  /** For create: the new item's id. */
  id?: string
}

/** A name a new skill, command or agent may take (also a file or folder name). */
export function isCustomName(name: string): boolean {
  return /^[\w-]{1,64}$/.test(name)
}

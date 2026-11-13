import type { AppSettings } from './types'

/**
 * Import from other tools: instruction files, MCP servers, skills and custom
 * commands that other coding tools keep in well-known places in the home folder or
 * the project, copied into Houston's own locations on the user's say-so. The main
 * process finds them (src/main/importConfig.ts); the renderer only ever sends back
 * the ids of what to import, never a path.
 */

export type ImportKind = 'rules' | 'mcp' | 'skill' | 'command'
export type ImportScope = 'user' | 'project'

export interface ImportCandidate {
  /** Stable id for this find; the renderer sends it back to import it. */
  id: string
  kind: ImportKind
  /** Whether it came from (and goes to) the home folder or the open project. */
  scope: ImportScope
  /** The command, skill or server name, or the file name for instructions. */
  name: string
  /** Where it was found, `~/...` or project-relative. */
  source: string
  /** Where importing it puts it, in the same form. */
  target: string
  /** A short description: a server's command line, a command's first line. */
  detail?: string
  /**
   * 'new' can be imported. 'present' means Houston already has it (imported before,
   * or something with the same name exists), so importing would change nothing:
   * an existing file or server is never overwritten.
   */
  status: 'new' | 'present'
  /** Why it is 'present'. */
  note?: string
}

export interface ImportScan {
  candidates: ImportCandidate[]
}

export interface ImportOutcome {
  /** Ids imported. */
  imported: string[]
  /** Ids not imported, each with the reason. */
  failed: Array<{ id: string; reason: string }>
  /** Fresh settings when MCP servers were added to them. */
  settings?: AppSettings
}

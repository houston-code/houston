/**
 * The set of external code editors the "Open in…" project action knows how to
 * launch. Each is opened with the project directory as an argument — preferring the
 * editor's CLI launcher (which takes a path directly), and on macOS falling back to
 * `open -a <app>` when only the .app bundle is present (no CLI shim installed).
 *
 * Kept in /shared so the main process (detection + launch) and the renderer (menu
 * labels, the Settings preference) agree on one id set and one source of names.
 */

export type EditorId = 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'xcode'

export interface EditorDef {
  id: EditorId
  /** Human label shown in the "Open in…" menu and Settings. */
  label: string
  /** CLI launcher name, looked up on PATH and the standard install dirs. */
  bin: string
  /** macOS application name for the `open -a <name>` fallback (needs no CLI shim). */
  macAppName: string
  /**
   * macOS-only editor — never offered on other platforms. Used by Xcode, whose
   * launcher name (`xed`) also belongs to an unrelated Linux text editor, so a
   * bare PATH hit off macOS would be a false positive.
   */
  macOnly?: boolean
}

/** Supported editors, in the order they appear in the menu. */
export const EDITORS: readonly EditorDef[] = [
  { id: 'vscode', label: 'VS Code', bin: 'code', macAppName: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor', bin: 'cursor', macAppName: 'Cursor' },
  { id: 'windsurf', label: 'Windsurf', bin: 'windsurf', macAppName: 'Windsurf' },
  { id: 'zed', label: 'Zed', bin: 'zed', macAppName: 'Zed' },
  { id: 'xcode', label: 'Xcode', bin: 'xed', macAppName: 'Xcode', macOnly: true }
] as const

/** Look up an editor by id (untrusted input from the renderer), or undefined. */
export function editorById(id: string): EditorDef | undefined {
  return EDITORS.find((e) => e.id === id)
}

/** Whether a given editor can be launched on this machine, for the menu/Settings. */
export interface EditorStatus {
  id: EditorId
  label: string
  /** True when its CLI is on PATH/standard dirs or (macOS) its .app is installed. */
  available: boolean
}

/** Result of a launch / reveal request, surfaced to the renderer for an error hint. */
export interface OpenResult {
  ok: boolean
  /** A short, user-facing reason when `ok` is false. */
  error?: string
}

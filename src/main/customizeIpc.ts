import { realpathSync } from 'node:fs'
import { shell, type ipcMain } from 'electron'
import { IPC } from '@shared/constants'
import type { CustomizeOverview, CustomizeResult } from '@shared/customize'
import {
  createItem,
  customizeOverview,
  deleteItem,
  openInstructionFile,
  openItem,
  setItemEnabled,
  type CustomizeDeps
} from './customize'
import { isKnownWorkspace } from './knownWorkspace'

/**
 * The open project as a real directory, or null (an empty, missing or unknown one is
 * no project). Only a project the app already knows (a recent project or a chat's
 * folder, see isKnownWorkspace) counts, so a renderer bug can't create, rewrite,
 * trash or open items in an arbitrary folder.
 */
export function workspaceArg(workspace: unknown, known: (ws: string) => boolean = isKnownWorkspace): string | null {
  if (typeof workspace !== 'string' || !workspace || !known(workspace)) return null
  try {
    return realpathSync(workspace)
  } catch {
    return null
  }
}

/** Settings > Customize: skills, commands, agents and the loaded instruction files. */
export function registerCustomizeIpc(
  handle: typeof ipcMain.handle,
  known: (ws: string) => boolean = isKnownWorkspace
): void {
  // Every open is a regular `.md` file by its real path (customize.ts openMarkdown).
  const deps = (workspace: unknown): CustomizeDeps => ({
    workspace: workspaceArg(workspace, known),
    trash: (path) => shell.trashItem(path),
    open: (path) => shell.openPath(path)
  })
  handle(IPC.customizeList, (_e, workspace: unknown): Promise<CustomizeOverview> => customizeOverview(deps(workspace)))
  handle(
    IPC.customizeCreate,
    (_e, workspace: unknown, kind: unknown, scope: unknown, name: unknown): Promise<CustomizeResult> =>
      createItem(kind, scope, name, deps(workspace))
  )
  handle(
    IPC.customizeSetEnabled,
    (_e, workspace: unknown, id: unknown, enabled: unknown): Promise<CustomizeResult> =>
      setItemEnabled(id, enabled, deps(workspace))
  )
  handle(IPC.customizeOpen, (_e, workspace: unknown, id: unknown): Promise<CustomizeResult> => openItem(id, deps(workspace)))
  handle(IPC.customizeDelete, (_e, workspace: unknown, id: unknown): Promise<CustomizeResult> => deleteItem(id, deps(workspace)))
  handle(
    IPC.customizeOpenInstruction,
    (_e, workspace: unknown, label: unknown): Promise<CustomizeResult> => openInstructionFile(label, deps(workspace))
  )
}

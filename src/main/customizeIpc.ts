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

/** The open project as a real directory, or null (an empty or missing one is no project). */
function workspaceArg(workspace: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace) return null
  try {
    return realpathSync(workspace)
  } catch {
    return null
  }
}

function deps(workspace: unknown): CustomizeDeps {
  return {
    workspace: workspaceArg(workspace),
    trash: (path) => shell.trashItem(path),
    open: (path) => shell.openPath(path)
  }
}

/** Settings > Customize: skills, commands, agents and the loaded instruction files. */
export function registerCustomizeIpc(handle: typeof ipcMain.handle): void {
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

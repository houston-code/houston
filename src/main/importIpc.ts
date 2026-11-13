import { realpathSync } from 'node:fs'
import type { ipcMain } from 'electron'
import { IPC } from '@shared/constants'
import type { ImportOutcome, ImportScan } from '@shared/importConfig'
import type { McpServerConfig } from '@shared/types'
import { getSettings, saveSettings } from './store'
import { hasNewImportables, importSelected, scanImportables, type ImportDeps } from './importConfig'
import { legacyRulesNoticeApplies } from './globalRules'
import {
  answerImportOffer,
  dismissLegacyRulesNotice,
  isImportOfferAnswered,
  isLegacyRulesNoticeDismissed
} from './legacyRulesNotice'

/** The open project as a real directory, or null (an empty or missing one is no project). */
function workspaceArg(workspace: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace) return null
  try {
    return realpathSync(workspace)
  } catch {
    return null
  }
}

/** Add servers to the user's settings, never replacing one whose id is taken. */
export function addUserMcpServers(servers: McpServerConfig[]): ReturnType<typeof saveSettings> {
  const current = getSettings()
  const list = [...(current.mcpServers ?? [])]
  for (const s of servers) {
    if (list.some((x) => x.id === s.id)) continue
    list.push(s)
  }
  return saveSettings({ ...current, mcpServers: list })
}

function deps(workspace: unknown): ImportDeps {
  return {
    workspace: workspaceArg(workspace),
    userMcpServers: () => getSettings().mcpServers ?? [],
    addUserMcpServers,
    onLegacyImported: dismissLegacyRulesNotice
  }
}

/** Import from other tools: scan, apply, and the one-time offer. */
export function registerImportIpc(handle: typeof ipcMain.handle): void {
  handle(IPC.importScan, (_event, workspace: unknown): Promise<ImportScan> => scanImportables(deps(workspace)))
  handle(
    IPC.importApply,
    (_event, workspace: unknown, ids: unknown): Promise<ImportOutcome> => importSelected(ids, deps(workspace))
  )
  // Offered once, the first time something is found. Not while the global-rules
  // notice is up: one banner at a time, and that one asks about its own file.
  handle(IPC.importOfferStatus, async (_event, workspace: unknown): Promise<boolean> => {
    if (isImportOfferAnswered()) return false
    if (!isLegacyRulesNoticeDismissed() && legacyRulesNoticeApplies()) return false
    return hasNewImportables(deps(workspace))
  })
  handle(IPC.importOfferAnswer, (): void => answerImportOffer())
}

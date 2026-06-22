import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { IPC } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, AgentStartRequest, ToolApprovalDecision } from '@shared/agent'
import { getSettings, saveSettings, rememberWorkspace, getProvider } from './store'
import { setKey, deleteKey } from './secrets'
import { listModels } from './providers'
import { startRun, cancelRun, resolveApproval } from './agent/loop'

/** Register every IPC handler the renderer can call. */
export function registerIpc(): void {
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  ipcMain.handle(IPC.workspacePick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    rememberWorkspace(dir)
    return dir
  })

  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsSave, (_event, next: AppSettings) => saveSettings(next))

  ipcMain.handle(IPC.settingsSetKey, (_event, providerId: string, key: string) => {
    setKey(providerId, key)
    return getSettings()
  })

  ipcMain.handle(IPC.settingsDeleteKey, (_event, providerId: string) => {
    deleteKey(providerId)
    return getSettings()
  })

  ipcMain.handle(IPC.settingsListModels, async (_event, providerId: string) => {
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    return listModels(provider)
  })

  // Agent: fire-and-forget; progress is streamed back over IPC.agentEvent.
  ipcMain.handle(IPC.agentStart, async (event, req: AgentStartRequest) => {
    const send = (e: AgentEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.agentEvent, e)
    }
    void startRun(req, send)
  })

  ipcMain.handle(IPC.agentCancel, (_event, runId: string) => {
    cancelRun(runId)
  })

  ipcMain.handle(
    IPC.agentApprove,
    (_event, runId: string, callId: string, decision: ToolApprovalDecision) => {
      resolveApproval(runId, callId, decision)
    }
  )
}

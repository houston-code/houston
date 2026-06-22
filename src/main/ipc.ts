import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { IPC } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import type { AgentEvent, AgentSendRequest, ToolApprovalDecision } from '@shared/agent'
import { getSettings, saveSettings, rememberWorkspace, getProvider } from './store'
import { setKey, deleteKey } from './secrets'
import { listModels } from './providers'
import { startRun, cancelRun, resolveApproval } from './agent/loop'
import {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  setMessages,
  updateConversationMeta
} from './conversations'

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

  // Conversations
  ipcMain.handle(IPC.conversationList, () => listConversations())
  ipcMain.handle(IPC.conversationGet, (_event, id: string) => getConversation(id))
  ipcMain.handle(
    IPC.conversationCreate,
    (_event, input: { workspace: string; providerId: string; model: string }) =>
      createConversation(input)
  )
  ipcMain.handle(IPC.conversationDelete, (_event, id: string) => {
    deleteConversation(id)
  })

  // Agent: fire-and-forget; progress is streamed back over IPC.agentEvent.
  ipcMain.handle(IPC.agentStart, async (event, req: AgentSendRequest) => {
    const send = (e: AgentEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.agentEvent, e)
    }

    const conv = getConversation(req.conversationId)
    if (!conv) {
      send({ runId: req.runId, type: 'error', message: 'Conversation not found.' })
      return
    }

    const messages = [...conv.messages, { role: 'user' as const, content: req.userText }]
    setMessages(conv.id, messages)
    updateConversationMeta(conv.id, { providerId: req.providerId, model: req.model })

    void startRun(
      {
        runId: req.runId,
        workspace: conv.workspace,
        providerId: req.providerId,
        model: req.model,
        approvalPolicy: req.approvalPolicy,
        messages
      },
      send,
      (msgs) => setMessages(conv.id, msgs)
    )
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

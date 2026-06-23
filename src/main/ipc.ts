import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { IPC } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import type {
  AgentEvent,
  AgentSendRequest,
  ChatMessage,
  ConversationMeta,
  ToolApprovalDecision
} from '@shared/agent'
import { validateImportedConversation, resolveImportWorkspace } from '@shared/conversation-io'
import { sanitizeAttachments } from '@shared/images'
import { getSettings, saveSettings, rememberWorkspace, getProvider } from './store'
import { setKey, deleteKey } from './secrets'
import { listModels } from './providers'
import { startRun, cancelRun, resolveApproval } from './agent/loop'
import { restoreCheckpoint, reapplyCheckpoint } from './agent/checkpoints'
import { findFiles } from './agent/mentions'
import { loadCommands } from './agent/commands'
import { realpathSync } from 'node:fs'
import {
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  importConversation,
  organizeConversation,
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

  // Pick a directory without recording it as a recent workspace (used to add an
  // extra allowed root in Settings).
  ipcMain.handle(IPC.directoryPick, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a directory',
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Fuzzy file search for the composer's @-mention autocomplete. Confined to the
  // workspace (realpath'd, like the agent loop) so it can't list outside it.
  ipcMain.handle(
    IPC.workspaceListFiles,
    async (_event, workspace: string, query: string): Promise<string[]> => {
      if (!workspace) return []
      let root: string
      try {
        root = realpathSync(workspace)
      } catch {
        return []
      }
      return findFiles(root, typeof query === 'string' ? query : '')
    }
  )

  // Custom slash commands from the workspace's .houston/commands directory.
  ipcMain.handle(IPC.commandsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      return await loadCommands(realpathSync(workspace))
    } catch {
      return []
    }
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
  // Rename / pin / move-to-group. Does not affect the recency ordering.
  ipcMain.handle(
    IPC.conversationOrganize,
    (_event, id: string, patch: { title?: string; pinned?: boolean; groupId?: string | null }) => {
      organizeConversation(id, patch)
    }
  )

  // Export a conversation to a JSON file the user chooses. Returns the path, or
  // null if cancelled / unknown id.
  ipcMain.handle(IPC.conversationExport, async (event, id: string): Promise<string | null> => {
    const conv = getConversation(id)
    if (!conv) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const safeTitle = conv.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'conversation'
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export conversation',
      defaultPath: `${safeTitle}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, JSON.stringify(conv, null, 2), 'utf8')
    return res.filePath
  })

  // Import a conversation from a JSON file into a new conversation. Returns its
  // metadata, or null if cancelled. Throws (surfaced to the renderer) on a
  // malformed file.
  ipcMain.handle(IPC.conversationImport, async (event): Promise<ConversationMeta | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import conversation',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const raw = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
    const data = validateImportedConversation(raw)
    const settings = getSettings()
    const conv = importConversation(data, {
      // Only honor the file's workspace if it's already a trusted (recents) dir;
      // otherwise an import must not widen the sandbox scope.
      workspace: resolveImportWorkspace(data.workspace, settings.recentWorkspaces),
      providerId: settings.selected?.providerId ?? '',
      model: settings.selected?.model ?? ''
    })
    const { messages: _messages, ...meta } = conv
    return meta
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

    const images = sanitizeAttachments(req.images)
    const userMessage: ChatMessage = {
      role: 'user',
      content: req.userText,
      ...(images.length ? { images } : {})
    }
    const messages = [...conv.messages, userMessage]
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

  // Revert the file changes a run made (restore each touched file to its pre-turn state).
  ipcMain.handle(IPC.checkpointRestore, (_event, runId: string): Promise<number> =>
    restoreCheckpoint(runId)
  )

  // Re-apply a reverted run's file changes (restore each touched file to its post-turn state).
  ipcMain.handle(IPC.checkpointReapply, (_event, runId: string): Promise<number> =>
    reapplyCheckpoint(runId)
  )
}

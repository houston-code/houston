import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
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
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'
import { validateImportedConversation, resolveImportWorkspace } from '@shared/conversation-io'
import { conversationToHtml } from '@shared/html-export'
import { sanitizeAttachments } from '@shared/images'
import { checkForUpdates, takePendingWhatsNew } from './updater'
import { getSettings, saveSettings, rememberWorkspace, getProvider } from './store'
import { setKey, deleteKey } from './secrets'
import { listModels } from './providers'
import {
  cancelRun,
  resolveApproval,
  resolveQuestion,
  setRunPolicy,
  activeRunForConversation
} from './agent/loop'
import { addToQueue, removeFromQueue, clearQueue, listQueue } from './agent/queue'
import { runAndDrain, type DrainIO } from './agent/drain'
import { notificationFor, notifyAgentEvent, workspaceLabel } from './notifications'
import { restoreCheckpoint, reapplyCheckpoint } from './agent/checkpoints'
import { compactConversationNow } from './agent/compact'
import { findFiles } from './agent/mentions'
import { loadCommands } from './agent/commands'
import { getRepoInfo, createWorktree, removeWorktree } from './agent/worktree'
import { collectWorkingTreeChanges } from './agent/workingTree'
import { realpathSync } from 'node:fs'
import {
  listConversations,
  searchConversations,
  getConversation,
  createConversation,
  forkConversation,
  deleteConversation,
  importConversation,
  organizeConversation,
  addUsage,
  mergeRunningTotals,
  setMessages,
  updateConversationMeta
} from './conversations'

/**
 * Persist a usage event's tokens/cost and rewrite it to carry the conversation's
 * running cumulative totals (the agent loop reports only the latest turn). Shared
 * by the start and retry handlers so their accounting can't drift — a missed field
 * here silently broke cost tracking on retried turns once before. Non-usage events
 * pass through untouched.
 */
export function applyRunningUsage(conversationId: string, e: AgentEvent): AgentEvent {
  if (e.type !== 'usage') return e
  const total = addUsage(conversationId, {
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cost: e.cost
  })
  return mergeRunningTotals(e, total)
}

/** Stream one agent event to the renderer, persisting usage totals along the way. */
function emitEvent(sender: WebContents, conversationId: string, e: AgentEvent): void {
  const ev = applyRunningUsage(conversationId, e)
  if (!sender.isDestroyed()) sender.send(IPC.agentEvent, ev)
  maybeNotify(sender, conversationId, ev)
}

/**
 * Fire a native desktop notification for a notable agent event (turn finished,
 * approval/question needed, error) when Houston isn't focused. Cheap gates first —
 * the setting being off, or an event that never notifies — so streaming deltas
 * don't pay for the conversation lookup. Every agent event flows through emitEvent,
 * so this also covers queued follow-up runs.
 */
function maybeNotify(sender: WebContents, conversationId: string, e: AgentEvent): void {
  if (getSettings().desktopNotifications === false) return
  if (!notificationFor(e)) return
  const conv = getConversation(conversationId)
  notifyAgentEvent(e, BrowserWindow.fromWebContents(sender), {
    enabled: true,
    workspaceName: workspaceLabel(conv?.workspace)
  })
}

/** Push a conversation's updated queue to the renderer (used after an auto-flush). */
function emitQueueChanged(
  sender: WebContents,
  conversationId: string,
  items: QueuedInputMeta[]
): void {
  if (!sender.isDestroyed()) sender.send(IPC.agentQueueChanged, { conversationId, items })
}

/** Bind the run/queue orchestrator's output to a specific renderer. */
function makeIo(sender: WebContents): DrainIO {
  return {
    emit: (conversationId, e) => emitEvent(sender, conversationId, e),
    emitQueueChanged: (conversationId, items) => emitQueueChanged(sender, conversationId, items)
  }
}

/** Register every IPC handler the renderer can call. */
export function registerIpc(): void {
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  // Updates: manual "Check for updates" + the one-shot post-restart "What's new".
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates())
  ipcMain.handle(IPC.updateWhatsNew, () => takePendingWhatsNew())

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

  // Git repo info for the "new chat in a worktree" picker: main worktree root,
  // current branch, and local branches to pick a base from. Read-only; a non-repo
  // folder just reports isRepo:false so the UI hides the worktree option.
  ipcMain.handle(IPC.gitRepoInfo, async (_event, workspace: string) => {
    if (!workspace) return { isRepo: false, root: '', currentBranch: null, branches: [] }
    return getRepoInfo(workspace)
  })

  // All uncommitted working-tree changes (tracked diff vs HEAD + untracked files)
  // for the Changes panel. Read-only and hardened; a non-repo yields isRepo:false.
  ipcMain.handle(IPC.workingTreeChanges, async (_event, workspace: string) =>
    collectWorkingTreeChanges(typeof workspace === 'string' ? workspace : '')
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
  ipcMain.handle(IPC.conversationSearch, (_event, query: string) => searchConversations(query))
  ipcMain.handle(IPC.conversationGet, (_event, id: string) => getConversation(id))
  ipcMain.handle(
    IPC.conversationCreate,
    async (
      _event,
      input: {
        workspace: string
        providerId: string
        model: string
        /** When set, create a branch + worktree and run the chat there. */
        worktree?: { branch: string; base?: string }
      }
    ) => {
      if (input.worktree) {
        // Create the branch + worktree first; the worktree becomes the workspace.
        // Throws (surfaced to the renderer) on a bad branch name or git failure.
        const wt = await createWorktree({
          workspace: input.workspace,
          branch: input.worktree.branch,
          base: input.worktree.base
        })
        rememberWorkspace(wt.path)
        return createConversation({
          workspace: wt.path,
          providerId: input.providerId,
          model: input.model,
          worktree: wt
        })
      }
      return createConversation({
        workspace: input.workspace,
        providerId: input.providerId,
        model: input.model
      })
    }
  )
  ipcMain.handle(IPC.conversationFork, (_event, id: string) => forkConversation(id))
  ipcMain.handle(
    IPC.conversationCompact,
    (_event, id: string, providerId: string, model: string) =>
      compactConversationNow(id, providerId, model)
  )
  // Delete a conversation. When it owns a Houston-created worktree and the caller
  // opts in, also tear the worktree down (safe by default: a dirty worktree or an
  // unmerged branch is kept). Returns what happened to the worktree, or null.
  ipcMain.handle(
    IPC.conversationDelete,
    async (_event, id: string, opts?: { removeWorktree?: boolean; force?: boolean }) => {
      const conv = getConversation(id)
      // Drop any buffered follow-ups so a deleted chat's queue can't linger in memory.
      clearQueue(id)
      deleteConversation(id)
      if (opts?.removeWorktree && conv?.worktree) {
        return removeWorktree(conv.worktree, { force: opts.force })
      }
      return null
    }
  )
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

  // Export a conversation as a single self-contained HTML file (inline CSS, no
  // external assets or scripts). Returns the path, or null if cancelled / unknown id.
  ipcMain.handle(IPC.conversationExportHtml, async (event, id: string): Promise<string | null> => {
    const conv = getConversation(id)
    if (!conv) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const safeTitle = conv.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'conversation'
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export conversation as HTML',
      defaultPath: `${safeTitle}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, conversationToHtml(conv), 'utf8')
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
    const conv = getConversation(req.conversationId)
    if (!conv) {
      emitEvent(event.sender, req.conversationId, {
        runId: req.runId,
        type: 'error',
        message: 'Conversation not found.'
      })
      return
    }

    // Refuse a second run while one is already active for this conversation —
    // before appending the user message, so a rejected send doesn't leave an
    // orphan turn in the log. Mid-run input is normally buffered via the queue,
    // and the renderer re-adopts a live run on re-open; this is the backstop for
    // any path that slips past those.
    if (activeRunForConversation(conv.id)) {
      emitEvent(event.sender, conv.id, {
        runId: req.runId,
        type: 'error',
        message:
          'This conversation already has a run in progress. Wait for it to finish or stop it before sending again.'
      })
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

    void runAndDrain(makeIo(event.sender), conv.id, {
      runId: req.runId,
      workspace: conv.workspace,
      providerId: req.providerId,
      model: req.model,
      approvalPolicy: req.approvalPolicy,
      messages
    })
  })

  // Re-run the last turn after a failure: run on the conversation's existing
  // messages (the user turn is already persisted) without appending a new one.
  ipcMain.handle(
    IPC.agentRetry,
    async (
      event,
      req: { runId: string; conversationId: string; providerId: string; model: string; approvalPolicy: AppSettings['approvalPolicy'] }
    ) => {
      const conv = getConversation(req.conversationId)
      if (!conv) {
        emitEvent(event.sender, req.conversationId, {
          runId: req.runId,
          type: 'error',
          message: 'Conversation not found.'
        })
        return
      }
      // Same single-run-per-conversation guard as agentStart (see there).
      if (activeRunForConversation(conv.id)) {
        emitEvent(event.sender, conv.id, {
          runId: req.runId,
          type: 'error',
          message:
            'This conversation already has a run in progress. Wait for it to finish or stop it before retrying.'
        })
        return
      }
      void runAndDrain(makeIo(event.sender), conv.id, {
        runId: req.runId,
        workspace: conv.workspace,
        providerId: req.providerId,
        model: req.model,
        approvalPolicy: req.approvalPolicy,
        messages: conv.messages
      })
    }
  )

  ipcMain.handle(IPC.agentCancel, (_event, runId: string) => {
    cancelRun(runId)
  })

  // Queued input: buffer messages typed mid-run, dispatched (combined) when the
  // conversation's run finishes naturally. The renderer updates its bar from the
  // returned list; main pushes IPC.agentQueueChanged when an auto-flush empties it.
  ipcMain.handle(IPC.agentQueueAdd, (_event, req: QueueAddRequest): QueuedInputMeta[] =>
    addToQueue(req)
  )
  ipcMain.handle(IPC.agentQueueRemove, (_event, conversationId: string, id: string): QueuedInputMeta[] =>
    removeFromQueue(conversationId, id)
  )
  ipcMain.handle(IPC.agentQueueClear, (_event, conversationId: string): QueuedInputMeta[] =>
    clearQueue(conversationId)
  )
  ipcMain.handle(IPC.agentQueueList, (_event, conversationId: string): QueuedInputMeta[] =>
    listQueue(conversationId)
  )

  ipcMain.handle(
    IPC.agentApprove,
    (_event, runId: string, callId: string, decision: ToolApprovalDecision) => {
      resolveApproval(runId, callId, decision)
    }
  )

  // Deliver the user's answer to a pending ask_user question.
  ipcMain.handle(
    IPC.agentRespondQuestion,
    (_event, runId: string, callId: string, answer: string) => {
      resolveQuestion(runId, callId, answer)
    }
  )

  // Change the approval policy of an in-flight run so a mode switch made while the
  // agent is working takes effect on its next tool call, not just the next turn.
  ipcMain.handle(
    IPC.agentSetPolicy,
    (_event, runId: string, policy: AppSettings['approvalPolicy']) => {
      setRunPolicy(runId, policy)
    }
  )

  // The runId of the live run for a conversation, or null. The renderer queries
  // this when re-opening a conversation so it can re-adopt a still-running run
  // (show Stop, reconnect events/approvals) instead of starting a second one.
  ipcMain.handle(IPC.agentActiveRun, (_event, conversationId: string): string | null =>
    activeRunForConversation(conversationId)
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

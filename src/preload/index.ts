import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '@shared/constants'
import type { AppSettings, ApprovalPolicy } from '@shared/types'
import type { Command } from '@shared/commands'
import type { WorkingTreeChanges } from '@shared/workingTree'
import type {
  AgentEvent,
  AgentSendRequest,
  ChatMessage,
  Conversation,
  ConversationMeta,
  RepoInfo,
  ToolApprovalDecision,
  WorktreeRemoval
} from '@shared/agent'
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'

/**
 * The bridge object exposed to the renderer as `window.api`.
 * Everything the UI is allowed to ask the main process to do passes through here.
 */
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appGetVersion),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.workspacePick),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.directoryPick),
  listWorkspaceFiles: (workspace: string, query: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.workspaceListFiles, workspace, query),
  listCommands: (workspace: string): Promise<Command[]> =>
    ipcRenderer.invoke(IPC.commandsList, workspace),
  /** Git repo info for the "new chat in a worktree" picker (or isRepo:false). */
  getRepoInfo: (workspace: string): Promise<RepoInfo> =>
    ipcRenderer.invoke(IPC.gitRepoInfo, workspace),
  /** All uncommitted working-tree changes (vs HEAD + untracked) for the Changes panel. */
  getWorkingTreeChanges: (workspace: string): Promise<WorkingTreeChanges> =>
    ipcRenderer.invoke(IPC.workingTreeChanges, workspace),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (next: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSave, next),
  setKey: (providerId: string, key: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSetKey, providerId, key),
  deleteKey: (providerId: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsDeleteKey, providerId),
  listModels: (providerId: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.settingsListModels, providerId),

  // Conversations
  listConversations: (): Promise<ConversationMeta[]> => ipcRenderer.invoke(IPC.conversationList),
  searchConversations: (query: string): Promise<ConversationMeta[]> =>
    ipcRenderer.invoke(IPC.conversationSearch, query),
  getConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.conversationGet, id),
  createConversation: (input: {
    workspace: string
    providerId: string
    model: string
    /** When set, create a branch + worktree and run the chat there. */
    worktree?: { branch: string; base?: string }
  }): Promise<Conversation> => ipcRenderer.invoke(IPC.conversationCreate, input),
  forkConversation: (id: string): Promise<Conversation | null> =>
    ipcRenderer.invoke(IPC.conversationFork, id),
  compactConversation: (
    id: string,
    providerId: string,
    model: string
  ): Promise<{
    ok: boolean
    summarized: number
    messages?: ChatMessage[]
    reason?: 'empty' | 'single-turn'
    error?: string
  }> => ipcRenderer.invoke(IPC.conversationCompact, id, providerId, model),
  /**
   * Delete a conversation. Pass `removeWorktree` to also tear down a
   * Houston-created worktree (safe by default — a dirty worktree / unmerged branch
   * is kept unless `force`). Resolves with what happened to the worktree, or null.
   */
  deleteConversation: (
    id: string,
    opts?: { removeWorktree?: boolean; force?: boolean }
  ): Promise<WorktreeRemoval | null> => ipcRenderer.invoke(IPC.conversationDelete, id, opts),
  exportConversation: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.conversationExport, id),
  exportConversationHtml: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.conversationExportHtml, id),
  importConversation: (): Promise<ConversationMeta | null> =>
    ipcRenderer.invoke(IPC.conversationImport),
  organizeConversation: (
    id: string,
    patch: { title?: string; pinned?: boolean; groupId?: string | null }
  ): Promise<void> => ipcRenderer.invoke(IPC.conversationOrganize, id, patch),

  // Agent
  startAgent: (req: AgentSendRequest): Promise<void> => ipcRenderer.invoke(IPC.agentStart, req),
  retryAgent: (req: {
    runId: string
    conversationId: string
    providerId: string
    model: string
    approvalPolicy: AgentSendRequest['approvalPolicy']
  }): Promise<void> => ipcRenderer.invoke(IPC.agentRetry, req),
  cancelAgent: (runId: string): Promise<void> => ipcRenderer.invoke(IPC.agentCancel, runId),
  /** Queue a message typed while a run is active; returns the conversation's updated queue. */
  queueInput: (req: QueueAddRequest): Promise<QueuedInputMeta[]> =>
    ipcRenderer.invoke(IPC.agentQueueAdd, req),
  /** Drop one queued message; returns the conversation's updated queue. */
  dequeueInput: (conversationId: string, id: string): Promise<QueuedInputMeta[]> =>
    ipcRenderer.invoke(IPC.agentQueueRemove, conversationId, id),
  /** Discard a conversation's queued messages; returns the (empty) queue. */
  clearQueue: (conversationId: string): Promise<QueuedInputMeta[]> =>
    ipcRenderer.invoke(IPC.agentQueueClear, conversationId),
  /** Read a conversation's current queue (e.g. when opening it). */
  listQueue: (conversationId: string): Promise<QueuedInputMeta[]> =>
    ipcRenderer.invoke(IPC.agentQueueList, conversationId),
  /** Subscribe to main-initiated queue changes (an auto-flush). Returns an unsubscribe fn. */
  onQueueChanged: (
    cb: (payload: { conversationId: string; items: QueuedInputMeta[] }) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { conversationId: string; items: QueuedInputMeta[] }
    ): void => cb(payload)
    ipcRenderer.on(IPC.agentQueueChanged, listener)
    return () => ipcRenderer.removeListener(IPC.agentQueueChanged, listener)
  },
  approveTool: (runId: string, callId: string, decision: ToolApprovalDecision): Promise<void> =>
    ipcRenderer.invoke(IPC.agentApprove, runId, callId, decision),
  /** Answer a pending `ask_user` question. */
  answerQuestion: (runId: string, callId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agentRespondQuestion, runId, callId, answer),
  /** Change the approval policy of an in-flight run (live mode switch). */
  setAgentPolicy: (runId: string, policy: ApprovalPolicy): Promise<void> =>
    ipcRenderer.invoke(IPC.agentSetPolicy, runId, policy),
  /** Revert the file changes a run made. Returns the number of files restored. */
  restoreCheckpoint: (runId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.checkpointRestore, runId),
  /** Re-apply a reverted run's file changes. Returns the number of files re-applied. */
  reapplyCheckpoint: (runId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.checkpointReapply, runId),
  /** Subscribe to streamed agent events. Returns an unsubscribe function. */
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => cb(payload)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
  }
}

export type CoderApi = typeof api

// The app always runs with contextIsolation enabled.
contextBridge.exposeInMainWorld('api', api)

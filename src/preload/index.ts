import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '@shared/constants'
import type { AppSettings, ApprovalPolicy, IntegrationsInfo, ModelOption } from '@shared/types'
import type { EditorStatus, OpenResult } from '@shared/editors'
import type { Command } from '@shared/commands'
import type { WorkingTreeChanges } from '@shared/workingTree'
import type { ClipboardContent, PickedFile } from '@shared/composerContext'
import type {
  AgentEvent,
  AgentSendRequest,
  BackgroundShellInfo,
  ChatMessage,
  Conversation,
  ConversationMeta,
  DeleteConversationResult,
  RepoInfo,
  ToolApprovalDecision
} from '@shared/agent'
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'
import type { UpdateCheckResult, WhatsNew } from '@shared/update'

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
  /** Composer "+" menu: pick files via a native dialog; resolves with their capped text contents. */
  pickAttachmentFiles: (): Promise<PickedFile[]> => ipcRenderer.invoke(IPC.attachmentPickFiles),
  /** Composer "+" menu: read the system clipboard (text + optional image). */
  readClipboard: (): Promise<ClipboardContent> => ipcRenderer.invoke(IPC.clipboardRead),
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
  listModels: (providerId: string): Promise<ModelOption[]> =>
    ipcRenderer.invoke(IPC.settingsListModels, providerId),
  /** Whether a local model supports tool calling: true / false / null (unknown). */
  ollamaSupportsTools: (providerId: string, model: string): Promise<boolean | null> =>
    ipcRenderer.invoke(IPC.ollamaSupportsTools, providerId, model),
  /** Status of optional integrations (gh CLI, formatters) for the Settings hint. */
  getIntegrations: (): Promise<IntegrationsInfo> => ipcRenderer.invoke(IPC.integrationsGet),

  // "Open project in…" (a user gesture; launches an external editor / file manager)
  /** Which supported editors can be launched on this machine, for the "Open in…" menu. */
  listEditors: (): Promise<EditorStatus[]> => ipcRenderer.invoke(IPC.editorsList),
  /** Open a project folder in an external editor (by editor id). */
  openInEditor: (editorId: string, dir: string): Promise<OpenResult> =>
    ipcRenderer.invoke(IPC.openInEditor, editorId, dir),
  /** Reveal a folder in the OS file manager (Finder / Explorer). */
  revealInFileManager: (target: string): Promise<OpenResult> =>
    ipcRenderer.invoke(IPC.revealInFileManager, target),

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
   * Delete a conversation. Shows a native confirmation dialog (a three-way choice
   * when the chat owns a Houston-created worktree, which can outlive the chat).
   * Resolves with whether the delete happened and what became of the worktree.
   */
  deleteConversation: (id: string): Promise<DeleteConversationResult> =>
    ipcRenderer.invoke(IPC.conversationDelete, id),
  exportConversation: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.conversationExport, id),
  exportConversationHtml: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.conversationExportHtml, id),
  importConversation: (): Promise<ConversationMeta | null> =>
    ipcRenderer.invoke(IPC.conversationImport),
  organizeConversation: (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; groupId?: string | null }
  ): Promise<void> => ipcRenderer.invoke(IPC.conversationOrganize, id, patch),
  /** Persist a drag-to-reorder: `orderedIds` is the section's chats top-to-bottom;
   *  `move` carries the dragged chat's new group when the drag crossed sections. */
  reorderConversations: (
    orderedIds: string[],
    move?: { id: string; groupId: string | null }
  ): Promise<void> => ipcRenderer.invoke(IPC.conversationReorder, orderedIds, move),
  /** Subscribe to main-pushed title updates (a chat got a model-generated title). Returns an unsubscribe fn. */
  onConversationTitleChanged: (
    cb: (payload: { id: string; title: string }) => void
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: { id: string; title: string }): void =>
      cb(payload)
    ipcRenderer.on(IPC.conversationTitleChanged, listener)
    return () => ipcRenderer.removeListener(IPC.conversationTitleChanged, listener)
  },

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
  /**
   * The runId of the live run for a conversation, or null. Used to re-adopt a
   * backgrounded run when its conversation is re-opened, instead of starting a
   * second concurrent run.
   */
  getActiveRun: (conversationId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.agentActiveRun, conversationId),
  /**
   * The prompts (approvals / `ask_user` questions) currently blocking a
   * conversation's live run. Replayed after {@link getActiveRun}/adopt so a prompt
   * still awaiting the user re-renders when the conversation is re-opened.
   */
  getPendingPrompts: (conversationId: string): Promise<AgentEvent[]> =>
    ipcRenderer.invoke(IPC.agentPendingPrompts, conversationId),
  /** The ids of every conversation with a live run (for the sidebar "running" dot). */
  getRunningConversations: (): Promise<string[]> => ipcRenderer.invoke(IPC.agentRunningList),
  /** Subscribe to changes in the running-conversation set. Returns an unsubscribe fn. */
  onRunsChanged: (cb: (ids: string[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, ids: string[]): void => cb(ids)
    ipcRenderer.on(IPC.agentRunsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.agentRunsChanged, listener)
  },
  /** The background shells (run_shell background mode) for the tasks indicator. */
  getBackgroundShells: (): Promise<BackgroundShellInfo[]> => ipcRenderer.invoke(IPC.shellList),
  /** Subscribe to background-shell registry changes. Returns an unsubscribe fn. */
  onShellsChanged: (cb: (shells: BackgroundShellInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, shells: BackgroundShellInfo[]): void => cb(shells)
    ipcRenderer.on(IPC.shellsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.shellsChanged, listener)
  },
  /** Revert the file changes a run made. Returns the number of files restored. */
  restoreCheckpoint: (runId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.checkpointRestore, runId),
  /** Re-apply a reverted run's file changes. Returns the number of files re-applied. */
  reapplyCheckpoint: (runId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.checkpointReapply, runId),
  /**
   * The revertable checkpoint for a conversation's latest run, or null. Fetched on
   * re-open so the revert/redo affordance survives a transcript rebuild.
   */
  getCheckpoint: (
    conversationId: string
  ): Promise<{ runId: string; files: number; reverted: boolean } | null> =>
    ipcRenderer.invoke(IPC.checkpointGet, conversationId),
  /** Subscribe to streamed agent events. Returns an unsubscribe function. */
  onAgentEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => cb(payload)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
  },

  // Integrated terminal (PTY-backed)
  /** Spawn a terminal; resolves with its id. Output arrives via onTerminalData. */
  createTerminal: (opts: { cwd?: string; cols?: number; rows?: number }): Promise<string> =>
    ipcRenderer.invoke(IPC.terminalCreate, opts),
  /** Send user input (keystrokes / pasted text) to a terminal. */
  writeTerminal: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalInput, id, data),
  /** Tell a terminal its rendered grid size changed. */
  resizeTerminal: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalResize, id, cols, rows),
  /** Kill a terminal's shell. */
  killTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.terminalKill, id),
  /** Subscribe to a terminal's streamed output. Returns an unsubscribe fn. */
  onTerminalData: (cb: (payload: { id: string; data: string }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: { id: string; data: string }): void =>
      cb(payload)
    ipcRenderer.on(IPC.terminalData, listener)
    return () => ipcRenderer.removeListener(IPC.terminalData, listener)
  },
  /** Subscribe to terminal-exit notifications. Returns an unsubscribe fn. */
  onTerminalExit: (cb: (payload: { id: string; exitCode: number }) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { id: string; exitCode: number }
    ): void => cb(payload)
    ipcRenderer.on(IPC.terminalExit, listener)
    return () => ipcRenderer.removeListener(IPC.terminalExit, listener)
  },
  /** Tell main whether the terminal is focused, so ⌘W can route to the tab. */
  setTerminalFocused: (focused: boolean): void =>
    ipcRenderer.send(IPC.terminalFocusChanged, focused),
  /** Subscribe to the "close active terminal tab" signal (⌘W while focused). */
  onTerminalCloseActive: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.terminalCloseActive, listener)
    return () => ipcRenderer.removeListener(IPC.terminalCloseActive, listener)
  },

  /** Subscribe to the native menu's "Settings…" item. Returns an unsubscribe fn. */
  onOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.menuOpenSettings, listener)
    return () => ipcRenderer.removeListener(IPC.menuOpenSettings, listener)
  },

  // Updates
  /** Manually check the update feed (also broadcasts onUpdateAvailable when newer). */
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.updateCheck),
  /** Pending post-restart "What's new" highlights, consumed once. */
  getWhatsNew: (): Promise<WhatsNew | null> => ipcRenderer.invoke(IPC.updateWhatsNew),
  /** Subscribe to the on-launch auto-check finding a newer version. Returns an unsubscribe fn. */
  onUpdateAvailable: (
    cb: (payload: Extract<UpdateCheckResult, { status: 'available' }>) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: Extract<UpdateCheckResult, { status: 'available' }>
    ): void => cb(payload)
    ipcRenderer.on(IPC.updateAvailable, listener)
    return () => ipcRenderer.removeListener(IPC.updateAvailable, listener)
  }
}

export type CoderApi = typeof api

// The app always runs with contextIsolation enabled.
contextBridge.exposeInMainWorld('api', api)

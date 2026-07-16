import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '@shared/constants'
import type {
  AppSettings,
  ApprovalPolicy,
  FolderTrustStatus,
  IntegrationsInfo,
  McpServerStatus,
  ModelOption,
  PermissionRule
} from '@shared/types'
import type { EditorStatus, OpenResult } from '@shared/editors'
import type { FileEntry, FilePreview } from '@shared/files'
import type { Command } from '@shared/commands'
import type { WorkingTreeChanges } from '@shared/workingTree'
import type { GitInitResult } from '@shared/git'
import type { ClipboardContent, PickedFile } from '@shared/composerContext'
import type {
  AgentEvent,
  AgentSendRequest,
  BackgroundShellInfo,
  ChatMessage,
  Conversation,
  ConversationMeta,
  DeleteConversationResult,
  ElicitationResult,
  PlanDecision,
  RepoInfo,
  ToolApprovalDecision
} from '@shared/agent'
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'
import type { Scorecard } from '@shared/scorecard'
import type {
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateDownloadProgress,
  WhatsNew
} from '@shared/update'
import type { PreviewPaneSpec, PreviewServer } from '@shared/preview'

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
  /** One directory level for the Files panel — a folder's immediate children (lazy tree). */
  listWorkspaceDir: (workspace: string, relPath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke(IPC.workspaceListDir, workspace, relPath),
  /** Read a workspace file for the Files panel's in-app preview (text / image / note). */
  readWorkspaceFile: (workspace: string, relPath: string): Promise<FilePreview> =>
    ipcRenderer.invoke(IPC.workspaceReadFile, workspace, relPath),
  /** Open a workspace file in its OS default app (Files panel preview "Open" button). */
  openWorkspacePath: (workspace: string, relPath: string): Promise<OpenResult> =>
    ipcRenderer.invoke(IPC.workspaceOpenPath, workspace, relPath),
  /** Composer "+" menu: pick files via a native dialog; resolves with their capped text contents. */
  pickAttachmentFiles: (): Promise<PickedFile[]> => ipcRenderer.invoke(IPC.attachmentPickFiles),
  /** Composer "+" menu: read the system clipboard (text + optional image). */
  readClipboard: (): Promise<ClipboardContent> => ipcRenderer.invoke(IPC.clipboardRead),
  listCommands: (workspace: string): Promise<Command[]> =>
    ipcRenderer.invoke(IPC.commandsList, workspace),
  /** The workspace's skills (.houston/skills), name + description, for /skills. */
  listSkills: (workspace: string): Promise<Array<{ name: string; description: string }>> =>
    ipcRenderer.invoke(IPC.skillsList, workspace),
  /** The workspace's custom agents (.houston/agents), name + description, for /agents. */
  listAgents: (workspace: string): Promise<Array<{ name: string; description: string }>> =>
    ipcRenderer.invoke(IPC.agentsList, workspace),
  /** Git repo info for the "new chat in a worktree" picker (or isRepo:false). */
  getRepoInfo: (workspace: string): Promise<RepoInfo> =>
    ipcRenderer.invoke(IPC.gitRepoInfo, workspace),
  /** All uncommitted working-tree changes (vs HEAD + untracked) for the Changes panel. */
  getWorkingTreeChanges: (workspace: string): Promise<WorkingTreeChanges> =>
    ipcRenderer.invoke(IPC.workingTreeChanges, workspace),
  /** Initialize a git repo in the workspace so its files show up in the Changes panel. */
  initGitRepo: (workspace: string): Promise<GitInitResult> =>
    ipcRenderer.invoke(IPC.gitInit, workspace),
  /** Whether the user opted out of the first-write git-init prompt for this folder. */
  isGitInitDismissed: (workspace: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.gitInitDismissed, workspace),
  /** Persist "don't ask again" for the first-write git-init prompt (per folder). */
  dismissGitInit: (workspace: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.gitInitDismiss, workspace),
  /** Trust state + elevating-config counts for a workspace (drives the trust banner). */
  getFolderTrustStatus: (workspace: string): Promise<FolderTrustStatus> =>
    ipcRenderer.invoke(IPC.folderTrustStatus, workspace),
  /** Persist the user's trust decision for a workspace ('trusted' | 'never'). */
  decideFolderTrust: (workspace: string, decision: 'trusted' | 'never'): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.folderTrustDecide, workspace, decision),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (next: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSave, next),
  /** Tidy a permission-rule list (re-generalize run_shell allows + dedupe) for the panel. */
  cleanupPermissionRules: (rules: PermissionRule[]): Promise<PermissionRule[]> =>
    ipcRenderer.invoke(IPC.permissionsCleanup, rules),
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
  /**
   * OAuth sign-in for a saved remote MCP server: opens the browser flow and
   * stores the tokens. Resolves once the flow completes (or fails); the returned
   * settings carry the fresh `hasOAuth` flag.
   */
  mcpOAuthLogin: (serverId: string): Promise<{ ok: boolean; error?: string; settings: AppSettings }> =>
    ipcRenderer.invoke(IPC.mcpOAuthLogin, serverId),
  /** Forget a remote MCP server's stored OAuth tokens (sign out). */
  mcpOAuthLogout: (serverId: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.mcpOAuthLogout, serverId),
  /** Live per-server MCP connection status (connected / needs-auth / error). */
  getMcpStatuses: (): Promise<McpServerStatus[]> => ipcRenderer.invoke(IPC.mcpStatus),

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
  /** Aggregate a local-only per-model loop scorecard over every persisted chat.
   *  Computed on-device from local files — nothing is ever transmitted. */
  getScorecard: (): Promise<Scorecard> => ipcRenderer.invoke(IPC.conversationScorecard),
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
  /** Dispatch a conversation's queued messages now (e.g. "Send now" after Stop). */
  flushQueue: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agentQueueFlush, conversationId),
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
  /** `note` carries the user's guidance with a verdict ("no, do X instead"). */
  approveTool: (
    runId: string,
    callId: string,
    decision: ToolApprovalDecision,
    note?: string
  ): Promise<void> => ipcRenderer.invoke(IPC.agentApprove, runId, callId, decision, note),
  /** Answer a pending `ask_user` question. */
  answerQuestion: (runId: string, callId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agentRespondQuestion, runId, callId, answer),
  /** Answer a pending MCP elicitation (accept with field values / decline / cancel). */
  answerElicitation: (runId: string, elicitId: string, result: ElicitationResult): Promise<void> =>
    ipcRenderer.invoke(IPC.agentRespondElicitation, runId, elicitId, result),
  /** Resolve a pending `present_plan` review (accept / suggest changes / reject). */
  resolvePlan: (runId: string, callId: string, decision: PlanDecision): Promise<void> =>
    ipcRenderer.invoke(IPC.agentResolvePlan, runId, callId, decision),
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
  /**
   * The in-flight turn's streamed output not yet persisted (assistant text still
   * streaming, tools mid-execution). Replayed after {@link getActiveRun}/adopt so
   * re-opening a conversation mid-turn doesn't show an empty transcript — the disk
   * log for a still-streaming turn holds only the user message.
   */
  getLiveTranscript: (conversationId: string): Promise<AgentEvent[]> =>
    ipcRenderer.invoke(IPC.agentLiveTranscript, conversationId),
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

  // Live preview dock (started dev servers; see main/preview.ts)
  /** List the dev servers detected from the agent's started background shells. */
  listPreviewServers: (): Promise<PreviewServer[]> => ipcRenderer.invoke(IPC.previewListServers),
  /** Subscribe to changes in the detected server set. Returns an unsubscribe fn. */
  onPreviewServersChanged: (cb: (servers: PreviewServer[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, servers: PreviewServer[]): void => cb(servers)
    ipcRenderer.on(IPC.previewServersChanged, listener)
    return () => ipcRenderer.removeListener(IPC.previewServersChanged, listener)
  },
  /** Position + show/hide the native preview panes to match the dock's layout. */
  syncPreviewPanes: (specs: PreviewPaneSpec[], visible: boolean): void =>
    ipcRenderer.send(IPC.previewSync, specs, visible),
  /** Reload a single preview pane (e.g. once the server finishes starting). */
  reloadPreviewPane: (id: string): void => ipcRenderer.send(IPC.previewReload, id),
  /** Open a preview's loopback URL in the OS browser (validated loopback-only in main). */
  openPreviewExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.previewOpenExternal, url),

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
  },
  /** Subscribe to in-place update download progress (signed macOS). Returns an unsubscribe fn. */
  onUpdateDownloadProgress: (cb: (payload: UpdateDownloadProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: UpdateDownloadProgress): void => cb(payload)
    ipcRenderer.on(IPC.updateDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.updateDownloadProgress, listener)
  },
  /** Subscribe to an update finishing download (ready to install). Returns an unsubscribe fn. */
  onUpdateDownloaded: (cb: (payload: UpdateDownloaded) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: UpdateDownloaded): void => cb(payload)
    ipcRenderer.on(IPC.updateDownloaded, listener)
    return () => ipcRenderer.removeListener(IPC.updateDownloaded, listener)
  },
  /** Install a downloaded update now (quit, apply, relaunch). */
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall)
}

export type CoderApi = typeof api

// The app always runs with contextIsolation enabled.
contextBridge.exposeInMainWorld('api', api)

import { ipcMain, dialog, BrowserWindow, clipboard, shell } from 'electron'
import type { WebContents } from 'electron'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { IPC } from '@shared/constants'
import type { AppSettings, FolderTrustStatus, PermissionRule } from '@shared/types'
import { isApprovalPolicy } from '@shared/types'
import { cleanupPermissionRules } from './agent/permissions'
import type { PreviewPaneSpec, PreviewServer } from '@shared/preview'
import {
  isPlanDecision,
  isToolApprovalDecision,
  sanitizeElicitationResult,
  type AgentEvent,
  type AgentSendRequest,
  type ChatMessage,
  type ConversationMeta,
  type DeleteConversationResult,
  type PlanDecision,
  type ToolApprovalDecision
} from '@shared/agent'
import type { QueueAddRequest, QueuedInputMeta } from '@shared/queue'
import {
  validateImportedConversation,
  resolveImportWorkspace,
  MAX_IMPORT_BYTES
} from '@shared/conversation-io'
import { conversationToHtml } from '@shared/html-export'
import { sanitizeAttachments, exceedsImageSizeLimit } from '@shared/images'
import { MAX_ATTACHMENT_FILES, type ClipboardContent, type PickedFile } from '@shared/composerContext'
import { readPickedFile } from './pickedFiles'
import { checkForUpdates, installUpdate, takePendingWhatsNew } from './updater'
import {
  getSettings,
  saveSettings,
  rememberWorkspace,
  getProvider,
  isGitInitDismissed,
  dismissGitInit,
  folderTrustFor,
  setFolderTrust
} from './store'
import { loadProjectConfig } from './agent/projectConfig'
import { getIntegrations } from './integrations'
import {
  detectEditors,
  openProjectInEditor,
  openWorkspacePath,
  revealInFileManager
} from './openInEditor'
import { setKey, deleteKey, setMcpOAuthTokens } from './secrets'
import { runMcpOAuthFlow } from './mcp/oauth'
import { getMcpStatuses } from './mcp/manager'
import { openExternalSafely } from './safeExternal'
import { listModels } from './providers'
import { ollamaSupportsTools } from './providers/ollama'
import {
  cancelRun,
  resolveApproval,
  resolveElicitation,
  resolveQuestion,
  resolvePlan,
  setRunPolicy,
  runOwner,
  activeRunForConversation,
  pendingPromptsForConversation,
  liveTranscriptForConversation,
  runningConversationIds,
  onActiveRunsChanged
} from './agent/loop'
import { listShells, listPreviewServers, onShellsChanged } from './agent/shells'
import { addToQueue, removeFromQueue, clearQueue, listQueue } from './agent/queue'
import { runAndDrain, drainQueue, type DrainIO } from './agent/drain'
import { version as APP_VERSION } from '../../package.json'
import { notificationFor, notifyAgentEvent, workspaceLabel } from './notifications'
import {
  restoreCheckpoint,
  reapplyCheckpoint,
  getConversationCheckpoint,
  conversationForLatestRun
} from './agent/checkpoints'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from './terminal'
import { setTerminalFocused } from './menu'
import { syncPreviewPanes, reloadPreviewPane, assertLoopbackUrl } from './preview'
import { compactConversationNow } from './agent/compact'
import { findFiles } from './agent/mentions'
import { listDirectory, readWorkspaceFile } from './agent/fileTree'
import { loadCommands } from './agent/commands'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'
import { getRepoInfo, createWorktree, removeWorktree } from './agent/worktree'
import { collectWorkingTreeChanges } from './agent/workingTree'
import { initGitRepo } from './agent/gitInit'
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
  reorderConversations,
  computeScorecard,
  addUsage,
  mergeRunningTotals,
  setMessages,
  setGeneratedTitle,
  updateConversationMeta
} from './conversations'
import { createSpawnBackend } from './spawnSession'
import { setSpawnBackend } from './agent/spawn'
import { setSchedulerBackend } from './agent/scheduler'
import { createSchedulerService, fireViaSpawn, schedulesFilePath } from './schedulerService'

/**
 * Translate a delete-confirmation dialog button index into what should happen.
 * Button 0 is always Cancel (in both the plain and the worktree dialog), so a
 * cancel can never delete — the bug this guards against. Only the worktree
 * dialog's button 2 ("Delete & remove worktree") tears the worktree down.
 */
export function resolveDeleteAction(
  hasWorktree: boolean,
  response: number
): { delete: boolean; removeWorktree: boolean } {
  if (response === 0) return { delete: false, removeWorktree: false }
  return { delete: true, removeWorktree: hasWorktree && response === 2 }
}

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

/** Push a conversation's freshly model-generated title to the renderer. */
function emitTitleChanged(sender: WebContents, conversationId: string, title: string): void {
  if (!sender.isDestroyed()) sender.send(IPC.conversationTitleChanged, { id: conversationId, title })
}

/** Bind the run/queue orchestrator's output to a specific renderer. */
function makeIo(sender: WebContents): DrainIO {
  return {
    emit: (conversationId, e) => emitEvent(sender, conversationId, e),
    emitQueueChanged: (conversationId, items) => emitQueueChanged(sender, conversationId, items),
    emitTitleChanged: (conversationId, title) => emitTitleChanged(sender, conversationId, title)
  }
}

/**
 * A DrainIO for a spawned background run (see `spawn_session`). Its conversation
 * isn't tied to any one window — the user may open it in any of them — so its
 * events broadcast to every renderer, each of which routes by conversationId and
 * ignores runs it isn't currently showing. Usage is folded into the store exactly
 * once per event (not once per window), and a single native notification fires
 * (a background run's finished turn / needed approval is worth surfacing).
 */
function makeBroadcastIo(): DrainIO {
  const toEach = (send: (wc: WebContents) => void): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) send(win.webContents)
    }
  }
  return {
    emit: (conversationId, e) => {
      const ev = applyRunningUsage(conversationId, e)
      toEach((wc) => wc.send(IPC.agentEvent, ev))
      const primary = BrowserWindow.getAllWindows()[0]?.webContents
      if (primary) maybeNotify(primary, conversationId, ev)
    },
    emitQueueChanged: (conversationId, items) =>
      toEach((wc) => wc.send(IPC.agentQueueChanged, { conversationId, items })),
    emitTitleChanged: (conversationId, title) =>
      toEach((wc) => wc.send(IPC.conversationTitleChanged, { id: conversationId, title }))
  }
}

/**
 * Wire the agent's `spawn_session` tool to the real shell capabilities: create the
 * conversation (+ optional worktree), seed its first message, and start a background
 * run whose events broadcast to every window. Called once from {@link registerIpc}.
 *
 * The conversation ids of spawned sessions whose background run is still live are
 * tracked so the backend can cap the concurrent fan-out (see
 * {@link createSpawnBackend}); each id is dropped when its run settles.
 */
function wireSpawnSession(): void {
  const liveSpawnedRuns = new Set<string>()
  setSpawnBackend(
    createSpawnBackend({
      createWorktree,
      createConversation,
      seedMessages: setMessages,
      setTitle: (id, title) => {
        setGeneratedTitle(id, title)
      },
      getTitle: (id) => getConversation(id)?.title,
      rememberWorkspace,
      liveSpawnCount: () => liveSpawnedRuns.size,
      removeWorktree: (wt) => removeWorktree(wt),
      startBackgroundRun: (conversationId, req) => {
        // Fire-and-forget: the spawning turn shouldn't block on the child's run.
        // Owner is undefined — a background run any window can adopt and approve.
        // Track it as live for the concurrency cap; drop it when the run settles.
        liveSpawnedRuns.add(conversationId)
        void runAndDrain(makeBroadcastIo(), conversationId, req, undefined).finally(() =>
          liveSpawnedRuns.delete(conversationId)
        )
      }
    })
  )
}

/**
 * Upper bound on an `ask_user` answer accepted over IPC. Real answers are a short
 * option label or a line or two of free text; anything past this is a
 * malformed/hostile renderer, so we cap it before it becomes a tool result the
 * model must carry. Generous but bounded.
 */
export const MAX_QUESTION_ANSWER_LEN = 100_000

/**
 * Authorize a run-control IPC call (approve / answer / set-policy / cancel) against
 * the run's owner. Every AgentEvent broadcasts its runId to *every* window, so a
 * renderer can observe a runId for a run it doesn't own; without this gate any
 * window could approve/deny another window's dangerous tool call, inject an answer
 * into its ask_user prompt, escalate its policy to full-auto, or cancel it. The
 * owner is the WebContents that started the run (recorded in {@link startRun}); we
 * compare it to the caller's WebContents id. A run with no recorded owner — already
 * finished, or never registered — returns undefined, and the loop resolvers no-op
 * on unknown runIds anyway, so those are allowed through rather than special-cased.
 */
function callerOwnsRun(event: { sender: WebContents }, runId: string): boolean {
  const owner = runOwner(runId)
  return owner === undefined || owner === event.sender.id
}

/** Register every IPC handler the renderer can call. */
export function registerIpc(): void {
  // Bind the agent's spawn_session tool to the real shell capabilities (once).
  wireSpawnSession()

  // Scheduled runs: persist under userData, fire through the spawn backend just
  // wired above (a fired occurrence is an ordinary background session in the
  // sidebar). start() also catches up occurrences missed while the app was closed.
  const scheduler = createSchedulerService({ file: schedulesFilePath(), fire: fireViaSpawn() })
  setSchedulerBackend(scheduler)
  scheduler.start()

  // Use the bundled package.json version (inlined at build): `app.getVersion()`
  // reports Electron's own version in an unpackaged dev run, not Houston's.
  ipcMain.handle(IPC.appGetVersion, () => APP_VERSION)

  // Updates: manual "Check for updates" + the one-shot post-restart "What's new".
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates())
  ipcMain.handle(IPC.updateWhatsNew, () => takePendingWhatsNew())
  // "Restart to install" — apply a downloaded update now instead of on next quit.
  ipcMain.handle(IPC.updateInstall, () => installUpdate())

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

  // One directory level for the Finder-like Files panel. The renderer expands
  // folders lazily, so each call lists only a directory's immediate children;
  // listDirectory realpaths the workspace and confines the subpath to it.
  ipcMain.handle(IPC.workspaceListDir, async (_event, workspace: string, relPath: string) =>
    listDirectory(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Read a file selected in the Files panel for in-app preview. Confined to the
  // workspace; returns a text/image payload or a note kind for binary/oversize.
  ipcMain.handle(IPC.workspaceReadFile, async (_event, workspace: string, relPath: string) =>
    readWorkspaceFile(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Open a file selected in the Files panel in its OS default app. A user
  // gesture; the target is confined to the workspace before shell.openPath.
  ipcMain.handle(IPC.workspaceOpenPath, (_event, workspace: string, relPath: string) =>
    openWorkspacePath(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Composer "+" menu: pick files in a native dialog and return their (capped)
  // text contents as context for the next message. A user gesture, so any path is
  // allowed; reads are bounded and binary files come back with contents omitted.
  ipcMain.handle(IPC.attachmentPickFiles, async (event): Promise<PickedFile[]> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths.slice(0, MAX_ATTACHMENT_FILES).map(readPickedFile)
  })

  // Composer "+" menu: read the clipboard (text + image) on demand. The image is
  // re-encoded to PNG and dropped if it exceeds the per-image cap.
  ipcMain.handle(IPC.clipboardRead, (): ClipboardContent => {
    const text = clipboard.readText()
    const img = clipboard.readImage()
    let image: ClipboardContent['image'] = null
    if (!img.isEmpty()) {
      const data = img.toPNG().toString('base64')
      if (data && !exceedsImageSizeLimit(data)) image = { mediaType: 'image/png', data }
    }
    return { text: typeof text === 'string' ? text : '', image }
  })

  // Git repo info for the "new chat in a worktree" picker: main worktree root,
  // current branch, and local branches to pick a base from. Read-only; a non-repo
  // folder just reports isRepo:false so the UI hides the worktree option.
  ipcMain.handle(IPC.gitRepoInfo, async (_event, workspace: string) => {
    if (!workspace)
      return {
        isRepo: false,
        root: '',
        currentBranch: null,
        branches: [],
        isLinkedWorktreeRoot: false,
        exists: false
      }
    return getRepoInfo(workspace)
  })

  // All uncommitted working-tree changes (tracked diff vs HEAD + untracked files)
  // for the Changes panel. Read-only and hardened; a non-repo yields isRepo:false.
  ipcMain.handle(IPC.workingTreeChanges, async (_event, workspace: string) =>
    collectWorkingTreeChanges(typeof workspace === 'string' ? workspace : '')
  )

  // Initialize a git repo in the workspace so a non-git project's files become
  // visible/reviewable in the Changes panel (the "Initialize git repository" action).
  ipcMain.handle(IPC.gitInit, async (_event, workspace: string) =>
    initGitRepo(typeof workspace === 'string' ? workspace : '')
  )

  // First-write git-init prompt: whether the user opted out for this folder, and
  // persisting that opt-out ("Don't ask again for this folder"). Realpath-normalized
  // in the store so the same folder matches however its path is spelled.
  ipcMain.handle(IPC.gitInitDismissed, (_event, workspace: string) =>
    isGitInitDismissed(typeof workspace === 'string' ? workspace : '')
  )
  ipcMain.handle(IPC.gitInitDismiss, (_event, workspace: string) =>
    dismissGitInit(typeof workspace === 'string' ? workspace : '')
  )

  // Trusted folders: whether this workspace's project config elevates anything
  // (allow rules / hooks / MCP servers), and where the user's consent stands.
  ipcMain.handle(IPC.folderTrustStatus, async (_event, workspace: string): Promise<FolderTrustStatus> => {
    if (typeof workspace !== 'string' || !workspace) return { state: 'none' }
    const cfg = await loadProjectConfig(workspace)
    if (!cfg.elevatedHash) return { state: 'none' }
    return {
      state: folderTrustFor(workspace, cfg.elevatedHash),
      counts: {
        allowRules: cfg.elevated.allowRules.length,
        hooks: cfg.elevated.hooks.length,
        mcpServers: cfg.elevated.mcpServers.length
      }
    }
  })
  // Persist a trust decision. The fingerprint is recomputed here from the file on
  // disk — never accepted from the renderer — so consent is always bound to what
  // the project actually elevates at decision time.
  ipcMain.handle(IPC.folderTrustDecide, async (_event, workspace: string, decision: unknown) => {
    if (typeof workspace !== 'string' || !workspace) return getSettings()
    if (decision !== 'trusted' && decision !== 'never') return getSettings()
    const cfg = await loadProjectConfig(workspace)
    return setFolderTrust(workspace, decision, cfg.elevatedHash)
  })

  // Custom slash commands from the workspace's .houston/commands directory.
  ipcMain.handle(IPC.commandsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      return await loadCommands(realpathSync(workspace))
    } catch {
      return []
    }
  })

  // Read-only listing of the workspace's skills / custom agents for /skills and
  // /agents. Project to {name, description} only — the agent's full systemPrompt
  // (and a skill's path) never needs to cross into the renderer for a listing.
  ipcMain.handle(IPC.skillsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      const skills = await loadSkills(realpathSync(workspace))
      return skills.map((s) => ({ name: s.name, description: s.description }))
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.agentsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      const agents = await loadAgents(realpathSync(workspace))
      return agents.map((a) => ({ name: a.name, description: a.description }))
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.settingsGet, () => getSettings())

  ipcMain.handle(IPC.settingsSave, (_event, next: AppSettings) => saveSettings(next))

  // Pure transform for the Settings "Clean up rules" button — no state read/write.
  ipcMain.handle(IPC.permissionsCleanup, (_event, rules: PermissionRule[]) =>
    cleanupPermissionRules(Array.isArray(rules) ? rules : [])
  )

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

  // Preflight: does this local model support tool calling? Only meaningful for an
  // Ollama-style (openai-compatible) provider; anything else returns null (unknown)
  // so the UI never shows a false warning.
  ipcMain.handle(IPC.ollamaSupportsTools, async (_event, providerId: string, model: string) => {
    const provider = getProvider(providerId)
    if (!provider?.baseUrl || provider.kind !== 'openai-compatible') return null
    return ollamaSupportsTools(provider.baseUrl, model)
  })

  // MCP OAuth sign-in for a saved remote server: run the interactive browser flow
  // (discovery, dynamic registration, PKCE, loopback redirect) in the main process
  // and persist the minted tokens in the encrypted store. The renderer saves
  // settings first — the flow reads the persisted server URL by id — and the fresh
  // settings returned carry the updated derived `hasOAuth` flag.
  ipcMain.handle(
    IPC.mcpOAuthLogin,
    async (_event, serverId: string): Promise<{ ok: boolean; error?: string; settings: AppSettings }> => {
      const server = getSettings().mcpServers?.find((s) => s.id === serverId)
      if (!server?.url) {
        return { ok: false, error: 'Save the server (with its URL) before signing in.', settings: getSettings() }
      }
      try {
        const tokens = await runMcpOAuthFlow(server.url, {
          // The authorize URL opens in the user's real browser (scheme-allowlisted).
          openUrl: (url) => openExternalSafely(url)
        })
        setMcpOAuthTokens(serverId, tokens)
        return { ok: true, settings: getSettings() }
      } catch (e) {
        return { ok: false, error: (e as Error).message, settings: getSettings() }
      }
    }
  )

  // Forget a server's stored OAuth token set (sign out).
  ipcMain.handle(IPC.mcpOAuthLogout, (_event, serverId: string): AppSettings => {
    setMcpOAuthTokens(serverId, null)
    return getSettings()
  })

  // Live per-server connection status (connected / needs-auth / error) for Settings.
  ipcMain.handle(IPC.mcpStatus, () => getMcpStatuses())

  // Optional-integrations status (gh CLI, formatters) for the Settings hint.
  ipcMain.handle(IPC.integrationsGet, () => getIntegrations())

  // "Open project in…" — user gesture, launches an external editor / file manager.
  ipcMain.handle(IPC.editorsList, () => detectEditors())
  ipcMain.handle(IPC.openInEditor, (_event, editorId: string, dir: string) =>
    openProjectInEditor(editorId, dir)
  )
  ipcMain.handle(IPC.revealInFileManager, (_event, target: string) => revealInFileManager(target))

  // Conversations
  ipcMain.handle(IPC.conversationList, () => listConversations())
  ipcMain.handle(IPC.conversationSearch, (_event, query: string) => searchConversations(query))
  ipcMain.handle(IPC.conversationGet, (_event, id: string) => getConversation(id))
  // Local-only per-model loop scorecard — aggregated on-device, never transmitted.
  ipcMain.handle(IPC.conversationScorecard, () => computeScorecard())
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
        // Remember the durable repo root as the recent workspace, NOT the worktree
        // dir: the worktree is per-chat and gets torn down, so remembering its path
        // would leave a dead default that seeds the next new chat with a phantom repo.
        rememberWorkspace(wt.repoRoot)
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
  // Delete a conversation, confirming first via a native dialog so the choice is
  // unambiguous. A chat that owns a Houston-created worktree gets a three-way
  // choice — the worktree can outlive the chat — and in every case the Cancel
  // button truly cancels (returns deleted: false, nothing is touched).
  ipcMain.handle(
    IPC.conversationDelete,
    async (event, id: string): Promise<DeleteConversationResult> => {
      const conv = getConversation(id)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const title = conv?.title ?? 'this chat'
      const hasWorktree = !!conv?.worktree

      const { response } = await dialog.showMessageBox(
        win!,
        hasWorktree
          ? {
              type: 'warning',
              buttons: ['Cancel', 'Delete, keep worktree', 'Delete & remove worktree'],
              defaultId: 1,
              cancelId: 0,
              title: 'Delete chat',
              message: `Delete “${title}”?`,
              detail:
                `This chat has a git worktree on branch “${conv!.worktree!.branch}”.\n\n` +
                `Delete, keep worktree — remove the chat, leave the worktree on disk.\n` +
                `Delete & remove worktree — also tear down the worktree (any uncommitted ` +
                `or unmerged work is kept).`
            }
          : {
              type: 'warning',
              buttons: ['Cancel', 'Delete'],
              defaultId: 1,
              cancelId: 0,
              title: 'Delete chat',
              message: `Delete “${title}”?`,
              detail: 'This cannot be undone.'
            }
      )

      const action = resolveDeleteAction(hasWorktree, response)
      if (!action.delete) return { deleted: false }
      // Drop any buffered follow-ups so a deleted chat's queue can't linger in memory.
      clearQueue(id)
      deleteConversation(id)
      const worktree =
        action.removeWorktree && conv?.worktree ? await removeWorktree(conv.worktree) : null
      return { deleted: true, worktree }
    }
  )
  // Rename / pin / move-to-group. Does not affect the recency ordering.
  ipcMain.handle(
    IPC.conversationOrganize,
    (
      _event,
      id: string,
      patch: { title?: string; pinned?: boolean; archived?: boolean; groupId?: string | null }
    ) => {
      organizeConversation(id, patch)
    }
  )
  // Drag-to-reorder within a sidebar section. Also does not affect recency.
  ipcMain.handle(
    IPC.conversationReorder,
    (_event, orderedIds: string[], move?: { id: string; groupId: string | null }) => {
      reorderConversations(orderedIds, move)
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
    // Reject an oversized file BEFORE reading it into memory / JSON.parsing it, so
    // a huge or hostile file can't exhaust memory.
    const { size } = statSync(res.filePaths[0])
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(
        `Conversation file is too large (${Math.round(size / 1_000_000)} MB; max ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB).`
      )
    }
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

    // Validate the policy at the IPC boundary: an unknown value fails *open* downstream
    // (needsApproval auto-approves any non-'ask' policy; isBlockedByPlan stops guarding),
    // so coerce anything off the list to the most restrictive policy. Mirrors setRunPolicy.
    const approvalPolicy = isApprovalPolicy(req.approvalPolicy) ? req.approvalPolicy : 'plan'

    void runAndDrain(
      makeIo(event.sender),
      conv.id,
      {
        runId: req.runId,
        workspace: conv.workspace,
        providerId: req.providerId,
        model: req.model,
        approvalPolicy,
        messages
      },
      // Record the starting window so only it can approve/answer/cancel this run.
      event.sender.id
    )
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
      // Same boundary validation as agentStart: an unknown policy fails open, so coerce.
      const approvalPolicy = isApprovalPolicy(req.approvalPolicy) ? req.approvalPolicy : 'plan'
      void runAndDrain(
        makeIo(event.sender),
        conv.id,
        {
          runId: req.runId,
          workspace: conv.workspace,
          providerId: req.providerId,
          model: req.model,
          approvalPolicy,
          messages: conv.messages
        },
        // Record the starting window so only it can approve/answer/cancel this run.
        event.sender.id
      )
    }
  )

  ipcMain.handle(IPC.agentCancel, (event, runId: string) => {
    // Only the window that started the run may cancel it (runIds are broadcast to all).
    if (!callerOwnsRun(event, runId)) return
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
  // Dispatch a conversation's queued messages immediately as one combined turn.
  // Used by the queue bar's "Send now" after Stop/error leaves items held (the
  // auto-flush only fires on a natural finish). No-op if a run is already active
  // for the conversation — that run's own natural finish will drain the queue.
  ipcMain.handle(IPC.agentQueueFlush, (event, conversationId: string): void => {
    if (activeRunForConversation(conversationId)) return
    drainQueue(makeIo(event.sender), conversationId, event.sender.id)
  })

  ipcMain.handle(
    IPC.agentApprove,
    (event, runId: string, callId: string, decision: ToolApprovalDecision) => {
      // Validate at the boundary: an unknown decision must not reach the loop (where
      // it would be treated as a non-deny "approve" and silently run the call).
      if (!isToolApprovalDecision(decision)) return
      // Only the window that started the run may resolve its approval prompts.
      if (!callerOwnsRun(event, runId)) return
      resolveApproval(runId, callId, decision)
    }
  )

  // Deliver the user's answer to a pending ask_user question.
  ipcMain.handle(
    IPC.agentRespondQuestion,
    (event, runId: string, callId: string, answer: string) => {
      // Validate at the boundary (mirrors agentApprove's decision guard): a non-string
      // answer is malformed, and an unbounded one must not become an oversized tool
      // result — cap its length before it reaches the loop.
      if (typeof answer !== 'string') return
      // Only the window that started the run may answer its ask_user prompts.
      if (!callerOwnsRun(event, runId)) return
      resolveQuestion(runId, callId, answer.slice(0, MAX_QUESTION_ANSWER_LEN))
    }
  )

  // Deliver the user's answer to a pending MCP elicitation.
  ipcMain.handle(
    IPC.agentRespondElicitation,
    (event, runId: string, elicitId: string, result: unknown) => {
      // Validate + cap at the boundary: the content is forwarded verbatim to an
      // external MCP server, so a malformed or oversized payload stops here.
      const safe = sanitizeElicitationResult(result, MAX_QUESTION_ANSWER_LEN)
      if (!safe) return
      if (typeof elicitId !== 'string') return
      // Only the window that started the run may answer its elicitations.
      if (!callerOwnsRun(event, runId)) return
      resolveElicitation(runId, elicitId, safe)
    }
  )

  // Deliver the user's decision on a present_plan review (accept / suggest / reject).
  ipcMain.handle(
    IPC.agentResolvePlan,
    (event, runId: string, callId: string, decision: PlanDecision) => {
      // Validate at the boundary (mirrors agentApprove's decision guard): a malformed
      // decision must not reach the loop, and a "suggest" note must not become an
      // oversized tool result — cap its length before it does.
      if (!isPlanDecision(decision)) return
      // Only the window that started the run may resolve its plan reviews.
      if (!callerOwnsRun(event, runId)) return
      // Cap the model-facing free text (a suggestion note, or a hand-edited plan) so
      // an unbounded value can't become an oversized tool result.
      let safe: PlanDecision = decision
      if (decision.kind === 'suggest') {
        safe = { kind: 'suggest', note: decision.note.slice(0, MAX_QUESTION_ANSWER_LEN) }
      } else if (decision.kind === 'accept' && decision.editedBody !== undefined) {
        safe = {
          kind: 'accept',
          mode: decision.mode,
          editedBody: decision.editedBody.slice(0, MAX_QUESTION_ANSWER_LEN)
        }
      }
      resolvePlan(runId, callId, safe)
    }
  )

  // Change the approval policy of an in-flight run so a mode switch made while the
  // agent is working takes effect on its next tool call, not just the next turn.
  ipcMain.handle(
    IPC.agentSetPolicy,
    (event, runId: string, policy: AppSettings['approvalPolicy']) => {
      // Only the window that started the run may change its policy — otherwise any
      // window could silently escalate a live run to full-auto.
      if (!callerOwnsRun(event, runId)) return
      setRunPolicy(runId, policy)
    }
  )

  // The runId of the live run for a conversation, or null. The renderer queries
  // this when re-opening a conversation so it can re-adopt a still-running run
  // (show Stop, reconnect events/approvals) instead of starting a second one.
  ipcMain.handle(IPC.agentActiveRun, (_event, conversationId: string): string | null =>
    activeRunForConversation(conversationId)
  )

  // The prompts (approvals/questions) currently blocking the conversation's live
  // run. The renderer replays these right after re-adopting, so a prompt that was
  // awaiting the user when the transcript was last rebuilt re-renders its UI
  // instead of leaving the run wedged behind a spinner with no way to answer it.
  ipcMain.handle(IPC.agentPendingPrompts, (_event, conversationId: string): AgentEvent[] =>
    pendingPromptsForConversation(conversationId)
  )

  // The in-flight turn's streamed output not yet written to disk (assistant text
  // mid-stream, running tools). The renderer replays this right after re-adopting so
  // a mid-turn re-open doesn't show an empty transcript — most visibly on a freshly
  // spawned session opened to watch its first turn stream. Empty if no live run.
  ipcMain.handle(IPC.agentLiveTranscript, (_event, conversationId: string): AgentEvent[] =>
    liveTranscriptForConversation(conversationId)
  )

  // The ids of every conversation with a live run, for the sidebar "running" dot.
  // The renderer reads this once on load, then keeps it current via the
  // IPC.agentRunsChanged broadcast below.
  ipcMain.handle(IPC.agentRunningList, (): string[] => runningConversationIds())

  // Push the running set to every renderer whenever a run starts or ends, so the
  // sidebar dot stays live without polling. Broadcast (not sender-scoped) because
  // a run can finish while a different window is focused.
  onActiveRunsChanged((ids) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.agentRunsChanged, ids)
    }
  })

  // The background shells (run_shell background mode) for the tasks indicator —
  // queried once on load, then kept current via the shellsChanged broadcast.
  ipcMain.handle(IPC.shellList, () => listShells())

  // Push the shell registry to every renderer whenever one starts, exits, or first
  // reveals its dev-server URL, so the tasks indicator AND the Preview dock stay
  // live without polling. Broadcast for the same reason as the running-set push
  // above (a shell can change while another window is focused).
  onShellsChanged((shells) => {
    const servers = listPreviewServers()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue
      win.webContents.send(IPC.shellsChanged, shells)
      win.webContents.send(IPC.previewServersChanged, servers)
    }
  })

  // Authorize a checkpoint restore/reapply. Unlike the live run-control calls
  // gated by callerOwnsRun above, a checkpoint deliberately outlives its run (it
  // is persisted so it survives a restart), so there is no owner to compare the
  // caller against. Instead the runId must still be what the UI legitimately
  // offers: the LATEST turn of some conversation — an arbitrary historical runId
  // among the persisted snapshots is refused, since restoring one would clobber
  // newer work with stale content — and that conversation must not be mid-run,
  // where a revert would fight the live turn's writes (the renderer clears the
  // affordance when a new run starts, so no legitimate call arrives then).
  const checkpointCallAllowed = async (runId: string): Promise<boolean> => {
    if (typeof runId !== 'string') return false
    const conversationId = await conversationForLatestRun(runId)
    return conversationId !== null && activeRunForConversation(conversationId) === null
  }

  // Revert the file changes a run made (restore each touched file to its pre-turn state).
  ipcMain.handle(IPC.checkpointRestore, async (_event, runId: string): Promise<number> =>
    (await checkpointCallAllowed(runId)) ? restoreCheckpoint(runId) : 0
  )

  // Re-apply a reverted run's file changes (restore each touched file to its post-turn state).
  ipcMain.handle(IPC.checkpointReapply, async (_event, runId: string): Promise<number> =>
    (await checkpointCallAllowed(runId)) ? reapplyCheckpoint(runId) : 0
  )

  // The revertable checkpoint for a conversation's latest run (or null). The renderer
  // fetches this when re-opening a conversation so the revert/redo affordance — built
  // only from live events otherwise — survives a transcript rebuild, and (via the
  // on-disk fallback) an app restart.
  ipcMain.handle(
    IPC.checkpointGet,
    (
      _event,
      conversationId: string
    ): Promise<{ runId: string; files: number; reverted: boolean } | null> =>
      getConversationCheckpoint(conversationId)
  )

  // ---- Integrated terminal (PTY-backed) ----

  // Spawn a terminal; output/exit are pushed back to the creating webContents.
  ipcMain.handle(
    IPC.terminalCreate,
    (event, opts: { cwd?: string; cols?: number; rows?: number }): string =>
      createTerminal(event.sender, opts ?? {})
  )
  ipcMain.handle(IPC.terminalInput, (_event, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle(IPC.terminalResize, (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle(IPC.terminalKill, (_event, id: string): boolean => killTerminal(id))
  // Fire-and-forget focus signal so the ⌘W menu handler knows whether to close
  // the active terminal tab or the window.
  ipcMain.on(IPC.terminalFocusChanged, (_event, focused: boolean) => setTerminalFocused(focused))

  // ---- Live preview dock (started dev servers) ----

  ipcMain.handle(IPC.previewListServers, (): PreviewServer[] => listPreviewServers())
  // Reconcile the native preview views to the renderer-measured rectangles. A
  // fire-and-forget send: it runs on every dock resize / overlay toggle, so it
  // must stay cheap and never block the renderer.
  ipcMain.on(IPC.previewSync, (_event, specs: PreviewPaneSpec[], visible: boolean) =>
    syncPreviewPanes(specs, visible)
  )
  ipcMain.on(IPC.previewReload, (_event, id: string) => reloadPreviewPane(id))
  // Open a preview's URL in the OS browser — user-initiated, but re-validate
  // loopback-only so a stale/spoofed URL can't turn this into an open-redirect.
  ipcMain.handle(IPC.previewOpenExternal, async (_event, url: string): Promise<void> => {
    assertLoopbackUrl(url)
    await shell.openExternal(url)
  })
}

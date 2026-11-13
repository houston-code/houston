import { randomUUID } from 'node:crypto'
import { app, ipcMain, dialog, BrowserWindow, clipboard, ClipboardItem, nativeImage, shell } from 'electron'
import type { WebContents } from 'electron'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { IPC } from '@shared/constants'
import type {
  AppSettings,
  ApprovalPolicy,
  FolderTrustStatus,
  LegacyRulesDecideResult,
  MenuState,
  PermissionRule,
  SandboxStatus
} from '@shared/types'
import { isApprovalPolicy } from '@shared/types'
import { cleanupPermissionRules } from './agent/permissions'
import { activeBackendId, isSandboxed } from './sandbox'
import { describePermissionPolicy, defaultPolicyDeps, testPermission } from './permissionPolicy'
import { getRuleUsage } from './ruleUsage'
import type { PreviewPaneSpec, PreviewServer } from '@shared/preview'
import {
  isPlanDecision,
  isReasoningEffort,
  isToolApprovalDecision,
  sanitizeApprovalNote,
  sanitizeElicitationResult,
  type AgentEvent,
  type AgentSendRequest,
  type AgentStartResult,
  type ChatMessage,
  type ConversationSettingsPatch,
  type DeleteConversationResult,
  type ImportConversationResult,
  type PlanDecision,
  type ReasoningEffort,
  type ToolApprovalDecision
} from '@shared/agent'
import type { QueueAddRequest, QueuedInputMeta, SteerOutcome } from '@shared/queue'
import { parseConversationFile, resolveImportWorkspace, MAX_IMPORT_BYTES } from '@shared/conversation-io'
import { conversationToHtml } from '@shared/html-export'
import { sanitizeAttachments, exceedsImageSizeLimit, imageFileName, parseImageDataUrl } from '@shared/images'
import { sanitizeInvocation } from '@shared/promptInvocation'
import { MAX_ATTACHMENT_FILES, type ClipboardContent, type PickedFile } from '@shared/composerContext'
import { readPickedFile } from './pickedFiles'
import { cancelDownload, checkForUpdates, installUpdate, takePendingWhatsNew } from './updater'
import {
  getSettings,
  saveSettings,
  rememberWorkspace,
  openWorkspaceFolder,
  rememberModel,
  workspacePickerStartDir,
  getProvider,
  isGitInitDismissed,
  dismissGitInit,
  folderTrustFor,
  setFolderTrust
} from './store'
import { loadProjectConfig } from './agent/projectConfig'
import { getIntegrations, languageServerIntegration } from './integrations'
import {
  detectEditors,
  openProjectInEditor,
  openWorkspacePath,
  revealInFileManager
} from './openInEditor'
import { relaunchApp } from './quit-confirm'
import { setKey, deleteKey, setMcpOAuthTokens, secureStorageStatus, flushSecrets } from './secrets'
import { runMcpOAuthFlow } from './mcp/oauth'
import { getMcpStatuses } from './mcp/manager'
import { openExternalSafely } from './safeExternal'
import { shareHouston, shareHoustonFromMenu, shareHoustonVia } from './share'
import type { ShareResult, ShareTarget } from '@shared/share'
import { replyMessageIndexes, type ChatStatusMap } from '@shared/chatStatus'
import { createChatAttention, type ChatAttention } from './chatAttention'
import { join } from 'node:path'
import { getUserDataDir } from './userData'
import { ReadStateStore } from './readState'
import { isDirectory, LastChatStore, launchChat } from './lastChat'
import { applyAppBadge, attentionCount, dotPng } from './appBadge'
import { listModels } from './providers'
import { ollamaSupportsTools } from './providers/ollama'
import {
  cancelRun,
  resolveApproval,
  resolveElicitation,
  resolveQuestion,
  resolvePlan,
  setRunPolicy,
  setRunEffort,
  steerRun,
  unsteerRun,
  runOwner,
  activeRunForConversation,
  pendingPromptsForConversation,
  liveTranscriptForConversation,
  chatStatusSnapshot,
  onChatStatusChanged
} from './agent/loop'
import { killShell, listShells, listPreviewServers, onShellsChanged, shellTail } from './agent/shells'
import { addToQueue, removeFromQueue, clearQueue, forgetQueue, listQueue, queuedSteerIds, retargetQueue } from './agent/queue'
import { runAndDrain, drainQueue, type DrainIO } from './agent/drain'
import { createDeltaCoalescer, flushAllDeltas, type DeltaCoalescer } from './deltaCoalescer'
import { version as APP_VERSION } from '../../package.json'
import { gatherDoctorFacts } from './doctor'
import type { DoctorFacts } from '@shared/doctor'
import { saveMemory } from './memory'
import { handleMemoryRequest } from './memoryIpc'
import { defaultMemoryRoot } from './agent/memoryStore'
import type { MemoryResponse } from '@shared/memoryTypes'
import { decideLegacyRulesNotice, legacyRulesNoticeApplies } from './globalRules'
import { dismissLegacyRulesNotice, isLegacyRulesNoticeDismissed } from './legacyRulesNotice'
import { MAX_MEMORY_NOTE } from '@shared/memory'
import { notifyAgentEvent, workspaceLabel } from './notifications'
import { attentionSignals } from '@shared/notify'
import {
  restoreCheckpoint,
  reapplyCheckpoint,
  getConversationCheckpoint,
  conversationForLatestRun
} from './agent/checkpoints'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killTerminalsOf } from './terminal'
import { log } from './logger'
import { dismissEnvKeyOffers, dismissedEnvKeyOffers, envKeyOffers, envKeyValue } from './envKeys'
import { setMenuState, setTerminalFocused } from './menu'
import { syncPreviewPanes, reloadPreviewPane, assertLoopbackUrl } from './preview'
import {
  anyChatWindowFocused,
  chatShownBy,
  chatWindows,
  openChatWindow,
  setWindowShowing,
  takeLaunchRequest,
  targetWindow,
  windowShowing
} from './windows'
import { compactConversationNow } from './agent/compact'
import { findFiles } from './agent/mentions'
import { listDirectory, readWorkspaceFile } from './agent/fileTree'
import { loadCommands } from './agent/commands'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'
import {
  getRepoInfo,
  createWorktree,
  removeWorktree,
  isWorktreeDisposable
} from './agent/worktree'
import { collectWorkingTreeChanges } from './agent/workingTree'
import { initGitRepo } from './agent/gitInit'
import { realpathSync } from 'node:fs'
import {
  listConversations,
  searchConversations,
  getConversation,
  peekConversation,
  conversationExists,
  createConversation,
  forkConversation,
  deleteConversation,
  otherConversationsInWorktree,
  importConversation,
  organizeConversation,
  reorderConversations,
  computeScorecard,
  addUsage,
  mergeRunningTotals,
  setMessages,
  setGeneratedTitle,
  updateConversationMeta,
  setConversationSettings,
  reportChildToParent,
  saveSideChat
} from './conversations'
import { createSpawnBackend } from './spawnSession'
import { setSpawnBackend } from './agent/spawn'
import { decideProposal, hostProposalDeps, startProposal } from './proposals'
import { askSideChat, cancelSideChat, clearSideChat, hostSideChatDeps, sideChatView } from './sideChat'
import { setSchedulerBackend } from './agent/scheduler'
import { appendUserTurn } from './agent/userTurn'
import { canUndoRewind, previewRewind, rewindConversation, undoRewind } from './agent/rewind'
import { rewindInProgress } from './agent/rewindLock'
import {
  isRewindMode,
  type RewindMode,
  type RewindPreviewResult,
  type RewindResult,
  type UndoRewindResult
} from '@shared/rewind'
import { createSchedulerService, fireViaSpawn, schedulesFilePath } from './schedulerService'
import { parseMermaidRequest, registerHtmlVisual, renderMermaid, wireHtmlVisualProtocol } from './visualRender'

/** A preferences export is a few KB; anything past this is not one. */
const MAX_SETTINGS_FILE_BYTES = 2_000_000

/** Whether a usable key is stored for the provider, as settings report it. */
function providerHasKey(providerId: string): boolean {
  return getSettings().providers.some((p) => p.id === providerId && p.hasKey === true)
}

/** Longest pasted key accepted by testKey; real provider keys are far shorter. */
const MAX_TEST_KEY_LENGTH = 4096
/** Longest message text a rewind request may carry for its staleness check. */
const MAX_REWIND_TEXT = 1_000_000

/**
 * Check a candidate API key with a live model listing, without storing it, so a typo
 * can never replace a working key. Resolves to the number of models the key can see;
 * rejects with the provider's message, with the key itself scrubbed out of it.
 */
export async function testProviderKey(providerId: unknown, key: unknown): Promise<number> {
  if (typeof providerId !== 'string' || typeof key !== 'string') {
    throw new Error('Invalid provider or key.')
  }
  const candidate = key.trim()
  if (!candidate || candidate.length > MAX_TEST_KEY_LENGTH) throw new Error('Invalid key.')
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider: ${providerId}`)
  if (!provider.requiresKey) throw new Error(`${provider.label} doesn't use an API key.`)
  try {
    return (await listModels(provider, candidate)).length
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // No `cause`: the original error can carry the candidate key, and a cause would
    // keep it reachable to anything that logs or serializes this error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(msg.split(candidate).join('[key]'))
  }
}

/**
 * Which delete-confirmation dialog was shown: a plain chat, a chat whose worktree
 * holds work (keep/remove choice), or a chat whose worktree is clean and merged
 * (plain confirmation that also tears the worktree down, since nothing is lost).
 */
export type DeleteDialogKind = 'plain' | 'worktree' | 'disposableWorktree'

/**
 * Translate a delete-confirmation dialog button index into what should happen.
 * Button 0 is always Cancel (in every dialog), so a cancel can never delete — the
 * bug this guards against. The worktree dialog's button 2 ("Delete & remove
 * worktree") tears the worktree down; a disposable worktree goes with the chat.
 */
export function resolveDeleteAction(
  kind: DeleteDialogKind,
  response: number
): { delete: boolean; removeWorktree: boolean } {
  if (response === 0) return { delete: false, removeWorktree: false }
  const removeWorktree =
    kind === 'disposableWorktree' || (kind === 'worktree' && response === 2)
  return { delete: true, removeWorktree }
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
    cost: e.cost,
    ...(e.model ? { model: e.model } : {}),
    ...(e.cacheReadTokens ? { cacheReadTokens: e.cacheReadTokens } : {}),
    ...(e.cacheWriteTokens ? { cacheWriteTokens: e.cacheWriteTokens } : {})
  })
  return mergeRunningTotals(e, total)
}

let badgeIcon: Electron.NativeImage | null = null

/** Put the count of chats wanting the user on the app icon (or clear it). */
function updateAppBadge(status: ChatStatusMap): void {
  try {
    applyAppBadge(
      {
        platform: process.platform,
        setBadgeCount: (n) => app.setBadgeCount(n),
        windows: () => BrowserWindow.getAllWindows(),
        overlayIcon: () => (badgeIcon ??= nativeImage.createFromBuffer(dotPng()))
      },
      attentionCount(status),
      getSettings().appBadge !== false
    )
  } catch {
    // A platform without a badge (some Linux desktops) is not an error worth surfacing.
  }
}

/**
 * Unread tracking and the combined chat status (live runs + unread marks) the sidebar
 * shows. Created in {@link registerIpc}; every run event passes through it so a run
 * that ends out of view leaves its chat unread.
 */
let attention: ChatAttention | null = null

/**
 * The renderers a run's output goes to: the window that started it, then every other
 * chat window. Each renderer routes events by run and conversation and ignores runs it
 * isn't showing, so a chat open in another window (or reopened there after the starting
 * window closed) follows the run live. With one window this is just that window.
 */
function runOutputTargets(sender: WebContents): WebContents[] {
  const out = sender.isDestroyed() ? [] : [sender]
  for (const win of chatWindows()) {
    const wc = win.webContents
    if (!wc.isDestroyed() && wc.id !== sender.id) out.push(wc)
  }
  return out
}

/** Stream one agent event to the renderers, persisting usage totals along the way. */
function emitEvent(sender: WebContents, conversationId: string, e: AgentEvent): void {
  const ev = applyRunningUsage(conversationId, e)
  for (const wc of runOutputTargets(sender)) wc.send(IPC.agentEvent, ev)
  maybeNotify(sender, conversationId, ev)
  attention?.noteEvent(conversationId, ev)
}

/**
 * Pull the user back for a notable agent event while Houston isn't focused: a native
 * desktop notification (turn finished, approval/question needed, error, PR) and,
 * when the user turned them on, an attention sound (turn ended, input needed). Cheap
 * gates first (the settings being off, or an event that never signals) so streaming
 * deltas don't pay for the conversation lookup. Every agent event flows through
 * emitEvent, so this also covers queued follow-up runs.
 */
function maybeNotify(sender: WebContents, conversationId: string, e: AgentEvent): void {
  const signals = attentionSignals(e, getSettings())
  if (!signals) return
  // Nothing is signalled while the app is focused (the user is watching), so don't
  // parse the chat file just to label a notification that won't appear.
  const starter = sender.isDestroyed() ? null : BrowserWindow.fromWebContents(sender)
  if ((starter && !starter.isDestroyed() && starter.isFocused()) || anyChatWindowFocused()) return
  // The sound plays in, and a click lands on, the window showing the chat, else the one
  // that started the run, else the window the user was last in.
  const win = windowShowing(conversationId) ?? (starter && !starter.isDestroyed() ? starter : targetWindow()) ?? null
  if (signals.sound && win && !win.isDestroyed()) win.webContents.send(IPC.attentionSound, signals.sound)
  if (!signals.notify) return
  const conv = peekConversation(conversationId)
  notifyAgentEvent(e, win, {
    enabled: true,
    workspaceName: workspaceLabel(conv?.workspace),
    conversationId
  })
}

/** Push a conversation's updated queue to the renderer (used after an auto-flush). */
function emitQueueChanged(
  sender: WebContents,
  conversationId: string,
  items: QueuedInputMeta[]
): void {
  for (const wc of runOutputTargets(sender)) wc.send(IPC.agentQueueChanged, { conversationId, items })
}

/** Push a conversation's freshly model-generated title to the renderers. */
function emitTitleChanged(sender: WebContents, conversationId: string, title: string): void {
  for (const wc of runOutputTargets(sender)) wc.send(IPC.conversationTitleChanged, { id: conversationId, title })
}

/**
 * Wrap an event sink so streamed text and reasoning reach the windows merged per
 * display frame rather than one IPC message and one render per token (see
 * deltaCoalescer.ts). One coalescer per conversation, since an io outlives a run when
 * queued follow-ups drain through it.
 */
function coalescedEmit(
  emit: (conversationId: string, e: AgentEvent) => void
): (conversationId: string, e: AgentEvent) => void {
  const byConversation = new Map<string, DeltaCoalescer>()
  return (conversationId, e) => {
    let c = byConversation.get(conversationId)
    if (!c) {
      c = createDeltaCoalescer((ev) => emit(conversationId, ev))
      byConversation.set(conversationId, c)
    }
    c.push(e)
  }
}

/** Renderers whose lifecycle already ends their terminals (see watchTerminalHost). */
const terminalHosts = new WeakSet<WebContents>()

/**
 * End a renderer's terminals when its page goes away: the window closed (on macOS the
 * app keeps running), the page reloaded, or the renderer crashed. The page held the
 * only handle to them, so they would otherwise keep running unseen until quit. A
 * reload is a cross-document navigation of the main frame; the first page load
 * happens before any terminal exists, and an in-page navigation is not reported here.
 */
function watchTerminalHost(wc: WebContents): void {
  if (terminalHosts.has(wc)) return
  terminalHosts.add(wc)
  const release = (): void => {
    const n = killTerminalsOf(wc)
    if (n) log.info(`closed ${n} terminal(s) whose window went away`)
  }
  wc.once('destroyed', release)
  wc.on('render-process-gone', release)
  wc.on('did-navigate', release)
}

/** Bind the run/queue orchestrator's output to a specific renderer. */
function makeIo(sender: WebContents): DrainIO {
  const coalesced = coalescedEmit((conversationId, e) => emitEvent(sender, conversationId, e))
  return {
    imageGallery: true,
    emit: coalesced,
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
    for (const win of chatWindows()) {
      if (!win.webContents.isDestroyed()) send(win.webContents)
    }
  }
  return {
    imageGallery: true,
    emit: coalescedEmit((conversationId, e) => {
      const ev = applyRunningUsage(conversationId, e)
      toEach((wc) => wc.send(IPC.agentEvent, ev))
      const notifyVia = (windowShowing(conversationId) ?? targetWindow())?.webContents
      if (notifyVia) maybeNotify(notifyVia, conversationId, ev)
      attention?.noteEvent(conversationId, ev)
    }),
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
  // Live spawned runs → whether each counts toward the agent's concurrency cap.
  const liveSpawnedRuns = new Map<string, boolean>()
  setSpawnBackend(
    createSpawnBackend({
      createWorktree,
      createConversation,
      seedMessages: setMessages,
      setTitle: (id, title) => {
        setGeneratedTitle(id, title)
      },
      getTitle: (id) => peekConversation(id)?.title,
      rememberWorkspace,
      liveSpawnCount: () => [...liveSpawnedRuns.values()].filter(Boolean).length,
      removeWorktree: (wt) => removeWorktree(wt),
      startBackgroundRun: (conversationId, req, { countsTowardCap }) => {
        // Fire-and-forget: the spawning turn shouldn't block on the child's run.
        // Owner is undefined — a background run any window can adopt and approve.
        // Track it as live for the concurrency cap; drop it when the run settles.
        liveSpawnedRuns.set(conversationId, countsTowardCap)
        return runAndDrain(makeBroadcastIo(), conversationId, req, undefined).finally(() =>
          liveSpawnedRuns.delete(conversationId)
        )
      },
      reportToParent: reportChildToParent
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
  if (owner === undefined || owner === event.sender.id) return true
  // A chat can be open in more than one window, and the window that started a run may
  // have closed. Another chat window may control the run while it shows that run's
  // chat, the same as the starting window; any other window still can't.
  const shown = chatShownBy(event.sender.id)
  return shown !== null && activeRunForConversation(shown) === runId
}

/**
 * The clipboard's plain text, or '' when there is none. Electron 44 moved the clipboard to
 * Chromium's asynchronous W3C-shaped API, which can reject while another process holds the
 * OS clipboard lock — a transient condition the composer should read as "nothing to paste"
 * rather than surface as a failed paste.
 */
async function readClipboardText(): Promise<string> {
  try {
    const text = await clipboard.readText()
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * The first image on the clipboard, re-encoded to PNG and dropped if it exceeds the
 * per-image cap, or null. Electron 44 removed `clipboard.readImage()`, so an image now
 * arrives as a Blob under whichever `image/*` MIME type the source app offered (PNG from
 * most, JPEG from some). nativeImage re-encodes it to the single format the model APIs
 * accept, and reports empty for bytes that don't decode as an image at all.
 */
async function readClipboardImage(): Promise<ClipboardContent['image']> {
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types.filter((t) => t.startsWith('image/'))) {
        const payload = await item.getType(type)
        if (!(payload instanceof Blob)) continue
        const img = nativeImage.createFromBuffer(Buffer.from(await payload.arrayBuffer()))
        if (img.isEmpty()) continue
        const data = img.toPNG().toString('base64')
        if (data && !exceedsImageSizeLimit(data)) return { mediaType: 'image/png', data }
      }
    }
  } catch {
    // Clipboard unreadable (locked by another process, or a payload that won't decode).
  }
  return null
}

/** Register every IPC handler the renderer can call. */
/**
 * Register every IPC handler.
 *
 * `ready`, when given, is the startup work the handlers depend on (the credential store
 * being decrypted). The handlers are registered at once, so a window that is already
 * loading never calls a channel with no handler, but each request waits for `ready`
 * before it runs, and so does anything here that could start a run. That lets the
 * window be created while the OS credential store is still answering, instead of after
 * it. Once `ready` settles, requests run with no added hop. Without it (tests), nothing
 * waits.
 */
export function registerIpc(ready?: Promise<unknown>): void {
  let open = ready === undefined
  const opened = ready?.then(
    () => {
      open = true
    },
    () => {
      // The startup work logs its own failure; requests must still be answered.
      open = true
    }
  )
  /** `ipcMain.handle`, with the request held until startup has finished. */
  const handle: typeof ipcMain.handle = (channel, listener) =>
    ipcMain.handle(channel, (event, ...args) =>
      open || !opened ? listener(event, ...args) : opened.then(() => listener(event, ...args))
    )
  /**
   * `ipcMain.on`, held the same way. These carry window state (which chat is on
   * screen, the menu's state), and handling one can read settings, which must not
   * happen before the credential store is ready (see index.ts).
   */
  const on: typeof ipcMain.on = (channel, listener) =>
    ipcMain.on(channel, (event, ...args) => afterReady(() => listener(event, ...args)))
  /** Run `fn` now, or as soon as startup has finished. */
  const afterReady = (fn: () => void): void => {
    if (open || !opened) fn()
    else void opened.then(fn)
  }

  // Bind the agent's spawn_session tool to the real shell capabilities (once).
  wireSpawnSession()

  // Scheduled runs: persist under userData, fire through the spawn backend just
  // wired above (a fired occurrence is an ordinary background session in the
  // sidebar). start() also catches up occurrences missed while the app was closed.
  const scheduler = createSchedulerService({ file: schedulesFilePath(), fire: fireViaSpawn() })
  setSchedulerBackend(scheduler)
  // Its catch-up run needs the provider keys, so not before the credential store is ready.
  afterReady(() => scheduler.start())

  // Use the bundled package.json version (inlined at build): `app.getVersion()`
  // reports Electron's own version in an unpackaged dev run, not Houston's.
  handle(IPC.appGetVersion, () => APP_VERSION)

  // /doctor: the health facts, graded into a report by @shared/doctor in the
  // renderer. `workspace` is informational (the report's "workspace" row). Update
  // state has its own GUI surface, so the doctor's version row just shows the version.
  handle(IPC.doctorFacts, (_event, workspace: unknown): DoctorFacts => {
    const cwd = typeof workspace === 'string' ? workspace : ''
    return gatherDoctorFacts(cwd, { version: APP_VERSION, update: null })
  })
  // The composer's sandbox badge: a cheap read, unlike the full doctor probe.
  ipcMain.handle(
    IPC.sandboxStatus,
    (): SandboxStatus => ({ backend: activeBackendId(), enforced: isSandboxed() })
  )
  // `#`-capture: save a standing instruction to the workspace's AGENTS.md (project)
  // or ~/.houston/AGENTS.md (global), the files Houston already loads every run.
  // Returns the path written, or null when the input is malformed. Text is capped
  // here rather than trusting the renderer.
  handle(
    IPC.memorySave,
    async (_event, workspace: unknown, scope: unknown, text: unknown): Promise<string | null> => {
      if (typeof workspace !== 'string' || typeof text !== 'string') return null
      if (scope !== 'project' && scope !== 'global') return null
      // A project-scoped save needs a real workspace: an empty one makes the write
      // resolve to `AGENTS.md` in the process cwd and mkdir('') throw, which without
      // this would reject the IPC call (the renderer has no .catch, so the user got
      // no "couldn't save" feedback). Return null so the caller reports it cleanly.
      if (scope === 'project' && !workspace.trim()) return null
      const trimmed = text.trim().slice(0, MAX_MEMORY_NOTE)
      if (!trimmed) return null
      return saveMemory(workspace, scope, trimmed)
    }
  )

  // Cross-session memory's review page. Requests are validated in memoryIpc.ts.
  handle(IPC.memoryRequest, (_event, request: unknown): Promise<MemoryResponse> =>
    handleMemoryRequest(request)
  )
  // A user gesture with no argument: the only folder it can open is the store's own.
  handle(IPC.memoryReveal, async (): Promise<void> => {
    const root = defaultMemoryRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const err = await shell.openPath(root)
    if (err) throw new Error(err)
  })

  // One-time "global rules moved" notice: shown while ~/.claude/CLAUDE.md exists,
  // ~/.houston/AGENTS.md doesn't import it, and the user hasn't answered yet.
  handle(
    IPC.legacyRulesNoticeStatus,
    (): boolean => !isLegacyRulesNoticeDismissed() && legacyRulesNoticeApplies()
  )
  // Answer it (see decideLegacyRulesNotice: a failed import is reported, not recorded).
  handle(
    IPC.legacyRulesNoticeDecide,
    (_event, choice: unknown): Promise<LegacyRulesDecideResult> =>
      decideLegacyRulesNotice(choice, {
        current: getSettings,
        dismiss: () => {
          dismissLegacyRulesNotice()
          return getSettings()
        }
      })
  )

  // Updates: manual "Check for updates" + the one-shot post-restart "What's new".
  handle(IPC.updateCheck, () => checkForUpdates())
  handle(IPC.updateWhatsNew, () => takePendingWhatsNew())
  // "Restart to install" — apply a downloaded update now instead of on next quit.
  handle(IPC.updateInstall, () => installUpdate())
  // Closing the banner mid-download stops it, so nothing installs on the next quit.
  handle(IPC.updateCancelDownload, () => cancelDownload())

  // Share Houston: the sidebar button anchors the macOS share menu at the point it
  // passes (window-relative CSS px); a non-finite point falls back to the cursor.
  handle(IPC.shareHouston, (event, at?: { x: unknown; y: unknown }): ShareResult => {
    const point =
      at && Number.isFinite(at.x) && Number.isFinite(at.y)
        ? { x: at.x as number, y: at.y as number }
        : undefined
    return shareHouston(BrowserWindow.fromWebContents(event.sender), point)
  })
  handle(IPC.shareVia, (_event, target: ShareTarget) => shareHoustonVia(target))
  handle(IPC.shareFromMenu, () => shareHoustonFromMenu())

  handle(IPC.workspacePick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a project folder',
      defaultPath: workspacePickerStartDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    rememberWorkspace(dir)
    return dir
  })

  // Open a folder by path (a recent folder, or one dropped on the window). Main checks
  // it is an existing directory; anything else (a dropped file, a vanished recent) is null.
  handle(IPC.workspaceOpen, (_event, path: unknown): string | null => openWorkspaceFolder(path))

  // Pick a directory without recording it as a recent workspace (used to add an
  // extra allowed root in Settings).
  handle(IPC.directoryPick, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a directory',
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Fuzzy file search for the composer's @-mention autocomplete. Confined to the
  // workspace (realpath'd, like the agent loop) so it can't list outside it.
  handle(
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
  handle(IPC.workspaceListDir, async (_event, workspace: string, relPath: string) =>
    listDirectory(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Read a file selected in the Files panel for in-app preview. Confined to the
  // workspace; returns a text/image payload or a note kind for binary/oversize.
  handle(IPC.workspaceReadFile, async (_event, workspace: string, relPath: string) =>
    readWorkspaceFile(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Open a file selected in the Files panel in its OS default app. A user
  // gesture; the target is confined to the workspace before shell.openPath.
  handle(IPC.workspaceOpenPath, (_event, workspace: string, relPath: string) =>
    openWorkspacePath(
      typeof workspace === 'string' ? workspace : '',
      typeof relPath === 'string' ? relPath : ''
    )
  )

  // Composer "+" menu: pick files in a native dialog and return their (capped)
  // text contents as context for the next message. A user gesture, so any path is
  // allowed; reads are bounded and binary files come back with contents omitted.
  handle(IPC.attachmentPickFiles, async (event): Promise<PickedFile[]> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths.slice(0, MAX_ATTACHMENT_FILES).map(readPickedFile)
  })

  // Inline visuals: Mermaid renders in the main process's locked-down window (never
  // in the app renderer); HTML visuals are registered for their sandboxed frames only
  // while the user has them turned on.
  wireHtmlVisualProtocol()
  handle(IPC.visualMermaid, async (_event, source: unknown, theme: unknown) => {
    const req = parseMermaidRequest(source, theme)
    if (!req) return { error: 'The diagram is empty or too large to render.' }
    return renderMermaid(req.source, req.theme)
  })
  handle(IPC.visualRegisterHtml, (_event, html: unknown): string | null =>
    getSettings().htmlVisuals === true ? registerHtmlVisual(html) : null
  )

  // Image viewer: copy the shown image to the clipboard. The renderer only ever holds
  // image data URLs it was sent, but this is still an IPC boundary, so the payload is
  // parsed strictly (a supported image type, base64, size-capped) before use.
  handle(IPC.imageCopy, async (_event, dataUrl: unknown): Promise<boolean> => {
    const img = parseImageDataUrl(dataUrl)
    if (!img) return false
    try {
      const decoded = nativeImage.createFromBuffer(Buffer.from(img.data, 'base64'))
      if (decoded.isEmpty()) return false
      const blob = new Blob([new Uint8Array(decoded.toPNG())], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch {
      return false
    }
  })

  // Image viewer: save the shown image where the user picks (a user gesture, so any
  // folder they choose is fine). Resolves with the saved path, or null if cancelled.
  handle(IPC.imageSave, async (event, dataUrl: unknown, label: unknown): Promise<string | null> => {
    const img = parseImageDataUrl(dataUrl)
    if (!img) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const name = imageFileName(typeof label === 'string' ? label : 'image', img.mediaType)
    const ext = name.slice(name.lastIndexOf('.') + 1)
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save image',
      defaultPath: name,
      filters: [{ name: 'Image', extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, Buffer.from(img.data, 'base64'))
    return res.filePath
  })

  // Composer "+" menu: read the clipboard (text + image) on demand. Both halves are
  // independent: an unreadable image still pastes the text, and vice versa.
  handle(
    IPC.clipboardRead,
    async (): Promise<ClipboardContent> => ({
      text: await readClipboardText(),
      image: await readClipboardImage()
    })
  )

  // Git repo info for the "new chat in a worktree" picker: main worktree root,
  // current branch, and local branches to pick a base from. Read-only; a non-repo
  // folder just reports isRepo:false so the UI hides the worktree option.
  handle(IPC.gitRepoInfo, async (_event, workspace: string) => {
    if (!workspace)
      return {
        isRepo: false,
        root: '',
        currentBranch: null,
        unborn: false,
        branches: [],
        isLinkedWorktreeRoot: false,
        exists: false
      }
    return getRepoInfo(workspace)
  })

  // All uncommitted working-tree changes (tracked diff vs HEAD + untracked files)
  // for the Changes panel. Read-only and hardened; a non-repo yields isRepo:false.
  handle(IPC.workingTreeChanges, async (_event, workspace: string) =>
    collectWorkingTreeChanges(typeof workspace === 'string' ? workspace : '')
  )

  // Initialize a git repo in the workspace so a non-git project's files become
  // visible/reviewable in the Changes panel (the "Initialize git repository" action).
  handle(IPC.gitInit, async (_event, workspace: string) =>
    initGitRepo(typeof workspace === 'string' ? workspace : '')
  )

  // First-write git-init prompt: whether the user opted out for this folder, and
  // persisting that opt-out ("Don't ask again for this folder"). Realpath-normalized
  // in the store so the same folder matches however its path is spelled.
  handle(IPC.gitInitDismissed, (_event, workspace: string) =>
    isGitInitDismissed(typeof workspace === 'string' ? workspace : '')
  )
  handle(IPC.gitInitDismiss, (_event, workspace: string) =>
    dismissGitInit(typeof workspace === 'string' ? workspace : '')
  )

  // Trusted folders: whether this workspace's project config elevates anything
  // (allow rules / hooks / MCP servers), and where the user's consent stands.
  handle(IPC.folderTrustStatus, async (_event, workspace: string): Promise<FolderTrustStatus> => {
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
  handle(IPC.folderTrustDecide, async (_event, workspace: string, decision: unknown) => {
    if (typeof workspace !== 'string' || !workspace) return getSettings()
    if (decision !== 'trusted' && decision !== 'never') return getSettings()
    const cfg = await loadProjectConfig(workspace)
    return setFolderTrust(workspace, decision, cfg.elevatedHash)
  })

  // Custom slash commands from the workspace's .houston/commands directory.
  handle(IPC.commandsList, async (_event, workspace: string) => {
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
  handle(IPC.skillsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      const skills = await loadSkills(realpathSync(workspace))
      return skills.map((s) => ({ name: s.name, description: s.description }))
    } catch {
      return []
    }
  })
  handle(IPC.agentsList, async (_event, workspace: string) => {
    if (!workspace) return []
    try {
      const agents = await loadAgents(realpathSync(workspace))
      return agents.map((a) => ({ name: a.name, description: a.description }))
    } catch {
      return []
    }
  })

  handle(IPC.settingsGet, () => getSettings())

  handle(IPC.settingsSave, (_event, next: AppSettings) => {
    const saved = saveSettings(next)
    // The badge setting may have changed; reapply it against the current status.
    if (attention) updateAppBadge(attention.snapshot())
    return saved
  })

  // Pure transform for the Settings "Clean up rules" button — no state read/write.
  handle(IPC.permissionsCleanup, (_event, rules: PermissionRule[]) =>
    cleanupPermissionRules(Array.isArray(rules) ? rules : [])
  )

  // Read-only view of the rules that apply beside the user's own (admin + project).
  handle(IPC.permissionsPolicy, (_event, workspace: unknown) =>
    describePermissionPolicy(typeof workspace === 'string' ? workspace : null, defaultPolicyDeps(folderTrustFor))
  )
  // Settings' rule tester: matches only, reads nothing beyond the policy files above.
  // Bounded so a pasted novel or a runaway list can't stall the main process.
  handle(IPC.permissionsTest, (_event, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
    return testPermission(
      {
        workspace: str(i.workspace, 4096) || null,
        userRules: Array.isArray(i.userRules) ? (i.userRules as PermissionRule[]).slice(0, 5000) : [],
        tool: str(i.tool, 200),
        subject: str(i.subject, 20000),
        additionalRoots: getSettings().additionalRoots ?? []
      },
      defaultPolicyDeps(folderTrustFor)
    )
  })
  handle(IPC.permissionsUsage, () => getRuleUsage())

  // Preferences export/import. The renderer builds and parses the content (see
  // @shared/settingsPortable); main only moves bytes to and from a file the user picks.
  handle(IPC.settingsExportFile, async (event, content: unknown): Promise<string | null> => {
    if (typeof content !== 'string' || content.length > MAX_SETTINGS_FILE_BYTES) return null
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export settings',
      defaultPath: 'houston-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, content, 'utf8')
    return res.filePath
  })
  handle(IPC.settingsImportFile, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    // Size-check before reading, so a huge file is refused without loading it.
    if (statSync(res.filePaths[0]).size > MAX_SETTINGS_FILE_BYTES) {
      throw new Error('That file is too large to be a settings export.')
    }
    return readFileSync(res.filePaths[0], 'utf8')
  })

  // Wait for the encrypted write so a failed save reaches the renderer as an error.
  handle(IPC.settingsSetKey, async (_event, providerId: string, key: string) => {
    setKey(providerId, key)
    await flushSecrets()
    return getSettings()
  })

  // API keys found in this app's environment, offered for the secure store (envKeys.ts).
  // Only the provider, the variable's name and the key's last four characters cross to
  // the renderer; storing one takes the user's "Use it" and a live check of the key.
  handle(IPC.envKeyOffers, (_event, scope: unknown) =>
    envKeyOffers(
      process.env,
      { providers: getSettings().providers, hasKey: providerHasKey, dismissed: dismissedEnvKeyOffers() },
      scope === 'connect'
    )
  )
  handle(IPC.envKeyImport, async (_event, providerId: unknown): Promise<AppSettings> => {
    if (typeof providerId !== 'string') throw new Error('Invalid provider.')
    const key = envKeyValue(process.env, providerId)
    if (!key) throw new Error('That key is no longer in the environment.')
    // Never replace a stored key: the offer is only for a provider without one.
    if (providerHasKey(providerId)) throw new Error('A key is already saved for this provider.')
    await testProviderKey(providerId, key)
    setKey(providerId, key)
    await flushSecrets()
    log.info(`stored the ${providerId} API key from the environment, at the user's request`)
    return getSettings()
  })
  handle(IPC.envKeyDismiss, (_event, providerIds: unknown) => {
    dismissEnvKeyOffers(Array.isArray(providerIds) ? providerIds : [])
  })

  handle(IPC.settingsDeleteKey, async (_event, providerId: string) => {
    deleteKey(providerId)
    await flushSecrets()
    return getSettings()
  })

  handle(IPC.secureStorageStatus, () => secureStorageStatus())

  handle(IPC.appRelaunch, () => relaunchApp())

  handle(IPC.settingsListModels, async (_event, providerId: string) => {
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    return listModels(provider)
  })

  handle(IPC.settingsTestKey, (_event, providerId: unknown, key: unknown) =>
    testProviderKey(providerId, key)
  )

  // Preflight: does this local model support tool calling? Only meaningful for an
  // Ollama-style (openai-compatible) provider; anything else returns null (unknown)
  // so the UI never shows a false warning.
  handle(IPC.ollamaSupportsTools, async (_event, providerId: string, model: string) => {
    const provider = getProvider(providerId)
    if (!provider?.baseUrl || provider.kind !== 'openai-compatible') return null
    return ollamaSupportsTools(provider.baseUrl, model)
  })

  // MCP OAuth sign-in for a saved remote server: run the interactive browser flow
  // (discovery, dynamic registration, PKCE, loopback redirect) in the main process
  // and persist the minted tokens in the encrypted store. The renderer saves
  // settings first — the flow reads the persisted server URL by id — and the fresh
  // settings returned carry the updated derived `hasOAuth` flag.
  handle(
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
        await flushSecrets()
        return { ok: true, settings: getSettings() }
      } catch (e) {
        return { ok: false, error: (e as Error).message, settings: getSettings() }
      }
    }
  )

  // Forget a server's stored OAuth token set (sign out).
  handle(IPC.mcpOAuthLogout, (_event, serverId: string): AppSettings => {
    setMcpOAuthTokens(serverId, null)
    return getSettings()
  })

  // Live per-server connection status (connected / needs-auth / error) for Settings.
  handle(IPC.mcpStatus, () => getMcpStatuses())

  // Optional-integrations status (gh CLI, formatters) for the Settings hint.
  handle(IPC.integrationsGet, () =>
    getIntegrations({ languageServers: () => languageServerIntegration(getSettings()) })
  )

  // "Open project in…" — user gesture, launches an external editor / file manager.
  handle(IPC.editorsList, () => detectEditors())
  handle(IPC.openInEditor, (_event, editorId: string, dir: string) =>
    openProjectInEditor(editorId, dir)
  )
  handle(IPC.revealInFileManager, (_event, target: string) => revealInFileManager(target))

  // Conversations
  handle(IPC.conversationList, () => listConversations())
  handle(IPC.conversationSearch, (_event, query: string) => searchConversations(query))
  handle(IPC.conversationGet, (_event, id: string) => {
    // A window that loads the saved chat must first have every delta sent before it.
    flushAllDeltas()
    return getConversation(id)
  })
  // Local-only per-model loop scorecard — aggregated on-device, never transmitted.
  handle(IPC.conversationScorecard, () => computeScorecard())
  handle(
    IPC.conversationCreate,
    async (
      _event,
      input: {
        workspace: string
        providerId: string
        model: string
        /** The new chat's own settings (the defaults, as the renderer shows them). */
        reasoningEffort?: ReasoningEffort
        approvalPolicy?: ApprovalPolicy
        /** When set, create a branch + worktree and run the chat there. */
        worktree?: { branch: string; base?: string }
      }
    ) => {
      // createConversation drops either setting when it isn't a known value.
      const chatSettings = { reasoningEffort: input.reasoningEffort, approvalPolicy: input.approvalPolicy }
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
          ...chatSettings,
          worktree: wt
        })
      }
      return createConversation({
        workspace: input.workspace,
        providerId: input.providerId,
        model: input.model,
        ...chatSettings
      })
    }
  )
  handle(IPC.conversationSetSettings, (_event, id: string, patch: ConversationSettingsPatch) => {
    const meta = setConversationSettings(id, patch)
    // A message queued behind the live run goes out as this chat's next turn, so it
    // takes the change too (a mode tightened mid-run must not be undone by it).
    if (meta) retargetQueue(id, patch)
    return meta
  })
  handle(IPC.conversationFork, (_event, id: string) => forkConversation(id))
  handle(
    IPC.conversationCompact,
    (_event, id: string, providerId: string, model: string) =>
      compactConversationNow(id, providerId, model)
  )
  // Delete a conversation, confirming first via a native dialog so the choice is
  // unambiguous. A chat that owns a Houston-created worktree with work in it gets a
  // three-way choice — the worktree can outlive the chat. A clean, fully merged
  // worktree holds nothing to keep, so it gets the plain confirmation and is torn
  // down with the chat. In every case the Cancel button truly cancels (returns
  // deleted: false, nothing is touched).
  handle(
    IPC.conversationDelete,
    async (event, id: string): Promise<DeleteConversationResult> => {
      // Only the title and worktree are needed: no attachment bytes.
      const conv = peekConversation(id)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const title = conv?.title ?? 'this chat'
      // A worktree another chat still runs in (a fork shares its source's) is never
      // offered for removal, even when it looks disposable.
      const shared = conv?.worktree ? otherConversationsInWorktree(id, conv.worktree.path) > 0 : false
      const kind: DeleteDialogKind = !conv?.worktree || shared
        ? 'plain'
        : (await isWorktreeDisposable(conv.worktree))
          ? 'disposableWorktree'
          : 'worktree'

      const { response } = await dialog.showMessageBox(
        win!,
        kind === 'worktree'
          ? {
              type: 'warning',
              buttons: ['Cancel', 'Delete, keep worktree', 'Delete & remove worktree'],
              defaultId: 1,
              cancelId: 0,
              title: 'Delete chat',
              message: `Delete “${title}”?`,
              detail:
                `This chat has a git worktree on branch “${conv!.worktree!.branch}”.\n\n` +
                `Delete, keep worktree: remove the chat, leave the worktree on disk.\n` +
                `Delete & remove worktree: also tear down the worktree (any uncommitted ` +
                `or unmerged work is kept).`
            }
          : {
              type: 'warning',
              buttons: ['Cancel', 'Delete'],
              defaultId: 1,
              cancelId: 0,
              title: 'Delete chat',
              message: `Delete “${title}”?`,
              detail:
                kind === 'disposableWorktree'
                  ? `Its worktree on branch “${conv!.worktree!.branch}” has no changes or ` +
                    `unmerged commits, so it will be removed too. This cannot be undone.`
                  : shared
                    ? `This cannot be undone. Its worktree on branch “${conv!.worktree!.branch}” ` +
                      `stays, because another chat still uses it.`
                    : 'This cannot be undone.'
            }
      )

      const action = resolveDeleteAction(kind, response)
      if (!action.delete) return { deleted: false }
      deleteConversation(id)
      // Drop the cached queue too: it went with the file, and must not linger in memory.
      forgetQueue(id)
      attention?.forget(id)
      const worktree =
        action.removeWorktree && conv?.worktree ? await removeWorktree(conv.worktree) : null
      return { deleted: true, worktree }
    }
  )
  // Rename / pin / move-to-group. Does not affect the recency ordering.
  handle(
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
  handle(
    IPC.conversationReorder,
    (_event, orderedIds: string[], move?: { id: string; groupId: string | null }) => {
      reorderConversations(orderedIds, move)
    }
  )

  // Export a conversation to a JSON file the user chooses. Returns the path, or
  // null if cancelled / unknown id.
  handle(IPC.conversationExport, async (event, id: string): Promise<string | null> => {
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
    // A side chat exports as its exchanges only: the side agent's own transcript is
    // internal resume state, often far larger than the exchanges themselves.
    // Unsent queued input is not part of the conversation yet, so it stays home.
    const { sideChat, queuedInput: _queuedInput, ...rest } = conv
    const exported = sideChat ? { ...rest, sideChat: { turns: sideChat.turns } } : rest
    writeFileSync(res.filePath, JSON.stringify(exported, null, 2), 'utf8')
    return res.filePath
  })

  // Export a conversation as a single self-contained HTML file (inline CSS, no
  // external assets or scripts). Returns the path, or null if cancelled / unknown id.
  handle(IPC.conversationExportHtml, async (event, id: string): Promise<string | null> => {
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

  // Import a conversation from a JSON or HTML export into a new conversation.
  // Returns its metadata and whether only the visible text could be recovered (an
  // HTML export from before the embedded data block), or null if cancelled. Throws
  // (surfaced to the renderer) on a malformed file.
  handle(IPC.conversationImport, async (event): Promise<ImportConversationResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import conversation',
      properties: ['openFile'],
      filters: [{ name: 'Chat export (JSON or HTML)', extensions: ['json', 'html', 'htm'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    // Reject an oversized file BEFORE reading it into memory / parsing it, so a
    // huge or hostile file can't exhaust memory.
    const { size } = statSync(res.filePaths[0])
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(
        `Conversation file is too large (${Math.round(size / 1_000_000)} MB; max ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB).`
      )
    }
    const { data, textOnly } = parseConversationFile(readFileSync(res.filePaths[0], 'utf8'))
    const settings = getSettings()
    const conv = importConversation(data, {
      // Only honor the file's workspace if it's already a trusted (recents) dir;
      // otherwise an import must not widen the sandbox scope.
      workspace: resolveImportWorkspace(data.workspace, settings.recentWorkspaces),
      providerId: settings.selected?.providerId ?? '',
      model: settings.selected?.model ?? ''
    })
    const { messages: _messages, ...meta } = conv
    return { meta, textOnly }
  })

  // Agent: fire-and-forget; progress is streamed back over IPC.agentEvent.
  handle(IPC.agentStart, async (event, req: AgentSendRequest): Promise<AgentStartResult | void> => {
    const conv = getConversation(req.conversationId)
    if (!conv) {
      emitEvent(event.sender, req.conversationId, {
        runId: req.runId,
        type: 'error',
        message: 'Conversation not found.'
      })
      return
    }

    // Never a second run while one is already active for this conversation (their
    // log writes would interleave). Mid-run input is normally steered or queued by the
    // renderer, but a send can still race a run it didn't know about: the queued
    // follow-up main starts the moment a turn ends, or a run still being re-adopted.
    // Refusing that send used to drop the message (the bubble was never saved), so
    // queue it instead, and tell the renderer which run it's waiting on.
    const liveRunId = activeRunForConversation(conv.id)
    if (liveRunId) {
      const items = addToQueue({
        conversationId: conv.id,
        userText: req.userText,
        images: req.images,
        ...(req.invokedAs ? { invokedAs: req.invokedAs } : {}),
        providerId: req.providerId,
        model: req.model,
        approvalPolicy: req.approvalPolicy,
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {})
      })
      emitQueueChanged(event.sender, conv.id, items)
      return { queuedBehind: liveRunId }
    }
    // Likewise mid-rewind, before the message is appended to a log about to be replaced.
    if (rewindInProgress(conv.id)) {
      emitEvent(event.sender, conv.id, {
        runId: req.runId,
        type: 'error',
        message: 'This conversation is being rewound. Send again once it finishes.'
      })
      return
    }

    const images = sanitizeAttachments(req.images)
    const invokedAs = sanitizeInvocation(req.invokedAs)
    const userMessage: ChatMessage = {
      role: 'user',
      content: req.userText,
      ...(images.length ? { images } : {}),
      ...(invokedAs ? { invokedAs } : {}),
      // When it was sent, for the transcript's timestamp.
      at: new Date().toISOString()
    }
    // A resend of a message whose turn failed replaces it rather than repeating it.
    const messages = appendUserTurn(conv.messages, userMessage)
    // Validate the policy at the IPC boundary: an unknown value fails *open* downstream
    // (needsApproval auto-approves any non-'ask' policy; isBlockedByPlan stops guarding),
    // so coerce anything off the list to the most restrictive policy. Mirrors setRunPolicy.
    const approvalPolicy = isApprovalPolicy(req.approvalPolicy) ? req.approvalPolicy : 'plan'
    const reasoningEffort = isReasoningEffort(req.reasoningEffort) ? req.reasoningEffort : undefined
    // Record what this turn runs under as the chat's own settings.
    // The new message and those settings go to disk in one write.
    setMessages(conv.id, messages, {
      providerId: req.providerId,
      model: req.model,
      approvalPolicy,
      ...(reasoningEffort ? { reasoningEffort } : {})
    })
    // The model picker lists recently used models; best-effort, never blocks the run.
    try {
      rememberModel({ providerId: req.providerId, model: req.model })
    } catch (e) {
      log.warn(`could not record the recent model: ${(e as Error).message}`)
    }

    void runAndDrain(
      makeIo(event.sender),
      conv.id,
      {
        runId: req.runId,
        workspace: conv.workspace,
        providerId: req.providerId,
        model: req.model,
        approvalPolicy,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        messages
      },
      // Record the starting window so only it can approve/answer/cancel this run.
      event.sender.id
    )
  })

  // Re-run the last turn after a failure: run on the conversation's existing
  // messages (the user turn is already persisted) without appending a new one.
  handle(
    IPC.agentRetry,
    async (
      event,
      req: {
        runId: string
        conversationId: string
        providerId: string
        model: string
        approvalPolicy: AppSettings['approvalPolicy']
        reasoningEffort?: ReasoningEffort
      }
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
      const reasoningEffort = isReasoningEffort(req.reasoningEffort) ? req.reasoningEffort : undefined
      // Persist the (possibly switched) settings like agentStart does, so a retry after
      // changing provider isn't run under the new one while the conversation's stored
      // meta still names the old — which mis-attributes the turn in the scorecard.
      updateConversationMeta(conv.id, {
        providerId: req.providerId,
        model: req.model,
        approvalPolicy,
        ...(reasoningEffort ? { reasoningEffort } : {})
      })
      void runAndDrain(
        makeIo(event.sender),
        conv.id,
        {
          runId: req.runId,
          workspace: conv.workspace,
          providerId: req.providerId,
          model: req.model,
          approvalPolicy,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          messages: conv.messages
        },
        // Record the starting window so only it can approve/answer/cancel this run.
        event.sender.id
      )
    }
  )

  handle(IPC.agentCancel, (event, runId: string) => {
    // Only the window that started the run may cancel it (runIds are broadcast to all).
    if (!callerOwnsRun(event, runId)) return
    cancelRun(runId)
  })

  // Queued input: buffer messages typed mid-run, dispatched (combined) when the
  // conversation's run finishes naturally. The renderer updates its bar from the
  // returned list; main pushes IPC.agentQueueChanged when an auto-flush empties it.
  handle(IPC.agentQueueAdd, (_event, req: QueueAddRequest): QueuedInputMeta[] =>
    addToQueue(req)
  )
  // Removing a steer that hasn't landed takes it back from the live run as well, so
  // the chip's × means what it says.
  handle(IPC.agentQueueRemove, (_event, conversationId: string, id: string): QueuedInputMeta[] => {
    const runId = activeRunForConversation(conversationId)
    if (runId) unsteerRun(runId, id)
    return removeFromQueue(conversationId, id)
  })
  handle(IPC.agentQueueClear, (_event, conversationId: string): QueuedInputMeta[] => {
    const runId = activeRunForConversation(conversationId)
    if (runId) for (const id of queuedSteerIds(conversationId)) unsteerRun(runId, id)
    return clearQueue(conversationId)
  })
  handle(IPC.agentQueueList, (_event, conversationId: string): QueuedInputMeta[] =>
    listQueue(conversationId)
  )
  // Dispatch a conversation's queued messages immediately as one combined turn.
  // Used by the queue bar's "Send now" after Stop/error leaves items held (the
  // auto-flush only fires on a natural finish). No-op if a run is already active
  // for the conversation — that run's own natural finish will drain the queue.
  handle(IPC.agentQueueFlush, (event, conversationId: string): void => {
    if (activeRunForConversation(conversationId)) return
    drainQueue(makeIo(event.sender), conversationId, event.sender.id)
  })

  handle(
    IPC.agentApprove,
    (event, runId: string, callId: string, decision: ToolApprovalDecision, note?: unknown) => {
      // Validate at the boundary: an unknown decision must not reach the loop (where
      // it would be treated as a non-deny "approve" and silently run the call).
      if (!isToolApprovalDecision(decision)) return
      // Only the window that started the run may resolve its approval prompts.
      if (!callerOwnsRun(event, runId)) return
      // The note is free text from the renderer: trim + cap it here rather than
      // trusting the sender not to paste a novel into the model's context.
      resolveApproval(runId, callId, decision, sanitizeApprovalNote(note))
    }
  )

  // Deliver the user's answer to a pending ask_user question.
  handle(
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
  handle(
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
  handle(
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
  handle(
    IPC.agentSetPolicy,
    (event, runId: string, policy: AppSettings['approvalPolicy']) => {
      // Only the window that started the run may change its policy — otherwise any
      // window could silently escalate a live run to full-auto.
      if (!callerOwnsRun(event, runId)) return
      setRunPolicy(runId, policy)
    }
  )

  // Change the reasoning effort of an in-flight run, for its own chat only; the next
  // model turn uses it. Owner-gated like set-policy; setRunEffort ignores unknown values.
  handle(IPC.agentSetEffort, (event, runId: string, effort: ReasoningEffort) => {
    if (!callerOwnsRun(event, runId)) return
    setRunEffort(runId, effort)
  })

  // Start a propose_session card as its own background chat. The approval policy is
  // the user's current one, coerced at this boundary like a normal send (an unknown
  // value would fail open downstream).
  handle(
    IPC.proposalStart,
    async (_event, conversationId: unknown, callId: unknown, policy: unknown) => {
      if (typeof conversationId !== 'string' || typeof callId !== 'string' || callId.length > 200) {
        throw new Error('Invalid proposal.')
      }
      const { result, proposals } = await startProposal(
        { conversationId, callId, approvalPolicy: isApprovalPolicy(policy) ? policy : 'plan' },
        hostProposalDeps()
      )
      return { conversationId: result.conversationId, title: result.title, proposals }
    }
  )

  // Record "do it here" or "dismiss" on a proposal card.
  handle(
    IPC.proposalSetState,
    (_event, conversationId: unknown, callId: unknown, status: unknown) => {
      if (
        typeof conversationId !== 'string' ||
        typeof callId !== 'string' ||
        callId.length > 200 ||
        (status !== 'here' && status !== 'dismissed')
      ) {
        throw new Error('Invalid proposal decision.')
      }
      return decideProposal({ conversationId, callId, status }, hostProposalDeps())
    }
  )

  // Side chat: a read-only aside per conversation, stored with it. Every change is
  // broadcast (not sender-scoped): the same chat can be open in two windows, and an
  // answer keeps going after its panel closes, so any window may need to refetch.
  const broadcastSideChat = (conversationId: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.sideChatChanged, { conversationId })
    }
  }
  handle(
    IPC.sideChatAsk,
    async (_event, conversationId: unknown, question: unknown, providerId: unknown, model: unknown) => {
      if (
        typeof conversationId !== 'string' ||
        typeof question !== 'string' ||
        typeof providerId !== 'string' ||
        typeof model !== 'string'
      ) {
        throw new Error('Invalid side chat request.')
      }
      return askSideChat({ conversationId, question, providerId, model }, hostSideChatDeps(broadcastSideChat))
    }
  )
  handle(IPC.sideChatGet, (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') throw new Error('Invalid side chat request.')
    return sideChatView(conversationId, { getConversation })
  })
  handle(IPC.sideChatCancel, (_event, conversationId: unknown) => {
    if (typeof conversationId === 'string') cancelSideChat(conversationId)
  })
  handle(IPC.sideChatClear, (_event, conversationId: unknown) => {
    if (typeof conversationId === 'string') {
      clearSideChat(conversationId, { saveSideChat, onChange: broadcastSideChat })
    }
  })

  // A message typed while the conversation's run is going: steer it into that run
  // (the model reads it before its next step), else queue it for after the run.
  // Decided here, in one synchronous step against the live run registry, because a
  // renderer that steered first and queued on refusal raced the run's end: the
  // fallback reached the queue after the finished run had already drained it, and
  // sat there unsent. `idle` means no run is live, so the caller sends a turn.
  //
  // Steering is a run-control call like the others, gated on run ownership so
  // another window can't push text into this run's context; that window's message is
  // queued instead. Either way the message is in the queue, on disk, before this
  // returns: a steer's entry is its durable copy until the run reads it (see
  // QueuedInput.steer). A steer is text only, so one with images is queued.
  handle(IPC.agentSteer, (event, req: QueueAddRequest): SteerOutcome => {
    if (!req || typeof req.conversationId !== 'string' || typeof req.userText !== 'string') {
      throw new Error('Invalid steer request.')
    }
    const runId = activeRunForConversation(req.conversationId)
    if (!runId) return { status: 'idle' }
    if (!req.images?.length && callerOwnsRun(event, runId)) {
      const id = randomUUID()
      if (steerRun(runId, req.userText, id)) {
        return { status: 'steered', items: addToQueue(req, { id, steer: true }) }
      }
    }
    return { status: 'queued', items: addToQueue(req) }
  })

  // The runId of the live run for a conversation, or null. The renderer queries
  // this when re-opening a conversation so it can re-adopt a still-running run
  // (show Stop, reconnect events/approvals) instead of starting a second one.
  handle(IPC.agentActiveRun, (_event, conversationId: string): string | null =>
    activeRunForConversation(conversationId)
  )

  // The prompts (approvals/questions) currently blocking the conversation's live
  // run. The renderer replays these right after re-adopting, so a prompt that was
  // awaiting the user when the transcript was last rebuilt re-renders its UI
  // instead of leaving the run wedged behind a spinner with no way to answer it.
  handle(IPC.agentPendingPrompts, (_event, conversationId: string): AgentEvent[] =>
    pendingPromptsForConversation(conversationId)
  )

  // The in-flight turn's streamed output not yet written to disk (assistant text
  // mid-stream, running tools). The renderer replays this right after re-adopting so
  // a mid-turn re-open doesn't show an empty transcript — most visibly on a freshly
  // spawned session opened to watch its first turn stream. Empty if no live run.
  handle(IPC.agentLiveTranscript, (_event, conversationId: string): AgentEvent[] => {
    // The replay holds every delta the loop has emitted, including any still being
    // gathered for the windows: send those first, or the window that replays this and
    // then receives them would show that text twice.
    flushAllDeltas()
    return liveTranscriptForConversation(conversationId)
  })

  // Unread marks persist in userData; entries for chats deleted while the app was
  // closed (or by another process) are pruned on startup.
  const readState = new ReadStateStore(join(getUserDataDir(), 'read-state.json'))
  readState.prune(conversationExists)
  const chat = createChatAttention({
    store: readState,
    liveStatus: chatStatusSnapshot,
    activeRun: activeRunForConversation,
    messageCount: (id) => peekConversation(id)?.messages.length,
    replyIndexes: (id) => replyMessageIndexes(peekConversation(id)?.messages ?? []),
    exists: conversationExists,
    // Broadcast (not sender-scoped): a run can block or finish while a different
    // window is focused, and every window's sidebar shows every chat.
    broadcast: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send(IPC.chatStatusChanged, status)
      }
      updateAppBadge(status)
    }
  })
  attention = chat
  // Unread marks come back from disk on launch; show them on the app icon now rather
  // than waiting for the first status change.
  updateAppBadge(chat.snapshot())

  // The status of every chat with something to show (a live run, its blocking
  // prompts, or an unread mark), for the sidebar's per-chat signal. The renderer reads
  // this once on load, then follows the IPC.chatStatusChanged broadcast.
  handle(IPC.chatStatusList, (): ChatStatusMap => chat.snapshot())
  onChatStatusChanged((live) => chat.onLiveChanged(live))

  // The chat a window showed last, reopened at launch. A window's views are only
  // remembered once it has asked for its launch chat: before that it reports the new
  // chat it starts on, which would forget the chat it is about to reopen.
  const lastChat = new LastChatStore(join(getUserDataDir(), 'last-chat.json'))
  const launchedIds = new Set<number>()
  handle(IPC.chatLaunch, (event): string | null => {
    launchedIds.add(event.sender.id)
    // A window opened for a particular chat (or a new one) starts there; the launch
    // window reopens the last chat.
    const requested = takeLaunchRequest(event.sender.id)
    if (requested) {
      const id = requested.conversationId
      return id && conversationExists(id) ? id : null
    }
    return launchChat(lastChat.get(), (id) => peekConversation(id)?.workspace, isDirectory)
  })
  // File > New Window and a chat's "Open in New Window": a new chat window, on that
  // chat (null: a new chat). Only an existing chat id is accepted.
  handle(IPC.windowOpenChat, (event, conversationId: unknown): void => {
    if (conversationId !== null && (typeof conversationId !== 'string' || !conversationExists(conversationId))) return
    openChatWindow(conversationId, BrowserWindow.fromWebContents(event.sender))
  })

  // Each window says which chat it shows and whether it has focus; a focused view
  // marks the chat read. A closed window stops counting as a viewer.
  const viewerIds = new Set<number>()
  on(IPC.chatViewing, (event, conversationId: unknown, focused: unknown) => {
    const id = event.sender.id
    if (!viewerIds.has(id)) {
      viewerIds.add(id)
      event.sender.once('destroyed', () => {
        viewerIds.delete(id)
        launchedIds.delete(id)
        chat.dropViewer(id)
      })
    }
    const viewing = typeof conversationId === 'string' ? conversationId : null
    chat.setViewing(id, viewing, focused === true)
    setWindowShowing(id, viewing)
    if (launchedIds.has(id) && (viewing === null || conversationExists(viewing))) lastChat.set(viewing)
  })
  // "Mark unread from here" names a reply by its position among the transcript's
  // replies (the renderer has no message log); it's resolved to a log index here.
  handle(IPC.chatSetUnread, (_event, conversationId: unknown, unread: unknown, fromReply: unknown) => {
    if (typeof conversationId !== 'string') return
    if (unread === true && typeof fromReply === 'number' && Number.isInteger(fromReply) && fromReply >= 0) {
      chat.setUnreadFromReply(conversationId, fromReply)
    } else {
      chat.setUnread(conversationId, unread === true)
    }
  })
  handle(IPC.chatMarkAllRead, () => chat.markAllRead())

  // The background shells (run_shell background mode) for the tasks indicator —
  // queried once on load, then kept current via the shellsChanged broadcast.
  handle(IPC.shellList, () => listShells())

  // The Tasks panel's Stop button and output tail. Ids are the registry's 8-hex
  // keys; anything else is refused before it reaches the registry. Stopping only
  // ever signals a process group Houston itself spawned for a background shell.
  const validShellId = (id: unknown): id is string =>
    typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)
  handle(IPC.shellStop, (_e, id: unknown) => (validShellId(id) ? killShell(id) : 'not-found'))
  handle(IPC.shellTail, (_e, id: unknown) => (validShellId(id) ? (shellTail(id) ?? null) : null))

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
  handle(IPC.checkpointRestore, async (_event, runId: string): Promise<number> =>
    (await checkpointCallAllowed(runId)) ? restoreCheckpoint(runId) : 0
  )

  // Re-apply a reverted run's file changes (restore each touched file to its post-turn state).
  handle(IPC.checkpointReapply, async (_event, runId: string): Promise<number> =>
    (await checkpointCallAllowed(runId)) ? reapplyCheckpoint(runId) : 0
  )

  // The revertable checkpoint for a conversation's latest run (or null). The renderer
  // fetches this when re-opening a conversation so the revert/redo affordance — built
  // only from live events otherwise — survives a transcript rebuild, and (via the
  // on-disk fallback) an app restart.
  handle(
    IPC.checkpointGet,
    (
      _event,
      conversationId: string
    ): Promise<{ runId: string; files: number; reverted: boolean } | null> =>
      getConversationCheckpoint(conversationId)
  )

  // ---- Rewind to an earlier message (see agent/rewind.ts) ----

  // Validated here, at the boundary: the turn is a small non-negative integer, the
  // mode one of three, and the text a bounded string. The text is never trusted for
  // anything but the staleness check (it must equal the stored message's text), and
  // the conversation id is checked by the store before it becomes a filename. There
  // is no window to own the call (a rewind runs only when no run does); the guard
  // that matters, refusing while the conversation has a live run, is in rewind.ts.
  const validRewindArgs = (
    conversationId: unknown,
    turn: unknown,
    mode: unknown,
    text: unknown
  ): boolean =>
    typeof conversationId === 'string' &&
    Number.isSafeInteger(turn) &&
    (turn as number) >= 0 &&
    (turn as number) < 100_000 &&
    isRewindMode(mode) &&
    typeof text === 'string' &&
    text.length <= MAX_REWIND_TEXT
  const INVALID_REWIND = { ok: false as const, error: 'Invalid rewind request.' }

  handle(
    IPC.rewindPreview,
    async (_event, conversationId: unknown, turn: unknown, mode: unknown, text: unknown): Promise<RewindPreviewResult> =>
      validRewindArgs(conversationId, turn, mode, text)
        ? previewRewind(conversationId as string, turn as number, mode as RewindMode, text as string)
        : INVALID_REWIND
  )
  handle(
    IPC.rewindApply,
    async (_event, conversationId: unknown, turn: unknown, mode: unknown, text: unknown): Promise<RewindResult> =>
      validRewindArgs(conversationId, turn, mode, text)
        ? rewindConversation(conversationId as string, turn as number, mode as RewindMode, text as string)
        : INVALID_REWIND
  )
  handle(IPC.rewindUndo, async (_event, conversationId: unknown): Promise<UndoRewindResult> =>
    typeof conversationId === 'string' ? undoRewind(conversationId) : INVALID_REWIND
  )
  handle(IPC.rewindCanUndo, (_event, conversationId: unknown): boolean =>
    typeof conversationId === 'string' ? canUndoRewind(conversationId) : false
  )

  // ---- Integrated terminal (PTY-backed) ----

  // Spawn a terminal; output/exit are pushed back to the creating webContents.
  handle(
    IPC.terminalCreate,
    (event, opts: { cwd?: string; cols?: number; rows?: number }): string => {
      watchTerminalHost(event.sender)
      return createTerminal(event.sender, opts ?? {})
    }
  )
  handle(IPC.terminalInput, (_event, id: string, data: string) => writeTerminal(id, data))
  handle(IPC.terminalResize, (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  handle(IPC.terminalKill, (_event, id: string): boolean => killTerminal(id))
  // Fire-and-forget focus signal so the ⌘W menu handler knows whether to close
  // the active terminal tab or the window.
  on(IPC.terminalFocusChanged, (_event, focused: boolean) => setTerminalFocused(focused))
  on(IPC.menuState, (_event, state: MenuState) => setMenuState(state))

  // ---- Live preview dock (started dev servers) ----

  handle(IPC.previewListServers, (): PreviewServer[] => listPreviewServers())
  // Reconcile the native preview views to the renderer-measured rectangles. A
  // fire-and-forget send: it runs on every dock resize / overlay toggle, so it
  // must stay cheap and never block the renderer.
  on(IPC.previewSync, (event, specs: PreviewPaneSpec[], visible: boolean) =>
    syncPreviewPanes(BrowserWindow.fromWebContents(event.sender), specs, visible)
  )
  on(IPC.previewReload, (event, id: string) =>
    reloadPreviewPane(BrowserWindow.fromWebContents(event.sender), id)
  )
  // Open a preview's URL in the OS browser — user-initiated, but re-validate
  // loopback-only so a stale/spoofed URL can't turn this into an open-redirect.
  handle(IPC.previewOpenExternal, async (_event, url: string): Promise<void> => {
    assertLoopbackUrl(url)
    await shell.openExternal(url)
  })
}

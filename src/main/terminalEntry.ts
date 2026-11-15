import { createHash } from 'node:crypto'
import { clearChildReportFlag, setWakeHost, takeBackgroundEvents, wakeNote } from './agent/backgroundEvents'
import { getMcpRegistryServer, searchMcpRegistry } from './mcpRegistry'
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { isatty } from 'node:tty'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { McpServerConfig } from '@shared/types'
import {
  isSupportedImageType,
  exceedsImageSizeLimit,
  SUPPORTED_IMAGE_TYPES
} from '@shared/images'
import {
  startRun,
  steerRun,
  unsteerRun,
  resolveApproval,
  resolveQuestion,
  resolvePlan,
  resolveElicitation,
  cancelRun,
  setRunPolicy,
  setRunEffort,
  cancelAllRuns,
  waitForRunsToEnd
} from './agent/loop'
import { createDraftStore } from './tui-drafts'
import { killAllShells, killShell, listShells, shellTail } from './agent/shells'
import { stopSubagent } from './agent/subagentStops'
import { lspManager } from './agent/lsp/manager'
import { flushRuleUsage, getRuleUsage } from './ruleUsage'
import { describePermissionPolicy, defaultPolicyDeps } from './permissionPolicy'
import { installSignalCleanup, type CleanupSignal, type SignalCleanup, type SignalProcess } from './signalCleanup'
import { disconnectAllMcp, getMcpStatuses, reconnectMcpServers } from './mcp/manager'
import { openWithSystemHandler, runMcpOAuthFlow } from './mcp/oauth'
import { canStoreMcpOAuth, collectSecrets, setMcpOAuth } from './agentHost'
import { activeBackendId, isSandboxed } from './sandbox'
import { resolveEgressMode } from '@shared/egress'
import { ISSUES_URL, issueReportBody, issueReportUrl } from '@shared/issueReport'
import { overrideForConversation } from './agent/overrides'
import { loadManagedPolicy, resolveManagedPolicyPath } from './agent/managedPolicy'
import { redactSecrets } from './agent/redact'
import type { AgentEvent, ConversationMeta } from '@shared/agent'
import { setSpawnBackend } from './agent/spawn'
import { setSchedulerBackend } from './agent/scheduler'
import { createSpawnBackend } from './spawnSession'
import { createSchedulerService, fireViaSpawn, schedulesFilePath, type SchedulerService } from './schedulerService'
import { appSchedulerRunning, daemonPidPath, holdPidFile } from './scheduleDaemon'
import { createWorktree, removeWorktree } from './agent/worktree'
import { readFlagFile, resolveSessionInputs } from './sessionFlags'
import {
  conversationWorktree,
  createSessionWorktree,
  finishSessionWorktree,
  comeBackCommand,
  resumeWorktreeFolder,
  type SessionWorktree
} from './sessionWorktree'
import { decideProposal, hostProposalDeps, proposalsIn, startProposal } from './proposals'
import { askSideChat, cancelSideChat, clearSideChat, hostSideChatDeps } from './sideChat'
import { findFiles } from './agent/mentions'
import { loadSkills } from './agent/skills'
import { runUserShell } from './userShell'
import { loadAgents } from './agent/agents'
import { loadSlashCommands } from './agent/commands'
import { deleteChat, planChatDelete, stopAndDeleteConversation } from './deleteChat'
import { compactConversationNow } from './agent/compact'
import {
  getConversationCheckpoint,
  restoreCheckpoint,
  reapplyCheckpoint
} from './agent/checkpoints'
import { previewRewind, rewindConversation, undoRewind } from './agent/rewind'
import { collectWorkingTreeChanges } from './agent/workingTree'
import { branchSyncFor, commitAll, lookupPr, pushBranch, suggestCommitMessage } from './agent/gitActions'
import { YIELDS_TO_CUSTOM } from './tui-git'
import { listModels } from './providers'
import { runGitCapture } from './agent/gitRead'
import { readHeadBranch } from './headBranch'
import { writeExportFile } from './tui-sessions'
import {
  canPersistHeaderSecrets,
  canSetKey,
  folderTrustFor,
  getSettings,
  setProviderKey,
  updateSettings
} from './store'
import { getUserDataDir } from './userData'
import { ReadStateStore } from './readState'
import { log } from './logger'
import {
  runTui,
  makePainter,
  resolveTheme,
  mediaTypeForImagePath,
  type BackgroundSession,
  type ResumeEntry,
  type TuiIo,
  type TuiOptions
} from './tui'
import { detectTerminalBackground } from './tui-background'
import type { DoctorFacts } from './tui-doctor'
import { gatherDoctorFacts } from './doctor'
import { saveMemory } from './memory'
import { memoryStore } from './agent/memoryStore'
import { legacyRulesNoticeApplies } from './globalRules'
import { takeLegacyRulesTerminalNotice } from './legacyRulesNotice'
import {
  checkForUpdate,
  formatHeadlessUpdateNotice,
  headlessUpdateNoticeAllowed,
  type UpdateAvailable
} from './update-check'
import { currentInstallMethod, upgradeHint } from './install-method'

/** The interactive update check runs alongside the session, so it can wait longer than -p's. */
const INTERACTIVE_UPDATE_TIMEOUT_MS = 10_000
import { readClipboardImage, noClipboardHint } from './clipboard-image'
import { writeClipboardText } from './clipboard-text'
import {
  HEADLESS_SIGNAL_EXIT,
  HEADLESS_SIGNALS,
  runHeadless,
  type HeadlessOptions,
  type HeadlessSignal
} from './headless'
import { serveAcp, type AcpLaunchOptions } from './acp'
import { createTerminalIo, resolveColor } from './tui-io'
import { resolveAccessibility } from './tui-a11y'
import {
  makeCompleter,
  commandMenu,
  renderCommandMenu,
  makeMentionMenu,
  COMMANDS,
  type CommandSpec
} from './tui-complete'
import { mergeCommands } from '@shared/commands'
import { runOutcome, runOutcomePhrase } from '@shared/runEnd'
import { parseHistory, serializeHistory, appendHistory } from './tui-history'
import { highlightToHtml, type HljsLike } from './syntax'
import { filterTerminalOutput, stripControlChars } from './tui-wrap'
import {
  createConversation,
  setMessages,
  updateConversationMeta,
  setConversationSettings,
  listConversations,
  getConversation,
  conversationRunOutcome,
  peekConversation,
  searchConversations,
  forkConversation,
  organizeConversation,
  conversationExists,
  detachConversationWorktree,
  setGeneratedTitle,
  reportChildToParent,
  takeChildReports,
  saveSideChat,
  computeUsageReport
} from './conversations'

/** Resume-picker rows, each marked with the desktop app's unread state for it. */
function withUnread(convs: { id: string; title: string; updatedAt: number; workspace?: string }[]): ResumeEntry[] {
  const unread = new ReadStateStore(join(getUserDataDir(), 'read-state.json')).snapshot()
  return convs.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    ...(c.workspace ? { workspace: c.workspace } : {}),
    ...(unread[c.id] ? { unread: unread[c.id].outcome } : {})
  }))
}

/** How many chats the resume picker lists: per folder, and across every folder. */
const RESUME_LIMIT = 20
const RESUME_ALL_LIMIT = 50

/** Newest first, `limit` at most, with the desktop's unread state. */
function resumeEntries(convs: ConversationMeta[], limit: number): ResumeEntry[] {
  return withUnread([...convs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit))
}

/**
 * Terminal-facing entry points — the full wiring of the interactive TUI (`-i`)
 * and one-shot headless (`-p`) clients onto the shared agent core, settings
 * store, and conversation persistence. Everything here is Electron-free: the
 * desktop app calls these from inside `app.whenReady()` (index.ts) and the
 * standalone CLI calls them directly (src/cli/run.ts), each after wiring the
 * userData seam and host credentials for its environment. Extracted from
 * index.ts so the two hosts can't drift apart.
 *
 * Both entries return the process exit code rather than exiting, since the two
 * hosts exit differently (`app.exit` vs `process.exit`), and both tear down the
 * agent's background shells, MCP connections, and language servers before returning
 * (or, on a signal, before exiting: see {@link guardTerminalExit}).
 */

/** What a terminal host hands its entry, beyond the shared wiring. */
export interface TerminalHost {
  version?: string
  /**
   * Anything the host must write before the process ends (the desktop app's pending
   * credential writes). Run only on the signal path, which never returns to the host's
   * own exit step; a normal exit leaves it to the host.
   */
  flush?: () => Promise<unknown>
  /**
   * Start-up work the host put off so it doesn't delay the interactive client's first
   * paint (the CLI's read of the system certificate store). Run once, right after the
   * first prompt is drawn.
   */
  afterFirstPrompt?: () => void
}

/**
 * `io` that runs `afterFirstPrompt` once, on the turn of the event loop after its first
 * composer read starts. That read draws the prompt before it returns, so work moved here
 * lands just after the first paint instead of ahead of it.
 */
export function onFirstPrompt<T extends Pick<TuiIo, 'readComposer'>>(io: T, afterFirstPrompt: () => void): T {
  const read = io.readComposer
  if (!read) return io
  let fired = false
  return {
    ...io,
    readComposer: (...args: Parameters<NonNullable<TuiIo['readComposer']>>) => {
      const reading = read(...args)
      if (!fired) {
        fired = true
        setImmediate(afterFirstPrompt)
      }
      return reading
    }
  }
}

/** Longest an exit waits for cancelled runs to unwind (recording why they stopped). */
export const RUN_STOP_GRACE_MS = 2_000

/**
 * Cancel whatever runs are still live (a signal arrived mid-turn, or background
 * sessions were abandoned) and give them a moment to unwind, so each records that it
 * was aborted instead of vanishing mid-step when the process exits.
 */
export async function stopLiveRuns(graceMs = RUN_STOP_GRACE_MS): Promise<void> {
  if (cancelAllRuns() > 0) await waitForRunsToEnd(graceMs)
}

/**
 * Tear down what a terminal client started, once, on a normal exit or a signal
 * (SIGHUP when the terminal closes, SIGTERM from `kill`, `timeout`, or an editor
 * stopping `--acp`, SIGINT for the clients that don't read Ctrl-C themselves). Each
 * entry's `finally` awaits `run()` and then disposes the listeners; a signal runs the
 * same cleanup and exits with `128 + n`. Background shells lead their own process
 * groups, so without this they never see the hangup and keep their ports.
 */
export function guardTerminalExit(
  signals: CleanupSignal[],
  host: Pick<TerminalHost, 'flush'> = {},
  proc?: SignalProcess
): SignalCleanup {
  return installSignalCleanup(
    async () => {
      await stopLiveRuns()
      killAllShells()
      disconnectAllMcp()
      await lspManager.stopAll()
    },
    {
      signals,
      // What the host's own exit step does after the entry returns, which a signal skips.
      beforeSignalExit: async () => {
        flushRuleUsage()
        await host.flush?.()
      },
      ...(proc ? { proc } : {}),
      onSignal: (sig) => log.info(`received ${sig}; stopping background shells and servers before exiting`)
    }
  )
}

/**
 * True when stdin carries data piped or redirected in (a pipe, a socket, or a
 * file) rather than a terminal or an empty device such as /dev/null, which is
 * what a GUI launch or a CI step with no input gets. Decides whether a headless
 * run with no prompt reads one from stdin. Reads only file-descriptor metadata,
 * so it never consumes input or blocks.
 */
export function stdinIsPiped(): boolean {
  if (isatty(0)) return false
  try {
    const st = fstatSync(0)
    return st.isFIFO() || st.isFile() || st.isSocket()
  } catch {
    return false
  }
}

/** Read all of stdin as UTF-8 (a piped prompt, or a key piped into `providers set-key`). */
export function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/**
 * The lines of stdin as they arrive (`--input-format stream-json`). Lines that come
 * in while a turn runs wait in the stream until the next turn asks for them.
 */
export async function* readStdinLines(): AsyncIterable<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) yield line
}

/** Read a file, returning null if it doesn't exist / can't be read. */
function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Open `initial` in the user's `$VISUAL`/`$EDITOR` and return the saved text — the
 * "edit the plan" action of plan review, and the composer's Ctrl-X Ctrl-E draft
 * hand-off. Returns null when no editor is configured or it exits non-zero
 * (aborted), so the caller falls back. Blocking (spawnSync) on purpose: the TUI is
 * idle waiting for the decision, and a terminal editor owns the screen while open.
 * Best-effort — a user without $EDITOR can use "suggest" / keep typing.
 */
async function editInEditor(initial: string, filename = 'PLAN.md'): Promise<string | null> {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return null
  const dir = mkdtempSync(join(tmpdir(), 'houston-edit-'))
  const file = join(dir, filename)
  try {
    // Owner-only: a draft or a transcript can hold anything pasted into the chat.
    writeFileSync(file, initial, { encoding: 'utf8', mode: 0o600 })
    const [cmd, ...args] = editor.split(/\s+/)
    const res = spawnSync(cmd, [...args, file], { stdio: 'inherit' })
    if (res.error || res.status !== 0) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Non-interactive resolution for a background session's blocking events — the
 * terminal hosts' counterpart of the GUI's approval cards and the foreground
 * TUI prompts, so a background run can never hang on a question nobody sees.
 * Approvals are DECLINED (never silently granted — the session already inherits
 * its parent's approval policy, so a full-auto parent still gets an autonomous
 * child), `ask_user` gets a "use your best judgment" answer, and a presented
 * plan is rejected. Exported for the blocking-interaction parity tests.
 */
export function resolveBackgroundEvent(
  e: AgentEvent,
  r: {
    resolveApproval: typeof resolveApproval
    resolveQuestion: typeof resolveQuestion
    resolvePlan: typeof resolvePlan
    resolveElicitation: typeof resolveElicitation
  }
): void {
  switch (e.type) {
    case 'tool_approval':
      r.resolveApproval(e.runId, e.callId, 'deny')
      break
    case 'tool_question':
      r.resolveQuestion(
        e.runId,
        e.callId,
        '[No interactive user is available for this background session. Proceed using your best judgment.]'
      )
      break
    case 'plan_ready':
      r.resolvePlan(e.runId, e.callId, { kind: 'reject' })
      break
    case 'elicitation':
      // An MCP server asked for input nobody can give — decline, never fabricate.
      r.resolveElicitation(e.runId, e.elicitId, { action: 'decline' })
      break
    default:
      break // nothing renders in the background; the conversation persists via onMessages
  }
}

/**
 * Wire `spawn_session` + the scheduler for a terminal host, so both work beyond
 * the desktop app. A spawned (or scheduled) session is a real persisted
 * conversation with a background run in THIS process — but a terminal host has
 * no window to answer its prompts, so the run resolves them non-interactively
 * and safely: approvals are DECLINED (never silently granted — the session
 * inherits the parent policy, so a full-auto parent still gets an autonomous
 * child), `ask_user` is answered with "use your best judgment", and a presented
 * plan is rejected. The conversation persists throughout, so the user can open
 * it afterwards with `/resume` (TUI) or `--resume <id>` (headless).
 *
 * Returns a handle for the headless entry, which must wait for still-running
 * background sessions before the one-shot process exits (the TUI is long-lived
 * and needs no wait; its `notify` prints a line when a session settles).
 */
export function wireTerminalSessionBackends(opts: {
  /** Surface a background session's completion (TUI prints a dim line; headless stderr). */
  notify?: (message: string) => void
  /** Start the scheduler's timers (TUI). The headless one-shot manages schedules without firing them. */
  startScheduler: boolean
  /** Whether the scheduler may fire now (the daemon defers to the open desktop app). Absent: always. */
  shouldFire?: () => boolean
}): {
  /** The scheduler this host wired (the daemon stops it on exit). */
  scheduler: SchedulerService
  pendingBackgroundSessions: () => number
  waitForBackgroundSessions: () => Promise<void>
  /**
   * The background sessions spawned this session, running ones first. The set was
   * always tracked (to bound the fan-out); it was just never exposed, so a
   * terminal user could start parallel work and then had no way to see it.
   */
  backgroundSessions: () => BackgroundSession[]
} {
  // Live spawned runs → whether each counts toward the agent's concurrency cap.
  const liveSpawnedRuns = new Map<string, boolean>()
  // Everything spawned this session, so a finished one is still listable (and
  // openable) rather than vanishing the moment its run ends.
  const spawned: { id: string; startedAt: number }[] = []
  const pending = new Set<Promise<void>>()

  const backgroundSend = (e: AgentEvent): void =>
    resolveBackgroundEvent(e, { resolveApproval, resolveQuestion, resolvePlan, resolveElicitation })

  const backend = createSpawnBackend({
    createWorktree,
    createConversation,
    seedMessages: setMessages,
    setTitle: (id, title) => {
      setGeneratedTitle(id, title)
    },
    getTitle: (id) => peekConversation(id)?.title,
    // Terminal hosts keep no recent-workspace list (that's the GUI's welcome screen).
    rememberWorkspace: () => {},
    liveSpawnCount: () => [...liveSpawnedRuns.values()].filter(Boolean).length,
    removeWorktree: (wt) => removeWorktree(wt),
    startBackgroundRun: (conversationId, req, { countsTowardCap }) => {
      liveSpawnedRuns.set(conversationId, countsTowardCap)
      spawned.push({ id: conversationId, startedAt: Date.now() })
      const run = startRun(req, backgroundSend, (m) => setMessages(conversationId, m))
        .catch((e) => {
          log.warn(`background session ${conversationId} failed: ${String(e)}`)
        })
        .finally(() => {
          liveSpawnedRuns.delete(conversationId)
          const conv = getConversation(conversationId)
          const title = conv?.title ?? conversationId
          // How it ended, from the record its run left (a stall, a limit, a stop, an
          // error): "finished" for every one of them hid that the work was not done.
          const how = conv ? runOutcomePhrase(runOutcome(conv.messages, conv.lastError)) : 'ended'
          opts.notify?.(`background session "${title}" ${how}. Resume it to see the result (id ${conversationId})`)
        })
      pending.add(run)
      void run.finally(() => pending.delete(run))
      return run
    },
    reportToParent: reportChildToParent
  })
  setSpawnBackend({
    // Terminal hosts run spawned sessions non-interactively; say so in the tool
    // result instead of the desktop's "answer an approval" affordance.
    spawn: async (input) => ({
      ...(await backend.spawn(input)),
      note:
        'In this terminal host the session runs non-interactively: anything needing an approval is declined automatically (it inherits your approval policy). Resume the conversation later to see its result.'
    })
  })

  const scheduler = createSchedulerService({
    file: schedulesFilePath(),
    fire: fireViaSpawn(conversationRunOutcome, () => getSettings().approvalPolicy ?? 'ask'),
    ...(opts.shouldFire ? { shouldFire: opts.shouldFire } : {})
  })
  setSchedulerBackend(scheduler)
  if (opts.startScheduler) scheduler.start()

  return {
    scheduler,
    pendingBackgroundSessions: () => pending.size,
    waitForBackgroundSessions: async (): Promise<void> => {
      // Settle everything, including sessions spawned by sessions while we wait.
      while (pending.size > 0) await Promise.all([...pending])
    },
    backgroundSessions: () =>
      spawned.map((s) => {
        const conv = getConversation(s.id)
        const running = liveSpawnedRuns.has(s.id)
        const end = !running && conv ? runOutcome(conv.messages, conv.lastError) : undefined
        return {
          id: s.id,
          title: conv?.title ?? '(untitled)',
          running,
          startedAt: s.startedAt,
          ...(end ? { outcome: end.outcome, ...(end.limit ? { limit: end.limit } : {}) } : {}),
          // The worktree is the point of a fan-out: it says which branch this
          // session is actually working on.
          ...(conv?.worktree?.branch ? { branch: conv.worktree.branch } : {})
        }
      })
  }
}

/** How long the setup menu waits for a host to list its models. */
const HOST_PROBE_MS = 2500

/** Reject with a timeout when `p` takes longer than `ms`; a late result is dropped. */
/**
 * The terminal's side chat (`/btw`): ask, start over, and stop an answer in flight,
 * which Ctrl-C or Esc does while one is pending (the answer is stored as stopped).
 */
export function terminalSideChat(): {
  ask: (input: Parameters<typeof askSideChat>[0]) => ReturnType<typeof askSideChat>
  clear: (conversationId: string) => void
  cancel: (conversationId: string) => void
} {
  return {
    ask: (input) => askSideChat(input, hostSideChatDeps()),
    clear: (conversationId) => clearSideChat(conversationId, { saveSideChat }),
    cancel: (conversationId) => cancelSideChat(conversationId)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {}) // a late rejection after the timeout won the race is not an error
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/**
 * Probe the environment for `/doctor` and `houston doctor`. The shared gatherer collects
 * the facts common to every client; the terminal adds how this copy was installed and
 * its own `terminal` group (tty, color, width), which the desktop app has no analogue for.
 */
export function terminalDoctorFacts(
  cwd: string,
  version: string,
  color: boolean,
  update: { latest: string; url: string; hint?: string } | null
): DoctorFacts {
  const method = currentInstallMethod()
  return {
    ...gatherDoctorFacts(cwd, { version, update }),
    install: { method, upgrade: upgradeHint(method).fix },
    terminal: {
      tty: Boolean(process.stdin.isTTY),
      color,
      columns: process.stdout.columns || 80,
      term: process.env.TERM ?? ''
    }
  }
}

/**
 * Run the interactive terminal client to completion. Returns the exit code.
 *
 * `version` is supplied by the host (the CLI bundle has it defined at build time,
 * the desktop app gets it from Electron), since this module is shared by both and
 * neither can read the other's source of truth.
 */
export async function runTuiEntry(tui: TuiOptions, host: TerminalHost = {}): Promise<number> {
  // Interactive mode needs a real terminal for the composer and inline
  // approval prompts. In a pipe/CI there's no TTY to read from — point the
  // user at headless (`-p`) rather than hanging on a dead stdin.
  if (!process.stdin.isTTY) {
    process.stderr.write('Interactive mode (-i) needs a terminal. In a pipe, use `-p "<prompt>"`.\n')
    return 2
  }
  // The launch flags that name files, tools or folders are read and checked before
  // the session starts, as a one-shot run does: a missing file is a usage error, not
  // a session that quietly runs without it. A bad flag value is runTui's to report.
  if (!tui.usageError) {
    const inputs = await resolveSessionInputs(tui, { readFile: readFlagFile })
    if ('error' in inputs) {
      process.stderr.write(`${inputs.error}\n`)
      return 2
    }
    tui.sessionInputs = inputs
  }
  // -w: the session runs in a fresh worktree, created before anything reads the
  // folder (history, commands, trust). --resume of a worktree chat opens its worktree.
  let sessionWt: SessionWorktree | null = null
  if (!tui.usageError) {
    const wt = await startInWorktree(tui)
    if (typeof wt === 'number') return wt
    sessionWt = wt
  }
  // Colorize only when the environment says so (TTY, NO_COLOR, TERM, FORCE_COLOR).
  tui.color = resolveColor(process.env, Boolean(process.stdout.isTTY))
  // Screen-reader mode (--screen-reader, HOUSTON_SCREEN_READER, the saved setting) and
  // reduced motion (HOUSTON_REDUCE_MOTION, the saved setting, or implied by the first).
  const a11y = resolveAccessibility({ screenReader: tui.screenReader }, process.env, getSettings())
  tui.screenReader = a11y.screenReader
  tui.reduceMotion = a11y.reduceMotion
  // Load highlight.js lazily (dynamic import) so it stays out of the module graph
  // that index.test.ts loads — only the real interactive path pulls it in.
  // `./syntax` itself carries no heavy deps (highlight.js is injected below), so
  // it's imported statically at the top; the dynamic wrapper bought no chunk split.
  // Loaded once the first prompt is drawn, not before it: nothing is highlighted
  // until a reply, plan or write preview arrives, and a bundled import finishes in the
  // same turn of the event loop it starts in, ahead of any keystroke or reply.
  let hljs: HljsLike | null = null
  const loadHighlighter = (): void => {
    import('highlight.js/lib/common').then(
      (m) => {
        hljs = m.default
      },
      (e) => log.warn(`syntax highlighting unavailable: ${String(e)}`)
    )
  }

  // Per-workspace composer history (Up/Down recall across restarts). Keyed by a
  // hash of the cwd so each project keeps its own history under userData.
  const histDir = join(getUserDataDir(), 'tui-history')
  const histFile = join(histDir, `${createHash('sha1').update(tui.cwd).digest('hex').slice(0, 16)}.txt`)
  let history = parseHistory(safeRead(histFile))
  const persistHistory = (line: string): void => {
    history = appendHistory(line, history)
    try {
      mkdirSync(histDir, { recursive: true })
      // Write-then-rename so a concurrent session (or a crash mid-write) can't leave
      // a truncated/interleaved history file — rename is atomic on the same filesystem.
      const tmp = `${histFile}.${process.pid}.tmp`
      writeFileSync(tmp, serializeHistory(history), { mode: 0o600 })
      renameSync(tmp, histFile)
    } catch (e) {
      log.warn(`failed to persist TUI history: ${String(e)}`)
    }
  }

  const version = host.version ?? 'dev'
  // Remembered from the background update check so /doctor can report it without
  // a second network round trip.
  let latestUpdate: { latest: string; url: string; hint: string } | null = null
  const hint = upgradeHint(currentInstallMethod())

  // Built-ins plus this workspace's own .houston/commands. The Tab completer only
  // ever knew the built-ins, so a project's commands were undiscoverable unless you
  // already knew their names. Loaded once; the menu redraws on every keystroke and
  // must not touch the disk.
  // The one project the git commands may act on: this session's folder.
  const gitDeps = { knownWorkspace: (ws: string) => ws === tui.cwd }
  let menuCommands: CommandSpec[] = [...COMMANDS]
  void loadSlashCommands(tui.cwd)
    .then((custom) => {
      // A project's own /commit (/push, /ship, /pr) runs instead of the built-in, so
      // the menu lists it rather than the built-in it replaces.
      const own = new Set(custom.map((c) => c.name.toLowerCase()))
      const builtins = COMMANDS.filter((c) => !(YIELDS_TO_CUSTOM.has(c.name) && own.has(c.name)))
      menuCommands = mergeCommands(builtins, custom).map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.args ? { args: c.args } : {})
      }))
    })
    .catch(() => {
      /* no custom commands — the built-ins still list */
    })

  // A light terminal with no saved theme starts on the light theme. Asked before the
  // composer starts reading the keyboard, so the terminal's reply never lands in it.
  if (tui.color && !resolveTheme(getSettings().tuiTheme ?? '')) {
    const bg = await detectTerminalBackground({ input: process.stdin, output: process.stdout }, process.env)
    if (bg === 'light') tui.detectedTheme = 'light'
  }
  // The saved theme, else the detected background's: the theme the driver starts on
  // (and hands the adapter again on /theme), so nothing is drawn in the wrong one.
  const paint = makePainter(tui.color, resolveTheme(getSettings().tuiTheme ?? '') ?? tui.detectedTheme ?? 'default')
  // Typing `@` lists matching files under the composer, as `/` lists commands.
  const mentionMenu = makeMentionMenu((q) => findFiles(tui.cwd, q), paint as never)

  const terminalIo = createTerminalIo({
    // Painted with the composer's painter, so the menus follow /theme.
    menuFor: (line, redraw, menuPaint) => {
      const matches = commandMenu(line, menuCommands)
      if (matches) return renderCommandMenu(matches, menuPaint as never)
      return mentionMenu(line, redraw, menuPaint as never) ?? []
    },
    paint,
    // Read live: an entry submitted this session must be recallable on the next
    // composer read, not just the ones loaded at launch.
    history: () => history,
    // A draft discarded unsent (Ctrl-C, Esc Esc) joins the same history, so Up
    // brings it back in this session and the next.
    remember: persistHistory,
    columns: () => process.stdout.columns || 80,
    // Ctrl-X Ctrl-E in the composer, same editor hand-off plan review uses.
    editText: (initial) => editInEditor(initial, 'MESSAGE.md'),
    // Read live, like the menu: the workspace's commands load after startup.
    completer: makeCompleter((q) => findFiles(tui.cwd, q), () => menuCommands),
    // Read live, so /vim applies at the next prompt rather than the next launch.
    editorMode: () => (getSettings().tuiEditor === 'vim' ? 'vim' : 'emacs'),
    rows: () => process.stdout.rows || 24,
    // The transcript viewer's `v`: the same hand-off, read-only (the edit is dropped).
    viewText: async (text) => {
      if (!(process.env.VISUAL || process.env.EDITOR)) return false
      await editInEditor(text, 'TRANSCRIPT.md')
      return true
    }
  })
  const io = onFirstPrompt(terminalIo, () => {
    host.afterFirstPrompt?.()
    loadHighlighter()
  })

  // spawn_session + scheduled runs work in the TUI too: background sessions run
  // in-process (non-interactively) and schedules fire while the TUI is open.
  const sessions = wireTerminalSessionBackends({
    notify: (m) => io.out(paint(`\n· ${m}\n`, 'dim')),
    startScheduler: true
  })

  // The session's latest chat, for the worktree's come-back command.
  let lastConversationId: string | null = null
  // Ctrl-C is the TUI's own key (clear the composer, stop a turn), read from the
  // raw terminal, which never turns it into a SIGINT. So a SIGINT, like a SIGHUP or
  // SIGTERM, comes from outside (`kill -INT`, a supervisor): stop the runs, restore
  // the terminal and exit rather than die with the terminal modes still on.
  // A signal never removes the worktree (it may hold work, and there is no one to
  // ask): it says where the worktree is, then exits.
  const exitGuard = guardTerminalExit(['SIGHUP', 'SIGTERM', 'SIGINT'], {
    flush: async () => {
      await host.flush?.()
      if (sessionWt) process.stderr.write(keptWorktreeNote(sessionWt, lastConversationId))
    }
  })
  // Exiting would kill background sessions mid-run; finish them first (their
  // conversations are what a later /resume opens). Ctrl-C still force-quits.
  const waitForBackground = async (): Promise<void> => {
    const outstanding = sessions.pendingBackgroundSessions()
    if (outstanding === 0) return
    io.out(
      paint(
        `· waiting for ${outstanding} background session${outstanding === 1 ? '' : 's'} to finish (Ctrl-C to abandon)…\n`,
        'dim'
      )
    )
    await sessions.waitForBackgroundSessions()
  }
  let code = 1
  try {
    code = await runTui(tui, {
      getSettings,
      version,
      // Exiting now would kill background sessions mid-run; finish them first, before
      // the farewell, so "Bye." is the last line rather than above the wait.
      beforeExit: () => waitForBackground(),
      // /doctor: probe on demand, reusing whatever the update check already found
      // rather than making the report wait on the network.
      // Roll a turn's writes back: the snapshots exist for every write already,
      // the terminal just had no way to reach them.
      checkpoint: {
        info: (conversationId) => getConversationCheckpoint(conversationId),
        undo: (runId) => restoreCheckpoint(runId),
        redo: (runId) => reapplyCheckpoint(runId)
      },
      // /rewind: the same engine as the desktop app's Rewind menu.
      rewind: {
        preview: (conversationId, turn, mode, text) => previewRewind(conversationId, turn, mode, text),
        apply: (conversationId, turn, mode, text) => rewindConversation(conversationId, turn, mode, text),
        undo: (conversationId) => undoRewind(conversationId)
      },
      // The setup menu's probe of local servers and added endpoints: a host that
      // doesn't answer quickly is reported as not running rather than holding up
      // the menu (the SDK's own retries can take far longer).
      listModels: (provider) => withTimeout(listModels(provider), HOST_PROBE_MS),
      // Read from the repository's HEAD file, so drawing the status line runs no git.
      // Only a HEAD the file can't answer for asks git: symbolic-ref names the branch
      // (even an unborn one) and fails on a detached HEAD or outside a repository,
      // where the status line shows no branch.
      gitBranch: () => {
        const fromFile = readHeadBranch(tui.cwd)
        if (fromFile !== undefined) return fromFile
        return runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], tui.cwd).then((head) =>
          head.ok ? head.stdout.trim() || null : null
        )
      },
      writeExport: (path, content) => writeExportFile(tui.cwd, path, content),
      // /commit, /push, /ship, /pr: the Changes view's and the PR chip's own handlers,
      // with this session's folder as the one project they may touch.
      git: {
        tree: () => collectWorkingTreeChanges(tui.cwd),
        sync: () => branchSyncFor(tui.cwd, gitDeps),
        suggest: (conversationId) => suggestCommitMessage(tui.cwd, conversationId, gitDeps),
        commit: (message) => commitAll(tui.cwd, message, gitDeps),
        push: () => pushBranch(tui.cwd, gitDeps),
        pr: () => lookupPr(tui.cwd, gitDeps)
      },
      workingTree: async () => {
        const c = await collectWorkingTreeChanges(tui.cwd)
        return {
          isRepo: c.isRepo,
          branch: c.branch,
          files: c.files.map((f) => ({
            path: f.path,
            status: f.status,
            added: f.added,
            removed: f.removed
          })),
          added: c.added,
          removed: c.removed
        }
      },
      doctor: async () => terminalDoctorFacts(tui.cwd, version, tui.color, latestUpdate),
      runUserShell: (command, onOutput) => runUserShell(tui.cwd, command, onOutput),
      saveMemory: (scope, text) => saveMemory(tui.cwd, scope, text),
      memoryStore: () => memoryStore({ workspace: tui.cwd }),
      backgroundSessions: () => sessions.backgroundSessions(),
      backgroundTasks: {
        shells: () => listShells(),
        shellTail: (id, maxLines) => shellTail(id, maxLines),
        // `user`: the agent hears of it with the next message rather than being woken.
        killShell: (id) => killShell(id, { by: 'user' }),
        stopSubagent: (runId, recordId) => stopSubagent(runId, recordId)
      },
      proposals: {
        list: (conversationId) => {
          const conv = getConversation(conversationId)
          if (!conv) return []
          return proposalsIn(conv.messages).map((p) => ({
            callId: p.callId,
            title: p.args.title,
            prompt: p.args.prompt,
            ...(conv.proposals?.[p.callId] ? { status: conv.proposals[p.callId].status } : {})
          }))
        },
        start: async (conversationId, callId, policy) => {
          const { result } = await startProposal(
            { conversationId, callId, approvalPolicy: policy },
            hostProposalDeps()
          )
          return { conversationId: result.conversationId, title: result.title }
        },
        decide: (conversationId, callId, status) => {
          decideProposal({ conversationId, callId, status }, hostProposalDeps())
        }
      },
      sideChat: terminalSideChat(),
      takeLegacyRulesNotice: () => takeLegacyRulesTerminalNotice(() => legacyRulesNoticeApplies()),
      // Wake the session when background work it started finishes at an idle composer.
      wake: {
        register: (tryWake) =>
          setWakeHost({ enabled: () => getSettings().backgroundWake !== false, start: tryWake }),
        take: (id) => {
          clearChildReportFlag(id)
          const note = wakeNote(takeBackgroundEvents(id), takeChildReports(id))
          return note ? { content: note.content, ...(note.taintSource ? { taintSource: note.taintSource } : {}) } : null
        }
      },
      checkUpdate: async () => {
        // The session never waits on this, so it can afford a slow network.
        const found = await checkForUpdate(version, { timeoutMs: INTERACTIVE_UPDATE_TIMEOUT_MS })
        latestUpdate = found ? { latest: found.latest, url: found.url, hint: hint.fix } : null
        return found ? { ...found, hint: hint.line } : null
      },
      // Real terminal width (re-read each turn) so status-line truncation and
      // markdown wrapping track the actual terminal, not a hardcoded 80 columns.
      columns: () => process.stdout.columns || 80,
      startRun,
      resolveApproval,
      resolveQuestion,
      resolvePlan,
      resolveElicitation,
      cancelRun,
      setRunPolicy,
      setRunEffort,
      steerRun,
      unsteerRun,
      // Each chat's unsent draft, one 0600 file per chat under userData.
      drafts: createDraftStore(join(getUserDataDir(), 'tui-drafts'), { warn: (m) => log.warn(m) }),
      editText: (initial) => editInEditor(initial),
      persistHistory,
      // /copy: the platform's clipboard helper when this is a local session (never
      // over SSH, where OSC 52 is the way to the user's own clipboard).
      copyText: (text) => writeClipboardText(text),
      // /usage: the desktop usage view's report, summed locally from the saved chats.
      usageReport: () => computeUsageReport(),
      clipboardImage: () => {
        const img = readClipboardImage()
        if (!img) return { error: `no image on the clipboard (${noClipboardHint(process.platform)})` }
        if (exceedsImageSizeLimit(img.data)) return { error: 'that image is too large' }
        return { image: { mediaType: img.mediaType, data: img.data } }
      },
      loadImage: (p) => {
        const mediaType = mediaTypeForImagePath(p)
        if (!mediaType || !isSupportedImageType(mediaType)) {
          return { error: `unsupported image type (use ${SUPPORTED_IMAGE_TYPES.join(', ')})` }
        }
        try {
          const data = readFileSync(isAbsolute(p) ? p : join(tui.cwd, p)).toString('base64')
          if (exceedsImageSizeLimit(data)) return { error: 'image is too large' }
          return { image: { mediaType, data } }
        } catch (e) {
          // `missing` lets a pasted path that names no file paste as plain text.
          const code = (e as NodeJS.ErrnoException).code
          const missing = code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
          return { error: `could not read ${p}`, ...(missing ? { missing } : {}) }
        }
      },
      capabilities: async () => {
        const s = getSettings()
        const [skills, agents] = await Promise.all([loadSkills(tui.cwd), loadAgents(tui.cwd)])
        return {
          skills: skills.map((k) => ({ name: k.name, detail: k.description })),
          agents: agents.map((a) => ({ name: a.name, detail: a.description })),
          mcp: (s.mcpServers ?? []).map((m) => ({ name: m.name ?? m.id, detail: m.id })),
          hooks: (s.hooks ?? []).map((h) => ({ name: h.event, detail: `${h.matcher} → ${h.command}` }))
        }
      },
      // Custom slash commands from the workspace's .houston/commands (for /<name>).
      commands: () => loadSlashCommands(tui.cwd),
      // On-demand context compaction for the /compact command.
      compact: (id, providerId, model, opts) => compactConversationNow(id, providerId, model, opts),
      // Settings editing for /hooks and /mcp (writes the shared settings.json, 0600).
      updateSettings: (patch) => {
        updateSettings(patch)
      },
      // Live connection badges + OAuth sign-in/out for /mcp. Sign-in runs the full
      // interactive flow (discovery, registration, browser, exchange) and persists
      // the tokens through the wired host store.
      mcpStatuses: () => getMcpStatuses(),
      // Read-only MCP Registry browsing for /mcp search and /mcp add-from-registry.
      mcpRegistry: { search: searchMcpRegistry, get: getMcpRegistryServer },
      // /mcp reconnect: the user's own servers from settings (the manager reads their
      // header and env values from the secret store itself).
      mcpReconnect: (ids) => reconnectMcpServers(getSettings().mcpServers ?? [], ids),
      // /permissions: every tier the gate reads, as Settings > Permissions shows them.
      permissionPolicy: () => describePermissionPolicy(tui.cwd, defaultPolicyDeps(folderTrustFor)),
      ruleUsage: () => getRuleUsage(),
      ...(canStoreMcpOAuth()
        ? {
            mcpOAuth: {
              login: async (server: McpServerConfig, onStatus: (m: string) => void) => {
                const tokens = await runMcpOAuthFlow(server.url ?? '', { onStatus })
                setMcpOAuth(server.id, tokens)
              },
              logout: (serverId: string) => setMcpOAuth(serverId, null)
            }
          }
        : {}),
      canStoreHeaderSecrets: canPersistHeaderSecrets(),
      // In-session API-key entry for /login. Writes through the host's key store
      // (safeStorage on the desktop, cli-credentials.json on the CLI); absent only
      // if no writable store was wired, which disables /login gracefully.
      ...(canSetKey() ? { setKey: (id: string, key: string) => setProviderKey(id, key) } : {}),
      isMac: process.platform === 'darwin',
      settingsPath: () => join(getUserDataDir(), 'settings.json'),
      // /status: what only the host knows. The network state is this chat's own
      // grants, read from the same in-memory store the loop seeds each turn from.
      statusFacts: async (conversationId) => {
        const managedPath = resolveManagedPolicyPath()
        const managed = existsSync(managedPath)
          ? { path: managedPath, rules: (await loadManagedPolicy(managedPath)).permissionRules.length }
          : null
        const o = conversationId ? overrideForConversation(conversationId) : null
        return {
          installMethod: currentInstallMethod(),
          sandbox: { backend: activeBackendId(), enforced: isSandboxed() },
          egressMode: resolveEgressMode(getSettings().sandboxEgress),
          network: o
            ? {
                shellGranted: o.shellNetworkGranted,
                shellDecided: o.shellNetworkDecided,
                hosts: o.networkHosts.size,
                shellHosts: o.egressHosts.size
              }
            : null,
          managed
        }
      },
      // /feedback: the desktop's Help > Report an Issue text. The doctor probe runs
      // against the profile folder, not the project, so no project path reaches it,
      // and the redacter runs over it anyway before the user sees it.
      issueReport: {
        body: () =>
          redactSecrets(
            issueReportBody(gatherDoctorFacts(getUserDataDir(), { version, update: null })),
            collectSecrets()
          ),
        url: (body) => (body === null ? ISSUES_URL : issueReportUrl(ISSUES_URL, body)),
        open: (url) => openWithSystemHandler(url)
      },
      io,
      highlightHtml: (lang, codeStr) => (hljs ? highlightToHtml(hljs, lang, codeStr) : null),
      persist: {
        // A chat started in the session's worktree records it, as the desktop app's
        // worktree chats do, so the app shows its branch and cleans it up the same way.
        create: (input) => {
          const conv = createConversation({
            ...input,
            ...(sessionWt && input.workspace === sessionWt.path ? { worktree: conversationWorktree(sessionWt) } : {})
          })
          lastConversationId = conv.id
          return conv
        },
        setMessages: (id, messages) => {
          lastConversationId = id
          setMessages(id, messages)
        },
        // Keep the chat's stored settings current after a `/model`, `/reasoning` or
        // `/approval` change (the GUI's per-send updateConversationMeta counterpart).
        setSettings: (id, patch) => updateConversationMeta(id, patch),
        // Recent conversations for this folder, newest first, for the `/resume` picker,
        // marked with the desktop app's unread state (read fresh each time, and only
        // read: the app owns that file and would overwrite a write from here).
        list: (workspace) =>
          resumeEntries(
            listConversations().filter((c) => c.workspace === workspace),
            RESUME_LIMIT
          ),
        search: (workspace, query) =>
          resumeEntries(
            searchConversations(query).filter((c) => c.workspace === workspace),
            RESUME_LIMIT
          ),
        // The picker's Ctrl-A scope: every folder's chats, each with its folder.
        listAll: () => resumeEntries(listConversations(), RESUME_ALL_LIMIT),
        searchAll: (query) => resumeEntries(searchConversations(query), RESUME_ALL_LIMIT),
        fork: (id) => {
          const forked = forkConversation(id)
          return forked ? { id: forked.id } : null
        },
        // The desktop sidebar's rename: marks the title as chosen, so it is never
        // replaced by a generated one.
        rename: (id, title) => organizeConversation(id, { title }),
        // The desktop app's delete: a live run, shells and queue stop too, and the
        // worktree goes only when the user chose that (or it holds nothing).
        remove: (id, choice) =>
          choice ? deleteChat(id, choice.plan, choice.removeWorktree) : stopAndDeleteConversation(id),
        planDelete: (id) => planChatDelete(id),
        get: (id) => {
          const conv = getConversation(id)
          return conv
            ? {
                messages: conv.messages,
                providerId: conv.providerId,
                model: conv.model,
                ...(conv.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {}),
                ...(conv.approvalPolicy ? { approvalPolicy: conv.approvalPolicy } : {})
              }
            : null
        }
      }
    })
    // Normally done before the farewell (beforeExit); here too in case the TUI left
    // without it.
    await waitForBackground()
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  } finally {
    // Runs, shells and servers stop first: a dev server left running in the worktree
    // must not hold it while it is removed.
    await exitGuard.run()
    if (sessionWt) {
      const wt = sessionWt
      try {
        await finishSessionWorktree(wt, {
          out: (s) => io.out(s),
          ask: (prompt) => io.readLine(prompt, { discardPending: true }),
          dim: (s) => paint(s, 'dim'),
          conversationId: lastConversationId,
          detach: (w) => detachWorktreeChats(w)
        })
      } catch (e) {
        log.warn(`worktree exit step failed: ${String(e)}`)
        process.stderr.write(keptWorktreeNote(wt, lastConversationId))
      }
    }
    exitGuard.dispose()
  }
  return code
}

/** The stderr lines that say a session's worktree was kept and how to come back. */
function keptWorktreeNote(wt: SessionWorktree, conversationId: string | null): string {
  const path = stripControlChars(wt.path)
  return `· kept the worktree at ${path} (branch ${wt.branch})\n  come back with: ${stripControlChars(
    comeBackCommand(wt.path, conversationId)
  )}\n`
}

/** Point every chat that ran in a removed worktree back at its repository. */
function detachWorktreeChats(wt: { path: string; repoRoot: string }): void {
  for (const c of listConversations()) {
    if (c.worktree?.path === wt.path) detachConversationWorktree(c.id, wt.repoRoot)
  }
}

/**
 * Settle the folder a terminal session runs in, for `-w` and `--resume`: create the
 * session's worktree (and move the session into it), or open a resumed worktree
 * chat in its worktree. Returns the created worktree (null when none), or the exit
 * code when it couldn't be created. Says what it did on stderr.
 */
async function startInWorktree(opts: {
  cwd: string
  worktree?: { name?: string }
  resumeId?: string
}): Promise<SessionWorktree | null | number> {
  if (opts.worktree) {
    const setup = await createSessionWorktree(opts.cwd, opts.worktree.name)
    if (!setup.ok) {
      process.stderr.write(`${stripControlChars(setup.error)}\n`)
      return setup.code
    }
    opts.cwd = setup.worktree.path
    process.stderr.write(
      `· working in a new worktree: ${stripControlChars(setup.worktree.path)} (branch ${setup.worktree.branch})\n`
    )
    return setup.worktree
  }
  if (opts.resumeId) {
    const folder = resumeWorktreeFolder(getConversation(opts.resumeId), opts.cwd)
    if (folder) {
      opts.cwd = folder
      process.stderr.write(`· opening the chat in its worktree: ${stripControlChars(folder)}\n`)
    }
  }
  return null
}

/**
 * Hand the first SIGINT / SIGTERM / SIGHUP to `onFirst` so the client can stop its
 * runs cleanly (Node's default would kill the process and skip every cleanup, while
 * the agent's commands, each in its own process group, kept running). A second
 * signal stops the commands and exits at once. Returns the unsubscribe.
 */
export function watchTerminationSignals(
  onFirst: (signal: HeadlessSignal) => void,
  proc: Pick<NodeJS.Process, 'on' | 'off' | 'exit'> = process
): () => void {
  let seen = false
  const handlers = HEADLESS_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (seen) {
        killAllShells()
        proc.exit(HEADLESS_SIGNAL_EXIT[signal])
        return
      }
      seen = true
      onFirst(signal)
    }
    proc.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler)
  }
}

/**
 * The schedule daemon: fire scheduled runs while no Houston window or terminal session
 * is open, as background sessions (approvals declined, as for any terminal-hosted
 * background session). Runs until a signal stops it. One per profile (a pid file), and
 * it leaves firing to the desktop app while that is open (see scheduleDaemon.ts).
 * Returns the exit code: 0 when another daemon already runs.
 */
export async function runScheduleDaemonEntry(
  host: TerminalHost & {
    /** Ends the daemon without a signal (tests). */
    signal?: AbortSignal
    /** Signals to stop on; the default is SIGHUP, SIGTERM and SIGINT. */
    proc?: SignalProcess
    out?: (s: string) => void
    /** Whether the desktop app's scheduler is up (tests). */
    appRunning?: () => boolean
  } = {}
): Promise<number> {
  const out = host.out ?? ((s: string) => void process.stdout.write(s))
  const held = holdPidFile(daemonPidPath())
  if (!held.ok) {
    out(`The schedule daemon is already running (pid ${held.pid}).\n`)
    return 0
  }
  const appRunning = host.appRunning ?? (() => appSchedulerRunning())
  let deferring = false
  const backends = wireTerminalSessionBackends({
    startScheduler: true,
    notify: (m) => log.info(`schedule daemon: ${m}`),
    shouldFire: () => {
      const app = appRunning()
      if (app !== deferring) {
        deferring = app
        log.info(app ? 'schedule daemon: the desktop app is open; leaving scheduled runs to it' : 'schedule daemon: firing scheduled runs')
      }
      return !app
    }
  })
  log.info(`schedule daemon${host.version ? ` ${host.version}` : ''} started (pid ${process.pid})`)
  out(`Houston schedule daemon running (pid ${process.pid}). Stop it with Ctrl-C.\n`)

  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  host.signal?.addEventListener('abort', () => stop(), { once: true })
  // The scheduler's timers don't hold the process open; this does, until stopped.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const cleanup = installSignalCleanup(
    async () => {
      stop()
      backends.scheduler.stop()
      // Runs in flight record that they were stopped; then their commands and servers go.
      await stopLiveRuns()
      killAllShells()
      disconnectAllMcp()
      await lspManager.stopAll()
      held.release()
    },
    {
      signals: ['SIGHUP', 'SIGTERM', 'SIGINT'],
      ...(host.proc ? { proc: host.proc } : {}),
      beforeSignalExit: async () => {
        flushRuleUsage()
        await host.flush?.()
      },
      onSignal: (sig) => log.info(`schedule daemon: received ${sig}; stopping`)
    }
  )
  try {
    await stopped
    await cleanup.run()
  } finally {
    clearInterval(keepAlive)
    cleanup.dispose()
    held.release()
  }
  log.info('schedule daemon stopped')
  return 0
}

/** Run the one-shot headless client to completion. Returns the exit code. */
export async function runHeadlessEntry(headless: HeadlessOptions, opts: TerminalHost = {}): Promise<number> {
  // spawn_session works headless too: children run concurrently in this process
  // and are awaited below so the one-shot exit doesn't kill them mid-run. The
  // scheduler backend is wired without starting timers — a headless run can
  // create/list/cancel schedules, which then fire in a long-lived host (GUI/TUI).
  const sessions = wireTerminalSessionBackends({
    notify: (m) => process.stderr.write(`· ${m}\n`),
    startScheduler: false
  })
  // The update check runs alongside the task and is never waited for: its answer is
  // printed after the run only if it is already in (it is cached for a day, so it
  // usually is), and process exit does not wait on a fetch still in flight.
  const pendingUpdate: { found: UpdateAvailable | null } = { found: null }
  if (
    opts.version &&
    headlessUpdateNoticeAllowed(headless.json, Boolean(process.stderr.isTTY), process.env)
  ) {
    void checkForUpdate(opts.version)
      .then((found) => {
        pendingUpdate.found = found
      })
      .catch(() => {
        /* a failed update check is a non-event */
      })
  }
  // -w: a one-shot run in a fresh worktree keeps it (the run's result is in it). A
  // bad flag value is runHeadless's to report, before any worktree is made.
  let runWt: SessionWorktree | null = null
  if (!headless.usageError) {
    const wt = await startInWorktree(headless)
    if (typeof wt === 'number') return wt
    runWt = wt
    if (runWt) headless.createdWorktree = { path: runWt.path, branch: runWt.branch }
  }
  let code = 1
  let interrupted = false
  try {
    code = await runHeadless(headless, {
      getSettings,
      startRun,
      resolveApproval,
      resolveQuestion,
      resolvePlan,
      resolveElicitation,
      cancelRun,
      onSignal: (handler) =>
        watchTerminationSignals((signal) => {
          interrupted = true
          handler(signal)
        }),
      // On a terminal, the answer and the progress lines are text the model and its
      // tools wrote, so they pass the TUI's output filter: no escape in them can drive
      // the terminal. Piped output stays byte-exact for the script reading it.
      out: (s) => process.stdout.write(process.stdout.isTTY ? filterTerminalOutput(s) : s),
      err: (s) => process.stderr.write(process.stderr.isTTY ? filterTerminalOutput(s) : s),
      readStdin: readAllStdin,
      readStdinLines,
      ...(opts.version ? { version: opts.version } : {}),
      // Persist headless runs as conversations (shared with the TUI/GUI) so
      // --continue / --resume and an interactive `-i` handoff can pick them up.
      session: {
        load: ({ workspace, id }) => {
          const conv = id
            ? getConversation(id)
            : (() => {
                const meta = listConversations()
                  .filter((c) => c.workspace === workspace)
                  .sort((a, b) => b.updatedAt - a.updatedAt)[0]
                return meta ? getConversation(meta.id) : null
              })()
          return conv
            ? {
                id: conv.id,
                messages: conv.messages,
                providerId: conv.providerId,
                model: conv.model,
                ...(conv.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {})
              }
            : null
        },
        create: (input) =>
          createConversation({
            ...input,
            ...(runWt && input.workspace === runWt.path ? { worktree: conversationWorktree(runWt) } : {})
          }),
        setMessages,
        // Keep a resumed conversation's stored model and effort in step with what this
        // run actually used, so usage attribution and a GUI re-open don't diverge.
        setSettings: (id, patch) => updateConversationMeta(id, patch),
        // --name: a chosen title, never replaced by a generated one.
        rename: (id, title) => organizeConversation(id, { title })
      }
    })
    // Don't let the one-shot exit tear down sessions the run spawned; their
    // conversations persist, so a later --resume can pick each one up. An
    // interrupted run doesn't wait on them: the signal asked Houston to stop.
    const outstanding = interrupted ? 0 : sessions.pendingBackgroundSessions()
    if (outstanding > 0) {
      process.stderr.write(
        `· waiting for ${outstanding} background session${outstanding === 1 ? '' : 's'} to finish…\n`
      )
      await sessions.waitForBackgroundSessions()
    }
    if (pendingUpdate.found && opts.version) {
      process.stderr.write(
        formatHeadlessUpdateNotice(pendingUpdate.found, opts.version, upgradeHint(currentInstallMethod()).line)
      )
    }
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  } finally {
    // Interrupted: background sessions the run spawned are not waited for, so stop
    // them here rather than let the exit cut them off mid-step.
    if (interrupted) await stopLiveRuns()
    killAllShells()
    disconnectAllMcp()
    await lspManager.stopAll()
  }
  return code
}

/**
 * Point `process.stdout.write` at stderr and return the real stdout writer. In ACP
 * mode stdout is the protocol channel, so anything else that writes there (a stray
 * `console.log` in a dependency, a library banner) would corrupt the stream. The
 * global `console` writes through the same stream object, so this covers it too.
 */
export function reserveStdoutForProtocol(): (frame: string) => void {
  const stdout = process.stdout
  const real = stdout.write.bind(stdout) as (chunk: string) => boolean
  stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof stdout.write
  return (frame) => {
    real(frame)
  }
}

/**
 * Run Houston as an Agent Client Protocol server on stdio (`--acp`) until the
 * editor closes the connection. Returns the exit code.
 */
export async function runAcpEntry(host: TerminalHost = {}, launch: AcpLaunchOptions = {}): Promise<number> {
  const writeFrame = reserveStdoutForProtocol()
  // The editor went away mid-write: there is no one left to serve, so live prompts
  // are cancelled rather than left editing files for a reader that is gone.
  const outputClosed = new AbortController()
  process.stdout.on('error', () => outputClosed.abort())
  // Ctrl-C, a kill, or a closed terminal: cancel every live prompt and stop serving.
  const shutdown = new AbortController()
  let signalled: HeadlessSignal | undefined
  const stopWatching = watchTerminationSignals((signal) => {
    signalled = signal
    shutdown.abort()
  })
  const sessions = wireTerminalSessionBackends({
    notify: (m) => process.stderr.write(`· ${m}\n`),
    startScheduler: false
  })
  let code = 0
  try {
    await serveAcp(
      process.stdin,
      {
        getSettings,
        startRun,
        resolveApproval,
        resolveQuestion,
        resolvePlan,
        resolveElicitation,
        cancelRun,
        setRunPolicy,
        write: writeFrame,
        log: (m) => {
          log.info(m)
          process.stderr.write(`${m}\n`)
        },
        version: host.version ?? 'dev',
        ...launch,
        store: {
          create: ({ workspace, providerId, model }) => createConversation({ workspace, providerId, model }),
          get: (id) => {
            const conv = getConversation(id)
            return conv
              ? {
                  id: conv.id,
                  workspace: conv.workspace,
                  messages: conv.messages,
                  title: conv.title,
                  updatedAt: conv.updatedAt,
                  providerId: conv.providerId,
                  model: conv.model,
                  ...(conv.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {}),
                  ...(conv.approvalPolicy ? { approvalPolicy: conv.approvalPolicy } : {})
                }
              : null
          },
          list: () =>
            listConversations().map((c) => ({
              id: c.id,
              workspace: c.workspace,
              title: c.title,
              updatedAt: c.updatedAt
            })),
          setMessages,
          setModel: (id, providerId, model) => updateConversationMeta(id, { providerId, model }),
          // A setting the user changed on the chat (model, effort, approval mode), saved
          // as they change it, the way the desktop app and the terminal keep it.
          setSettings: (id, patch) => void setConversationSettings(id, patch),
          title: (id) => peekConversation(id)?.title,
          // session/delete: the desktop app's delete, so a live run and shells stop too.
          remove: (id) => {
            if (!conversationExists(id)) return false
            stopAndDeleteConversation(id)
            return true
          }
        },
        // The workspace's own slash commands, skills and agents, read fresh each time.
        commands: (cwd) => loadSlashCommands(cwd),
        skills: async (cwd) => (await loadSkills(cwd)).map((k) => ({ name: k.name, description: k.description })),
        agents: async (cwd) => (await loadAgents(cwd)).map((a) => ({ name: a.name, description: a.description })),
        compact: (id, providerId, model, focus) =>
          compactConversationNow(id, providerId, model, focus ? { focus } : {})
      },
      { shutdown: shutdown.signal, outputClosed: outputClosed.signal }
    )
    // Stopped by a signal or a broken pipe: nothing is left to wait for them.
    const outstanding = signalled || outputClosed.signal.aborted ? 0 : sessions.pendingBackgroundSessions()
    if (outstanding > 0) {
      process.stderr.write(
        `· waiting for ${outstanding} background session${outstanding === 1 ? '' : 's'} to finish…\n`
      )
      await sessions.waitForBackgroundSessions()
    }
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
    code = 1
  } finally {
    stopWatching()
    if (signalled || outputClosed.signal.aborted) await stopLiveRuns()
    killAllShells()
    disconnectAllMcp()
    await lspManager.stopAll()
  }
  return signalled ? HEADLESS_SIGNAL_EXIT[signalled] : code
}

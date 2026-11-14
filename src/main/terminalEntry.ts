import { createHash } from 'node:crypto'
import { clearChildReportFlag, setWakeHost, takeBackgroundEvents, wakeNote } from './agent/backgroundEvents'
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { isatty } from 'node:tty'
import { spawn, spawnSync } from 'node:child_process'
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
import { killAllShells } from './agent/shells'
import { lspManager } from './agent/lsp/manager'
import { flushRuleUsage } from './ruleUsage'
import { installSignalCleanup, type CleanupSignal, type SignalCleanup, type SignalProcess } from './signalCleanup'
import { disconnectAllMcp, getMcpStatuses } from './mcp/manager'
import { runMcpOAuthFlow } from './mcp/oauth'
import { canStoreMcpOAuth, setMcpOAuth } from './agentHost'
import type { AgentEvent } from '@shared/agent'
import { setSpawnBackend } from './agent/spawn'
import { setSchedulerBackend } from './agent/scheduler'
import { createSpawnBackend } from './spawnSession'
import { createSchedulerService, fireViaSpawn, schedulesFilePath } from './schedulerService'
import { createWorktree, removeWorktree } from './agent/worktree'
import { decideProposal, hostProposalDeps, proposalsIn, startProposal } from './proposals'
import { askSideChat, cancelSideChat, clearSideChat, hostSideChatDeps } from './sideChat'
import { findFiles } from './agent/mentions'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'
import { loadCommands } from './agent/commands'
import { compactConversationNow } from './agent/compact'
import {
  getConversationCheckpoint,
  restoreCheckpoint,
  reapplyCheckpoint
} from './agent/checkpoints'
import { previewRewind, rewindConversation, undoRewind } from './agent/rewind'
import { collectWorkingTreeChanges } from './agent/workingTree'
import { listModels } from './providers'
import { runGitCapture } from './agent/gitRead'
import { writeExportFile } from './tui-sessions'
import {
  canPersistHeaderSecrets,
  canSetKey,
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
import {
  HEADLESS_SIGNAL_EXIT,
  HEADLESS_SIGNALS,
  runHeadless,
  type HeadlessOptions,
  type HeadlessSignal
} from './headless'
import { serveAcp } from './acp'
import { createTerminalIo, resolveColor } from './tui-io'
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
import { highlightToHtml } from './syntax'
import {
  createConversation,
  setMessages,
  updateConversationMeta,
  listConversations,
  getConversation,
  peekConversation,
  searchConversations,
  forkConversation,
  organizeConversation,
  deleteConversation,
  setGeneratedTitle,
  reportChildToParent,
  takeChildReports,
  saveSideChat
} from './conversations'

/** Resume-picker rows, each marked with the desktop app's unread state for it. */
function withUnread(convs: { id: string; title: string; updatedAt: number }[]): ResumeEntry[] {
  const unread = new ReadStateStore(join(getUserDataDir(), 'read-state.json')).snapshot()
  return convs.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    ...(unread[c.id] ? { unread: unread[c.id].outcome } : {})
  }))
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
    writeFileSync(file, initial, 'utf8')
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
}): {
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

  const scheduler = createSchedulerService({ file: schedulesFilePath(), fire: fireViaSpawn() })
  setSchedulerBackend(scheduler)
  if (opts.startScheduler) scheduler.start()

  return {
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

/**
 * Run a command in the user's own shell for the composer's `!` escape.
 *
 * Unsandboxed on purpose. The sandbox exists to confine the AGENT, which can be
 * steered by a prompt injection into running something the user never wanted. A
 * command the user typed at their own prompt is not that: it is exactly as
 * trusted as the shell they launched Houston from, and confining it would only
 * break the obvious cases (`!git push` with no network, `!npm i` unable to write
 * outside the workspace).
 *
 * `shell: true` is intended here — the string IS a shell command, typed by the
 * person the shell belongs to. Their $SHELL is used so aliases-free but familiar
 * syntax works; output is streamed so a build looks alive rather than hung.
 */
function runUserShell(
  workspace: string,
  command: string,
  onOutput: (chunk: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: process.platform === 'win32' ? true : (process.env.SHELL ?? '/bin/sh'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Decode as streams, so a multibyte character split across two pipe chunks
    // prints as itself rather than as two replacement characters.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => onOutput(d))
    child.stderr?.on('data', (d: string) => onOutput(d))
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/**
 * Locate an external binary the agent shells out to. `which`/`where` is the same
 * lookup the shell itself does, so "found" here matches what a tool call sees.
 */
/**
 * Probe the environment for `/doctor`. The shared gatherer collects the facts
 * common to every client; the terminal adds its own `terminal` group (tty, color,
 * width) that the desktop app has no analogue for.
 */
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

function probeDoctor(
  cwd: string,
  version: string,
  color: boolean,
  update: { latest: string; url: string; hint?: string } | null
): DoctorFacts {
  return {
    ...gatherDoctorFacts(cwd, { version, update }),
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
  // Colorize only when the environment says so (TTY, NO_COLOR, TERM, FORCE_COLOR).
  tui.color = resolveColor(process.env, Boolean(process.stdout.isTTY))
  // Load highlight.js lazily (dynamic import) so it stays out of the module graph
  // that index.test.ts loads — only the real interactive path pulls it in.
  // `./syntax` itself carries no heavy deps (highlight.js is injected below), so
  // it's imported statically at the top; the dynamic wrapper bought no chunk split.
  const { default: hljs } = await import('highlight.js/lib/common')

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

  const paint = makePainter(tui.color)
  // Built-ins plus this workspace's own .houston/commands. The Tab completer only
  // ever knew the built-ins, so a project's commands were undiscoverable unless you
  // already knew their names. Loaded once; the menu redraws on every keystroke and
  // must not touch the disk.
  let menuCommands: CommandSpec[] = [...COMMANDS]
  void loadCommands(tui.cwd)
    .then((custom) => {
      menuCommands = mergeCommands(COMMANDS, custom).map((c) => ({
        name: c.name,
        description: c.description
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
  // Typing `@` lists matching files under the composer, as `/` lists commands.
  const mentionMenu = makeMentionMenu((q) => findFiles(tui.cwd, q), paint as never)

  const io = createTerminalIo({
    menuFor: (line, redraw) => {
      const matches = commandMenu(line, menuCommands)
      if (matches) return renderCommandMenu(matches, paint as never)
      return mentionMenu(line, redraw) ?? []
    },
    paint,
    // Read live: an entry submitted this session must be recallable on the next
    // composer read, not just the ones loaded at launch.
    history: () => history,
    columns: () => process.stdout.columns || 80,
    // Ctrl-X Ctrl-E in the composer, same editor hand-off plan review uses.
    editText: (initial) => editInEditor(initial, 'MESSAGE.md'),
    // Read live, like the menu: the workspace's commands load after startup.
    completer: makeCompleter((q) => findFiles(tui.cwd, q), () => menuCommands),
    // Read live, so /vim applies at the next prompt rather than the next launch.
    editorMode: () => (getSettings().tuiEditor === 'vim' ? 'vim' : 'emacs')
  })

  // spawn_session + scheduled runs work in the TUI too: background sessions run
  // in-process (non-interactively) and schedules fire while the TUI is open.
  const sessions = wireTerminalSessionBackends({
    notify: (m) => io.out(paint(`\n· ${m}\n`, 'dim')),
    startScheduler: true
  })

  // Ctrl-C is the TUI's own key (clear the composer, stop a turn), read from the
  // raw terminal, which never turns it into a SIGINT. So a SIGINT, like a SIGHUP or
  // SIGTERM, comes from outside (`kill -INT`, a supervisor): stop the runs, restore
  // the terminal and exit rather than die with the terminal modes still on.
  const exitGuard = guardTerminalExit(['SIGHUP', 'SIGTERM', 'SIGINT'], host)
  let code = 1
  try {
    code = await runTui(tui, {
      getSettings,
      version,
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
      // symbolic-ref names the branch (even an unborn one) and fails on a detached
      // HEAD or outside a repository, where the status line shows no branch.
      gitBranch: async () => {
        const head = await runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], tui.cwd)
        return head.ok ? head.stdout.trim() || null : null
      },
      writeExport: (path, content) => writeExportFile(tui.cwd, path, content),
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
      doctor: async () => probeDoctor(tui.cwd, version, tui.color, latestUpdate),
      runUserShell: (command, onOutput) => runUserShell(tui.cwd, command, onOutput),
      saveMemory: (scope, text) => saveMemory(tui.cwd, scope, text),
      memoryStore: () => memoryStore({ workspace: tui.cwd }),
      backgroundSessions: () => sessions.backgroundSessions(),
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
          return wakeNote(takeBackgroundEvents(id), takeChildReports(id))?.content ?? null
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
      editText: (initial) => editInEditor(initial),
      persistHistory,
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
        } catch {
          return { error: `could not read ${p}` }
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
      commands: () => loadCommands(tui.cwd),
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
      io,
      highlightHtml: (lang, codeStr) => highlightToHtml(hljs, lang, codeStr),
      persist: {
        create: (input) => createConversation(input),
        setMessages,
        // Keep the chat's stored settings current after a `/model`, `/reasoning` or
        // `/approval` change (the GUI's per-send updateConversationMeta counterpart).
        setSettings: (id, patch) => updateConversationMeta(id, patch),
        // Recent conversations for this folder, newest first, for the `/resume` picker,
        // marked with the desktop app's unread state (read fresh each time, and only
        // read: the app owns that file and would overwrite a write from here).
        list: (workspace) =>
          withUnread(
            listConversations()
              .filter((c) => c.workspace === workspace)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 20)
          ),
        search: (workspace, query) =>
          withUnread(
            searchConversations(query)
              .filter((c) => c.workspace === workspace)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 20)
          ),
        fork: (id) => {
          const forked = forkConversation(id)
          return forked ? { id: forked.id } : null
        },
        // The desktop sidebar's rename: marks the title as chosen, so it is never
        // replaced by a generated one.
        rename: (id, title) => organizeConversation(id, { title }),
        remove: (id) => deleteConversation(id),
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
    // Exiting now would kill background sessions mid-run; finish them first (their
    // conversations are what a later /resume opens). Ctrl-C still force-quits.
    const outstanding = sessions.pendingBackgroundSessions()
    if (outstanding > 0) {
      io.out(
        paint(
          `· waiting for ${outstanding} background session${outstanding === 1 ? '' : 's'} to finish (Ctrl-C to abandon)…\n`,
          'dim'
        )
      )
      await sessions.waitForBackgroundSessions()
    }
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  } finally {
    await exitGuard.run()
    exitGuard.dispose()
  }
  return code
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
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
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
        create: (input) => createConversation(input),
        setMessages,
        // Keep a resumed conversation's stored model and effort in step with what this
        // run actually used, so usage attribution and a GUI re-open don't diverge.
        setSettings: (id, patch) => updateConversationMeta(id, patch)
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
export async function runAcpEntry(host: TerminalHost = {}): Promise<number> {
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
                  ...(conv.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {})
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
          setModel: (id, providerId, model) => updateConversationMeta(id, { providerId, model })
        }
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

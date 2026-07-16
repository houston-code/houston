import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { LEGAL_VERSION } from '@shared/legal'
import type { McpServerConfig } from '@shared/types'
import {
  isSupportedImageType,
  exceedsImageSizeLimit,
  SUPPORTED_IMAGE_TYPES
} from '@shared/images'
import { startRun, resolveApproval, resolveQuestion, resolvePlan, resolveElicitation, cancelRun } from './agent/loop'
import { killAllShells } from './agent/shells'
import { disconnectAllMcp, getMcpStatuses } from './mcp/manager'
import { runMcpOAuthFlow } from './mcp/oauth'
import { canStoreMcpOAuth, setMcpOAuth } from './agentHost'
import type { AgentEvent } from '@shared/agent'
import { setSpawnBackend } from './agent/spawn'
import { setSchedulerBackend } from './agent/scheduler'
import { createSpawnBackend } from './spawnSession'
import { createSchedulerService, fireViaSpawn, schedulesFilePath } from './schedulerService'
import { createWorktree, removeWorktree } from './agent/worktree'
import { findFiles } from './agent/mentions'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'
import { loadCommands } from './agent/commands'
import { compactConversationNow } from './agent/compact'
import {
  canPersistHeaderSecrets,
  canSetKey,
  getSettings,
  setProviderKey,
  updateSettings
} from './store'
import { getUserDataDir } from './userData'
import { log } from './logger'
import { runTui, makePainter, mediaTypeForImagePath, type TuiOptions } from './tui'
import { runHeadless, type HeadlessOptions } from './headless'
import { createTerminalIo, resolveColor } from './tui-io'
import { makeCompleter } from './tui-complete'
import { parseHistory, serializeHistory, appendHistory } from './tui-history'
import { highlightToHtml } from './syntax'
import {
  createConversation,
  setMessages,
  updateConversationMeta,
  listConversations,
  getConversation,
  searchConversations,
  forkConversation,
  setGeneratedTitle
} from './conversations'

/**
 * Terminal-facing entry points — the full wiring of the interactive TUI (`-i`)
 * and one-shot headless (`-p`) clients onto the shared agent core, settings
 * store, and conversation persistence. Everything here is Electron-free: the
 * desktop app calls these from inside `app.whenReady()` (index.ts) and the
 * standalone CLI calls them directly (src/cli/index.ts), each after wiring the
 * userData seam and host credentials for its environment. Extracted from
 * index.ts so the two hosts can't drift apart.
 *
 * Both entries return the process exit code rather than exiting, since the two
 * hosts exit differently (`app.exit` vs `process.exit`), and both tear down the
 * agent's background shells and MCP connections before returning.
 */

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
} {
  const liveSpawnedRuns = new Set<string>()
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
    getTitle: (id) => getConversation(id)?.title,
    // Terminal hosts keep no recent-workspace list (that's the GUI's welcome screen).
    rememberWorkspace: () => {},
    liveSpawnCount: () => liveSpawnedRuns.size,
    removeWorktree: (wt) => removeWorktree(wt),
    startBackgroundRun: (conversationId, req) => {
      liveSpawnedRuns.add(conversationId)
      const run = startRun(req, backgroundSend, (m) => setMessages(conversationId, m))
        .catch((e) => {
          log.warn(`background session ${conversationId} failed: ${String(e)}`)
        })
        .finally(() => {
          liveSpawnedRuns.delete(conversationId)
          const title = getConversation(conversationId)?.title ?? conversationId
          opts.notify?.(`background session "${title}" finished — resume it to see the result (id ${conversationId})`)
        })
      pending.add(run)
      void run.finally(() => pending.delete(run))
    }
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
    }
  }
}

/** Run the interactive terminal client to completion. Returns the exit code. */
export async function runTuiEntry(tui: TuiOptions): Promise<number> {
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
      writeFileSync(histFile, serializeHistory(history), { mode: 0o600 })
    } catch (e) {
      log.warn(`failed to persist TUI history: ${String(e)}`)
    }
  }

  const paint = makePainter(tui.color)
  const io = createTerminalIo({
    paint,
    // Read live: an entry submitted this session must be recallable on the next
    // composer read, not just the ones loaded at launch.
    history: () => history,
    columns: () => process.stdout.columns || 80,
    // Ctrl-X Ctrl-E in the composer, same editor hand-off plan review uses.
    editText: (initial) => editInEditor(initial, 'MESSAGE.md'),
    completer: makeCompleter((q) => findFiles(tui.cwd, q))
  })

  // spawn_session + scheduled runs work in the TUI too: background sessions run
  // in-process (non-interactively) and schedules fire while the TUI is open.
  const sessions = wireTerminalSessionBackends({
    notify: (m) => io.out(paint(`\n· ${m}\n`, 'dim')),
    startScheduler: true
  })

  let code = 1
  try {
    code = await runTui(tui, {
      getSettings,
      // Real terminal width (re-read each turn) so status-line truncation and
      // markdown wrapping track the actual terminal, not a hardcoded 80 columns.
      columns: () => process.stdout.columns || 80,
      recordLegalAcceptance: () => {
        updateSettings({ legalAcceptedVersion: LEGAL_VERSION })
      },
      startRun,
      resolveApproval,
      resolveQuestion,
      resolvePlan,
      resolveElicitation,
      cancelRun,
      editText: (initial) => editInEditor(initial),
      persistHistory,
      loadImage: (p) => {
        const mediaType = mediaTypeForImagePath(p)
        if (!mediaType || !isSupportedImageType(mediaType)) {
          return { error: `unsupported image type (use ${SUPPORTED_IMAGE_TYPES.join(', ')})` }
        }
        try {
          const data = readFileSync(join(tui.cwd, p)).toString('base64')
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
      compact: (id, providerId, model) => compactConversationNow(id, providerId, model),
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
        create: ({ workspace, providerId, model }) =>
          createConversation({ workspace, providerId, model }),
        setMessages,
        // Keep the stored provider/model current after a `/model` switch or a `/resume`
        // (the GUI's per-send updateConversationMeta counterpart).
        setModel: (id, providerId, model) => updateConversationMeta(id, { providerId, model }),
        // Recent conversations for this folder, newest first, for the `/resume` picker.
        list: (workspace) =>
          listConversations()
            .filter((c) => c.workspace === workspace)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20)
            .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
        search: (workspace, query) =>
          searchConversations(query)
            .filter((c) => c.workspace === workspace)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20)
            .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
        fork: (id) => {
          const forked = forkConversation(id)
          return forked ? { id: forked.id } : null
        },
        get: (id) => {
          const conv = getConversation(id)
          return conv ? { messages: conv.messages } : null
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
    killAllShells()
    disconnectAllMcp()
  }
  return code
}

/** Run the one-shot headless client to completion. Returns the exit code. */
export async function runHeadlessEntry(headless: HeadlessOptions): Promise<number> {
  // spawn_session works headless too: children run concurrently in this process
  // and are awaited below so the one-shot exit doesn't kill them mid-run. The
  // scheduler backend is wired without starting timers — a headless run can
  // create/list/cancel schedules, which then fire in a long-lived host (GUI/TUI).
  const sessions = wireTerminalSessionBackends({
    notify: (m) => process.stderr.write(`· ${m}\n`),
    startScheduler: false
  })
  let code = 1
  try {
    code = await runHeadless(headless, {
      getSettings,
      recordLegalAcceptance: () => {
        updateSettings({ legalAcceptedVersion: LEGAL_VERSION })
      },
      startRun,
      resolveApproval,
      resolveQuestion,
      resolvePlan,
      resolveElicitation,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
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
          return conv ? { id: conv.id, messages: conv.messages } : null
        },
        create: ({ workspace, providerId, model }) =>
          createConversation({ workspace, providerId, model }),
        setMessages,
        // Keep a resumed conversation's stored model in step with the model this
        // run actually used, so usage attribution and a GUI re-open don't diverge.
        setModel: (id, providerId, model) => updateConversationMeta(id, { providerId, model })
      }
    })
    // Don't let the one-shot exit tear down sessions the run spawned; their
    // conversations persist, so a later --resume can pick each one up.
    const outstanding = sessions.pendingBackgroundSessions()
    if (outstanding > 0) {
      process.stderr.write(
        `· waiting for ${outstanding} background session${outstanding === 1 ? '' : 's'} to finish…\n`
      )
      await sessions.waitForBackgroundSessions()
    }
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  } finally {
    killAllShells()
    disconnectAllMcp()
  }
  return code
}

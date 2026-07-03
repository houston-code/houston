import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEGAL_VERSION } from '@shared/legal'
import {
  isSupportedImageType,
  exceedsImageSizeLimit,
  SUPPORTED_IMAGE_TYPES
} from '@shared/images'
import { startRun, resolveApproval, resolveQuestion, cancelRun } from './agent/loop'
import { killAllShells } from './agent/shells'
import { disconnectAllMcp } from './mcp/manager'
import { findFiles } from './agent/mentions'
import { loadSkills } from './agent/skills'
import { loadAgents } from './agent/agents'
import { getSettings, updateSettings } from './store'
import { getUserDataDir } from './userData'
import { log } from './logger'
import { runTui, makePainter, mediaTypeForImagePath, type TuiOptions } from './tui'
import { runHeadless, type HeadlessOptions } from './headless'
import { createTerminalIo, resolveColor } from './tui-io'
import { makeCompleter } from './tui-complete'
import { parseHistory, serializeHistory, appendHistory } from './tui-history'
import {
  createConversation,
  setMessages,
  listConversations,
  getConversation,
  searchConversations,
  forkConversation
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
  const { highlightToHtml } = await import('./syntax')
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

  let code = 1
  try {
    code = await runTui(tui, {
      getSettings,
      recordLegalAcceptance: () => {
        updateSettings({ legalAcceptedVersion: LEGAL_VERSION })
      },
      startRun,
      resolveApproval,
      resolveQuestion,
      cancelRun,
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
      io: createTerminalIo({
        paint: makePainter(tui.color),
        history,
        completer: makeCompleter((q) => findFiles(tui.cwd, q))
      }),
      highlightHtml: (lang, codeStr) => highlightToHtml(hljs, lang, codeStr),
      persist: {
        create: ({ workspace, providerId, model }) =>
          createConversation({ workspace, providerId, model }),
        setMessages,
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
        setMessages
      }
    })
  } catch (e) {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`)
  } finally {
    killAllShells()
    disconnectAllMcp()
  }
  return code
}

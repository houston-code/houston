import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ShellCapture } from './userShell'
import { parseStatusLineConfig, type StatusLineConfig } from '@shared/statusLine'

/**
 * A custom status line for the terminal: the `statusLine` setting names a command,
 * Houston runs it in the user's shell with a JSON description of the session on
 * stdin, and the first lines it prints replace the built-in status line above the
 * composer.
 *
 * It is the user's own command, so it runs as their `!` escape does (their shell,
 * unsandboxed). A project's `.houston/settings.json` may name one too, but that file
 * is the repository's, so its command runs only once the folder is trusted, and it is
 * part of what the trust decision fingerprints (projectConfig.ts).
 *
 * The output is held to what a status line can safely be: a few lines, a few
 * kilobytes, colour codes (SGR) only. Every other escape (cursor moves, erases, titles,
 * clipboard writes) is removed, since the lines are redrawn in place and anything that
 * moves the cursor would wreck the composer under them. A slow command is stopped at
 * the timeout and the last good output stays up.
 */

export { parseStatusLineConfig, type StatusLineConfig } from '@shared/statusLine'

/** Lines of the command's output shown. */
export const STATUS_LINE_MAX_LINES = 3
/** Output read from the command; the rest is dropped. */
export const STATUS_LINE_MAX_BYTES = 8 * 1024
/** How long the command may run before it is stopped. */
export const STATUS_LINE_TIMEOUT_MS = 1000

/** Which status line command applies, and where it came from. */
export type ResolvedStatusLine = StatusLineConfig & { source: 'user' | 'project' }

/**
 * The user's own command wins; a project's applies only when the folder is trusted.
 * `projectTrusted` is asked only when it matters (it reads the project's config).
 */
export function resolveStatusLine(
  user: unknown,
  project: StatusLineConfig | null | undefined,
  projectTrusted: () => boolean
): ResolvedStatusLine | null {
  const mine = parseStatusLineConfig(user)
  if (mine) return { ...mine, source: 'user' }
  if (project && projectTrusted()) return { ...project, source: 'project' }
  return null
}

/** What the command reads on stdin, as one JSON object. */
export interface StatusLinePayload {
  version: string | null
  sessionId: string | null
  title: string | null
  provider: string | null
  model: string | null
  effort: string
  approvalMode: string
  cwd: string
  branch: string | null
  /** The worktree's root when the folder is a linked git worktree, else null. */
  worktree: string | null
  /** How full the context window is, 0-100, or null before a turn or for an unknown window. */
  contextPercent: number | null
  contextTokens: number
  cost: { usd: number; inputTokens: number; outputTokens: number; unknown: boolean }
  vimMode: 'insert' | 'normal' | null
}

/** Every payload field, described, for /statusline. */
export const STATUS_LINE_FIELDS: ReadonlyArray<{ name: string; about: string }> = [
  { name: 'version', about: "Houston's version" },
  { name: 'sessionId', about: "the chat's id (null before the first message)" },
  { name: 'title', about: "the chat's title" },
  { name: 'provider', about: 'provider id' },
  { name: 'model', about: 'model id' },
  { name: 'effort', about: 'reasoning effort' },
  { name: 'approvalMode', about: 'ask, auto-edit, full-auto or plan' },
  { name: 'cwd', about: 'the working folder' },
  { name: 'branch', about: 'the checked-out git branch' },
  { name: 'worktree', about: "the worktree's folder when this is a linked git worktree" },
  { name: 'contextPercent', about: 'how full the context window is, 0 to 100' },
  { name: 'contextTokens', about: 'tokens in the context window' },
  { name: 'cost', about: 'this session: usd, inputTokens, outputTokens, unknown' },
  { name: 'vimMode', about: 'insert or normal with vim keys on, else null' }
]

/**
 * The root of the linked git worktree `cwd` is in, or null when it is in a main
 * checkout or no repository: a linked worktree's `.git` is a file pointing at the
 * main repository, where a main checkout's is a directory.
 */
export function linkedWorktreeRoot(cwd: string, stat: (p: string) => { isFile(): boolean } | null = safeStat): string | null {
  let dir = cwd
  for (let i = 0; i < 64; i++) {
    const st = stat(join(dir, '.git'))
    if (st) return st.isFile() ? dir : null
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function safeStat(p: string): { isFile(): boolean } | null {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

const ESC = String.fromCharCode(27)
// A whole escape sequence: CSI (ESC [ params intermediates final), OSC up to BEL or
// ST, and any other two-character ESC sequence.
const ESCAPE_SEQ = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)?|${ESC}[PX^_][^${ESC}]*(?:${ESC}\\\\)?|${ESC}.?`,
  'g'
)
const SGR_ONLY = new RegExp(`^${ESC}\\[[0-9;:]*m$`)

/**
 * The command's output as status rows: its first {@link STATUS_LINE_MAX_LINES} lines
 * (trailing blank lines dropped), with colour codes kept and every other escape
 * sequence and control character removed. Empty when it printed nothing visible.
 */
export function sanitizeStatusOutput(stdout: string): string[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n').slice(0, STATUS_LINE_MAX_LINES + 1)
  const rows = lines.slice(0, STATUS_LINE_MAX_LINES).map((line) => {
    const kept = line.replace(ESCAPE_SEQ, (seq) => (SGR_ONLY.test(seq) ? seq : ''))
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const clean = kept.replace(/\t/g, ' ').replace(/[\x00-\x1a\x1c-\x1f\x7f-\x9f]/g, '')
    // An ESC left over is the start of an SGR code; any other is gone above. A row
    // that set a colour is reset at its end, so it can't bleed into the prompt.
    return clean.includes(`${ESC}[`) ? `${clean}${ESC}[0m` : clean
  })
  while (rows.length && !visible(rows[rows.length - 1])) rows.pop()
  return rows.some(visible) ? rows : []
}

function visible(row: string): boolean {
  return row.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g'), '').trim().length > 0
}

/** Runs the command (in the user's shell, with `input` on stdin). */
export type StatusLineExec = (
  command: string,
  input: string,
  opts: { timeoutMs: number; maxBytes: number }
) => Promise<ShellCapture>

/** Why the last run didn't produce rows, for /statusline. */
export type StatusLineFailure = { at: number; reason: string } | null

/**
 * Runs the status line command and keeps its last good output. One run at a time: a
 * refresh asked for while one is running runs once more after it, with the newest
 * payload. A run that fails, times out or prints nothing keeps the previous rows.
 */
export class StatusLineRunner {
  private rows: string[] = []
  private running: Promise<void> | null = null
  private queued: string | null = null
  private lastInput: string | null = null
  private failure: StatusLineFailure = null

  constructor(
    readonly config: ResolvedStatusLine,
    private readonly exec: StatusLineExec,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  /** The last good rows (empty until a run has printed something). */
  lines(): string[] {
    return this.rows
  }

  /** Why the last run left the rows as they were, or null after a good run. */
  lastFailure(): StatusLineFailure {
    return this.failure
  }

  /** Run it with `payload`; resolves when this refresh (or the one it joined) is done. */
  refresh(payload: StatusLinePayload): Promise<void> {
    const input = JSON.stringify(payload)
    if (this.running) {
      this.queued = input
      return this.running
    }
    this.running = this.runLoop(input).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runLoop(first: string): Promise<void> {
    let input: string | null = first
    while (input !== null) {
      this.queued = null
      await this.runOnce(input)
      input = this.queued
    }
  }

  private async runOnce(input: string): Promise<void> {
    this.lastInput = input
    let got: ShellCapture
    try {
      got = await this.exec(this.config.command, `${input}\n`, {
        timeoutMs: STATUS_LINE_TIMEOUT_MS,
        maxBytes: STATUS_LINE_MAX_BYTES
      })
    } catch (e) {
      this.failure = { at: this.now(), reason: `could not run: ${(e as Error).message}` }
      return
    }
    if (got.timedOut) {
      this.failure = { at: this.now(), reason: `timed out after ${STATUS_LINE_TIMEOUT_MS / 1000}s` }
      return
    }
    if (got.exitCode !== 0) {
      this.failure = { at: this.now(), reason: `exited with code ${got.exitCode}` }
      return
    }
    const rows = sanitizeStatusOutput(got.stdout)
    if (!rows.length) {
      this.failure = { at: this.now(), reason: 'printed nothing' }
      return
    }
    this.failure = null
    const changed = rows.join('\n') !== this.rows.join('\n')
    this.rows = rows
    if (changed) this.onChange()
  }

  /** The payload of the last run, as sent (for tests). */
  lastPayload(): string | null {
    return this.lastInput
  }
}

/**
 * The loop's two hooks around a write-kind tool call, kept here so loop.ts only calls
 * them: before the write, remember the content of each target a language server
 * covers (the baseline post-edit diagnostics are diffed against); after it, bring the
 * running servers up to date with what the agent wrote and report what the edit broke.
 *
 * `diagnosticsOnSave` decides how much runs after a write:
 *  - unset (the default): language-server diagnostics for files a server covers, and
 *    nothing for other files;
 *  - true: the same, plus the command-line checker (diagnostics.ts) for files no server
 *    covers or whose server didn't answer in time;
 *  - false: no diagnostics at all (servers are still kept in sync for the lsp_* tools).
 */
import { promises as fs } from 'node:fs'
import { runPostEditDiagnostics } from '../diagnostics'
import { isSensitivePath } from '../sensitive-paths'
import { lspEditDiagnostics } from './diagnostics'
import type { LspManager } from './manager'

/** Most files a single write gets diagnostics for (an apply_patch can touch many). */
export const MAX_DIAGNOSED_FILES = 5

export interface WriteSeamTarget {
  /** The path as the tool call named it. */
  rel: string
  /** Its resolved absolute path. */
  abs: string
  /** The call deleted it (apply_patch's Delete File, a move's source). */
  deleted: boolean
}

/** The content of each covered target before the write; null for a file that doesn't exist yet. */
export async function captureBeforeWrite(
  manager: Pick<LspManager, 'covers'>,
  targets: WriteSeamTarget[],
  roots: string[],
  diagnosticsOnSave: boolean | undefined
): Promise<Map<string, string | null>> {
  const before = new Map<string, string | null>()
  if (diagnosticsOnSave === false) return before
  for (const t of targets.slice(0, MAX_DIAGNOSED_FILES)) {
    // A credential file's edit result hides its lines (see isSensitivePath), and a
    // diagnostic can quote them, so it gets no language-server report.
    if (t.deleted || isSensitivePath(t.rel) || !manager.covers(t.abs, roots)) continue
    try {
      before.set(t.abs, await fs.readFile(t.abs, 'utf8'))
    } catch {
      before.set(t.abs, null)
    }
  }
  return before
}

export interface AfterWriteOptions {
  manager: Pick<LspManager, 'clientFor' | 'noteWrite'>
  targets: WriteSeamTarget[]
  roots: string[]
  workspace: string
  /** From {@link captureBeforeWrite}. */
  before: Map<string, string | null>
  diagnosticsOnSave: boolean | undefined
  signal?: AbortSignal
  /** Injectable for tests: the command-line checker fallback. */
  checker?: typeof runPostEditDiagnostics
  /** Injectable for tests: the language-server diagnostics. */
  lspDiagnostics?: typeof lspEditDiagnostics
}

/**
 * Sync the servers with the write, then collect diagnostics. Returns the text to append
 * to the tool result ('' when there's nothing to say). Best effort: never throws.
 */
export async function afterWrite(opts: AfterWriteOptions): Promise<string> {
  for (const t of opts.targets) {
    try {
      await opts.manager.noteWrite(t.abs, opts.roots)
    } catch {
      // Syncing is best effort; the tools re-sync from disk before each request.
    }
  }
  if (opts.diagnosticsOnSave === false) return ''
  const lsp = opts.lspDiagnostics ?? lspEditDiagnostics
  const checker = opts.checker ?? runPostEditDiagnostics
  let out = ''
  for (const t of opts.targets.filter((x) => !x.deleted).slice(0, MAX_DIAGNOSED_FILES)) {
    try {
      let lspRan = false
      if (opts.before.has(t.abs)) {
        const r = await lsp({
          manager: opts.manager,
          abs: t.abs,
          rel: t.rel,
          roots: opts.roots,
          before: opts.before.get(t.abs) ?? null,
          signal: opts.signal
        })
        lspRan = r.ran
        if (r.block) out += r.block
      }
      if (!lspRan && opts.diagnosticsOnSave === true) {
        const r = await checker(t.rel, { workspace: opts.workspace, roots: opts.roots, signal: opts.signal })
        if (r.block) out += r.block
      }
    } catch {
      // Diagnostics are best-effort feedback; never fail the edit.
    }
  }
  return out
}

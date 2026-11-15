import {
  fileDiffSignature,
  parseHunkHeader,
  revertQuestion,
  type ChangeRevertRequest,
  type ChangeRevertResult,
  type ChangesScope
} from '@shared/changes'
import type { DiffLine } from '@shared/diff'
import type { FileDiff } from '@shared/workingTree'
import type { Painter } from './tui'
import { renderDiffLines } from './tui-diff'
import { terminalText } from './tui-wrap'

/**
 * The terminal's `/changes` (alias `/diff`): the desktop Changes view's three scopes
 * and its whole-file revert, as commands.
 *
 *   /changes [turn|chat|tree]            the files in that scope (tree by default)
 *   /changes [turn|chat|tree] <path>     one file's diff
 *   /changes [turn|chat|tree] revert <path>   put one file back, after a y/N
 *
 * Every revert goes through the same main-process `revertChange` the desktop uses,
 * with the signature of the diff this command just printed, so a file that changed
 * between the printout and the "y" is refused rather than discarded unseen.
 */

/** What `/changes` was asked to do. */
export type ChangesOp =
  | { op: 'summary'; scope: ChangesScope }
  | { op: 'show'; scope: ChangesScope; path: string }
  | { op: 'revert'; scope: ChangesScope; path: string }

const SCOPE_WORDS: Record<string, ChangesScope> = { turn: 'turn', chat: 'chat', tree: 'tree' }

/** Parse what follows `/changes`. A path that is literally `turn` can be given as `./turn`. */
export function parseChangesArgs(arg: string): ChangesOp {
  let rest = arg.trim()
  let scope: ChangesScope = 'tree'
  let scoped = false
  let revert = false
  // Up to one scope word and one `revert`, in either order.
  for (let i = 0; i < 2; i++) {
    const m = /^(\S+)(?:\s+|$)/.exec(rest)
    if (!m) break
    const word = m[1].toLowerCase()
    if (Object.hasOwn(SCOPE_WORDS, word) && !scoped) {
      scope = SCOPE_WORDS[word]
      scoped = true
    } else if (word === 'revert' && !revert) {
      revert = true
    } else break
    rest = rest.slice(m[0].length)
  }
  const path = rest.trim()
  if (revert) return { op: 'revert', scope, path }
  if (path) return { op: 'show', scope, path }
  return { op: 'summary', scope }
}

/** One scope's change set, as `/changes` loads it. */
export interface ChangeSet {
  /** False only for the tree scope in a folder that is not a git repository. */
  isRepo: boolean
  branch: string | null
  files: FileDiff[]
  added: number
  removed: number
  /** Chat scopes: turns that changed files whose snapshots are gone. */
  unavailable?: number
}

/** What the entry point supplies: the desktop's own loaders and revert. */
export interface ChangesDeps {
  /** The tree scope ignores `conversationId`; the chat scopes are only asked with one. */
  load: (scope: ChangesScope, conversationId: string | null) => Promise<ChangeSet>
  /** `revertChange` for this session's folder. */
  revert: (req: Omit<ChangeRevertRequest, 'workspace'>) => Promise<ChangeRevertResult>
}

const STATUS_WORD: Record<string, string> = {
  added: 'new file',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  modified: 'modified'
}

function statusMark(status: string, paint: Painter): string {
  return status === 'added'
    ? paint('A', 'green')
    : status === 'deleted'
      ? paint('D', 'red')
      : status === 'renamed'
        ? paint('R', 'magenta')
        : status === 'untracked'
          ? paint('?', 'green')
          : paint('M', 'yellow')
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The file list of one scope, with each file's status and lines gained and lost. */
export function renderChangeSummary(
  scope: ChangesScope,
  set: Pick<ChangeSet, 'isRepo' | 'branch' | 'added' | 'removed' | 'unavailable'> & {
    files: { path: string; status: string; added: number; removed: number }[]
  },
  paint: Painter,
  opts: { hint?: boolean } = {}
): string {
  if (scope === 'tree' && !set.isRepo) {
    return paint('· not a git repository, so there is nothing to compare against (/changes chat works without git)', 'dim')
  }
  const gone = set.unavailable
    ? paint(`  ${plural(set.unavailable, 'earlier turn')} changed files whose snapshots were cleared, so they are left out`, 'dim')
    : null
  if (!set.files.length) {
    const empty =
      scope === 'tree'
        ? '· no changes in the working tree'
        : scope === 'turn'
          ? '· the latest turn changed no files'
          : '· this chat has changed no files'
    return [paint(empty, 'dim'), ...(gone ? [gone] : [])].join('\n')
  }
  const head = paint(
    scope === 'tree'
      ? `Changes${set.branch ? ` on ${terminalText(set.branch, { lines: false })}` : ''}:`
      : scope === 'turn'
        ? "Changed by this chat's latest turn:"
        : 'Changed by this chat:',
    'bold'
  )
  const paths = set.files.map((f) => terminalText(f.path, { lines: false }))
  const width = Math.max(...paths.map((p) => p.length))
  const rows = set.files.map((f, i) => {
    const stat = `${paint(`+${f.added}`, 'green')} ${paint(`-${f.removed}`, 'red')}`
    return `  ${statusMark(f.status, paint)} ${paths[i].padEnd(width)}  ${stat}`
  })
  const total = paint(`  ${plural(set.files.length, 'file')}, +${set.added} -${set.removed}`, 'dim')
  const scopeArg = scope === 'tree' ? '' : `${scope} `
  const hint = opts.hint
    ? [paint(`  /changes ${scopeArg}<path> shows a file's diff; /changes ${scopeArg}revert <path> puts it back`, 'dim')]
    : []
  return [head, ...rows, total, ...(gone ? [gone] : []), ...hint].join('\n')
}

/**
 * A file's hunks as one line list for {@link renderDiffLines}, with a `skip` marker
 * for the unchanged lines before and between hunks, so the gutter shows the file's
 * real line numbers rather than counting from the first hunk.
 */
export function fileDiffLines(file: FileDiff): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  for (const h of file.hunks) {
    const p = parseHunkHeader(h.header)
    if (p) {
      // A hunk with no old lines (`-5,0`) inserts after line 5.
      const first = p.oldCount === 0 ? p.oldStart + 1 : Math.max(p.oldStart, 1)
      const gap = first - 1 - oldNo
      if (gap > 0) {
        out.push({ type: 'skip', text: `${plural(gap, 'unchanged line')}`, count: gap })
        oldNo += gap
      }
    }
    for (const l of h.lines) {
      out.push(l)
      if (l.type === 'ctx' || l.type === 'del') oldNo++
    }
  }
  return out
}

/** Lines one file's diff may take: more than an approval preview, since you asked for it. */
export const CHANGES_FILE_MAX_LINES = 200

/** One file's diff: a header naming it, then its hunks with numbers and word marks. */
export function renderFileDiff(
  file: FileDiff,
  paint: Painter,
  opts: { highlight?: (lang: string, code: string) => string; maxLines?: number } = {}
): string {
  const path = terminalText(file.path, { lines: false })
  const tag =
    file.status === 'renamed' && file.oldPath
      ? ` (renamed from ${terminalText(file.oldPath, { lines: false })})`
      : file.status === 'modified'
        ? ''
        : ` (${STATUS_WORD[file.status] ?? file.status})`
  const stat = `${paint(`+${file.added}`, 'green')} ${paint(`-${file.removed}`, 'red')}`
  const head = `  ${paint(path, 'cyan', 'bold')}${paint(tag, 'dim')}  ${stat}`
  if (file.note) return `${head}\n  ${paint(terminalText(file.note, { lines: false }), 'dim')}`
  if (!file.hunks.length) return `${head}\n  ${paint('no line changes to show', 'dim')}`
  const lang = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : ''
  const hl = opts.highlight && lang ? (code: string) => opts.highlight!(lang, code) : undefined
  const body = renderDiffLines(fileDiffLines(file), paint, {
    maxLines: opts.maxLines ?? CHANGES_FILE_MAX_LINES,
    ...(hl ? { highlight: hl } : {})
  })
  return [head, ...body].join('\n')
}

/** The changed file a typed path names: exact, then by unique trailing path. */
export function findChangedFile(
  files: FileDiff[],
  query: string
): { file: FileDiff } | { ambiguous: FileDiff[] } | null {
  const q = query.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!q) return null
  const exact = files.find((f) => f.path === q) ?? files.find((f) => f.oldPath === q)
  if (exact) return { file: exact }
  const tail = files.filter((f) => f.path.endsWith(`/${q}`))
  if (tail.length === 1) return { file: tail[0] }
  if (tail.length > 1) return { ambiguous: tail }
  return null
}

export interface ChangesContext {
  deps?: ChangesDeps
  /** The saved chat, or null before its first message (the chat scopes need one). */
  conversationId: string | null
  out: (text: string) => void
  /** Ask a question and return the typed answer (null on end of input). */
  ask: (prompt: string) => Promise<string | null>
  paint: Painter
  highlight?: (lang: string, code: string) => string
}

/** Run a parsed `/changes`: print a scope, print a file, or revert one after a y/N. */
export async function runChangesCommand(op: ChangesOp, ctx: ChangesContext): Promise<void> {
  const { paint, out } = ctx
  if (!ctx.deps) {
    out(paint('· changes are unavailable here\n', 'dim'))
    return
  }
  if (op.scope !== 'tree' && !ctx.conversationId) {
    out(paint(`· this chat has no turns yet, so /changes ${op.scope} has nothing to show\n`, 'dim'))
    return
  }
  if (op.op === 'revert' && !op.path) {
    out(paint('· usage: /changes [turn|chat] revert <path>\n', 'dim'))
    return
  }
  let set: ChangeSet
  try {
    set = await ctx.deps.load(op.scope, ctx.conversationId)
  } catch (e) {
    out(paint(`· couldn't read the changes: ${(e as Error).message}\n`, 'yellow'))
    return
  }
  if (op.op === 'summary') {
    out(`${renderChangeSummary(op.scope, set, paint, { hint: true })}\n`)
    return
  }
  if (op.scope === 'tree' && !set.isRepo) {
    out(`${renderChangeSummary(op.scope, set, paint)}\n`)
    return
  }
  const found = findChangedFile(set.files, op.path)
  if (!found) {
    const where = op.scope === 'tree' ? 'the working tree' : op.scope === 'turn' ? 'the latest turn' : 'this chat'
    out(paint(`· ${terminalText(op.path, { lines: false })} has no changes in ${where} (/changes ${op.scope === 'tree' ? '' : `${op.scope} `}lists them)\n`, 'yellow'))
    return
  }
  if ('ambiguous' in found) {
    const names = found.ambiguous.map((f) => `  ${terminalText(f.path, { lines: false })}`).join('\n')
    out(`${paint(`· ${terminalText(op.path, { lines: false })} matches more than one changed file; give more of the path:`, 'yellow')}\n${names}\n`)
    return
  }
  const file = found.file
  // The revert shows the diff too: what a "y" discards is on screen when it's typed.
  out(`${renderFileDiff(file, paint, ctx.highlight ? { highlight: ctx.highlight } : {})}\n`)
  if (op.op === 'show') return

  const answer = await ctx.ask(paint(`${revertQuestion(file, op.scope)} [y/N] `, 'yellow'))
  if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
    out(paint('· kept; nothing was reverted\n', 'dim'))
    return
  }
  const res = await ctx.deps.revert({
    scope: op.scope,
    // The tree scope takes it too, as the desktop sends it: a revert waits for the chat's run.
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    path: file.path,
    signature: fileDiffSignature(file)
  })
  if (!res.ok) {
    out(paint(`· ${res.error}\n`, 'yellow'))
    return
  }
  out(paint(`· reverted ${terminalText(file.path, { lines: false })}\n`, 'dim'))
}

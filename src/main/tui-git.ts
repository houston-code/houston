import type { BranchSync, GitActionResult, PrLookup, PrStatus } from '@shared/gitActions'
import { shipTurn, type InvokedTurn } from '@shared/promptInvocation'
import { chooseShipAction } from '@shared/shipAction'
import type { WorkingTreeChanges } from '@shared/workingTree'
import type { Painter } from './tui'
import { stripControlChars, terminalText } from './tui-wrap'

/**
 * The terminal's commit, push, ship, and pull-request commands: the desktop Changes
 * view's commit form, its Create PR (ship) button, and the composer's PR chip.
 *
 *   /commit [message]   stage every change and commit it, after a y/N; with no message
 *                       the chat's model suggests one (the form's Suggest message)
 *   /push               push the branch, or publish it on a first push
 *   /ship               hand the change off to the agent: the same request the
 *                       Changes view's ship button sends (Create PR, Publish, ...)
 *   /pr                 the branch's pull request, its state, and its CI checks
 *
 * Every git and gh call is the desktop's own main-process handler (agent/gitActions.ts),
 * so the terminal gets the same guards: repository hooks never run, a repository whose
 * own config could run a command is refused, a commit mid-merge is refused, and a push
 * only goes to a network remote.
 */

// Built-in names that yield to a custom command of the same name (shared, so the
// reserved-name check in both clients agrees).
export { YIELDS_TO_CUSTOM } from '@shared/commands'

export type GitOp = { op: 'commit'; message: string } | { op: 'push' } | { op: 'ship' } | { op: 'pr' }

/** The names this module answers, and what each parses to. */
export function parseGitCommand(name: string, arg: string): GitOp | null {
  switch (name) {
    case 'commit':
      return { op: 'commit', message: arg.trim() }
    case 'push':
      return { op: 'push' }
    case 'ship':
      return { op: 'ship' }
    case 'pr':
      return { op: 'pr' }
    default:
      return null
  }
}

/** The desktop's handlers, bound to this session's folder by the entry point. */
export interface GitDeps {
  tree: () => Promise<WorkingTreeChanges>
  sync: () => Promise<BranchSync | null>
  /** The chat's model (or the default one) writes a message for every uncommitted change. */
  suggest: (conversationId: string | null) => Promise<GitActionResult>
  commit: (message: string) => Promise<GitActionResult>
  push: () => Promise<GitActionResult>
  pr: () => Promise<PrLookup>
}

export interface GitContext {
  deps?: GitDeps
  conversationId: string | null
  out: (text: string) => void
  ask: (prompt: string) => Promise<string | null>
  paint: Painter
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const oneLine = (s: string): string => terminalText(s, { lines: false })

/** What a commit would take in: each file with its status mark and line counts. */
export function renderCommitFiles(tree: WorkingTreeChanges, paint: Painter): string {
  const mark: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', untracked: '?', modified: 'M' }
  const paths = tree.files.map((f) => oneLine(f.path))
  const width = Math.max(...paths.map((p) => p.length))
  const rows = tree.files.map(
    (f, i) => `  ${paint(mark[f.status] ?? 'M', 'yellow')} ${paths[i].padEnd(width)}  ${paint(`+${f.added}`, 'green')} ${paint(`-${f.removed}`, 'red')}`
  )
  const head = paint(`Commit${tree.branch ? ` on ${oneLine(tree.branch)}` : ''}:`, 'bold')
  return [head, ...rows, paint(`  ${plural(tree.files.length, 'file')}, +${tree.added} -${tree.removed}`, 'dim')].join('\n')
}

/** Whether the desktop would offer Push for this branch state. */
export function canPush(sync: BranchSync | null): boolean {
  return Boolean(sync?.branch && sync.ahead > 0 && (sync.upstream || sync.remote))
}

const STATE_WORD: Record<PrStatus['state'], string> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' }
const RUN_MARK = { passing: '✓', failing: '✕', pending: '◐' } as const
const RUN_TONE = { passing: 'green', failing: 'red', pending: 'yellow' } as const

/** `/pr`: the pull request, its state, and its checks (each one, failing first). */
export function renderPr(lookup: PrLookup, paint: Painter, branch: string | null): string {
  if (lookup.kind === 'unavailable') {
    return paint(
      '· no pull request status here: it needs the gh command installed and signed in, and a GitHub remote',
      'dim'
    )
  }
  if (lookup.kind === 'none') {
    return paint(`· no pull request for ${branch ? oneLine(branch) : 'this branch'} yet; /ship opens one`, 'dim')
  }
  const pr = lookup.pr
  const state = pr.isDraft && pr.state === 'OPEN' ? 'draft' : STATE_WORD[pr.state]
  const tone = pr.state === 'MERGED' ? 'magenta' : pr.state === 'CLOSED' ? 'red' : 'green'
  const lines = [
    `${paint(`Pull request #${pr.number}`, 'bold')} ${paint(`(${state})`, tone)} ${oneLine(stripControlChars(pr.title))}`,
    `  ${paint(pr.url, 'cyan')}`
  ]
  const { passing, failing, pending } = pr.counts
  const parts = [
    failing ? paint(`${failing} failing`, 'red') : '',
    pending ? paint(`${pending} running`, 'yellow') : '',
    passing ? paint(`${passing} passed`, 'green') : ''
  ].filter(Boolean)
  lines.push(`  Checks: ${parts.length ? parts.join(', ') : paint('none', 'dim')}`)
  const order = { failing: 0, pending: 1, passing: 2 }
  const runs = [...(pr.runs ?? [])].sort((a, b) => order[a.outcome] - order[b.outcome])
  for (const r of runs) {
    lines.push(`    ${paint(RUN_MARK[r.outcome], RUN_TONE[r.outcome])} ${oneLine(stripControlChars(r.name))}`)
  }
  return lines.join('\n')
}

/** Run a parsed git command. Returns the turn to send for `/ship`, else null. */
export async function runGitCommand(op: GitOp, ctx: GitContext): Promise<InvokedTurn | null> {
  const { paint, out, deps } = ctx
  if (!deps) {
    out(paint('· git commands are unavailable here\n', 'dim'))
    return null
  }
  try {
    switch (op.op) {
      case 'commit':
        await commit(op.message, deps, ctx)
        return null
      case 'push':
        await push(deps, ctx)
        return null
      case 'pr': {
        const [lookup, sync] = await Promise.all([deps.pr(), deps.sync()])
        out(`${renderPr(lookup, paint, sync?.branch ?? null)}\n`)
        return null
      }
      case 'ship': {
        const tree = await deps.tree()
        if (!tree.isRepo) {
          out(paint('· not a git repository, so there is nothing to ship\n', 'dim'))
          return null
        }
        if (!tree.files.length) {
          out(paint('· no uncommitted changes to ship\n', 'dim'))
          return null
        }
        return shipTurn(chooseShipAction(tree.ship))
      }
    }
  } catch (e) {
    out(paint(`· ${(e as Error).message}\n`, 'yellow'))
    return null
  }
}

async function commit(given: string, deps: GitDeps, ctx: GitContext): Promise<void> {
  const { paint, out } = ctx
  const tree = await deps.tree()
  if (!tree.isRepo) {
    out(paint('· not a git repository, so there is nothing to commit\n', 'dim'))
    return
  }
  if (!tree.files.length) {
    const sync = await deps.sync()
    out(
      paint(
        canPush(sync) ? `· nothing to commit; ${plural(sync!.ahead, 'commit')} not pushed yet (/push sends them)\n` : '· nothing to commit\n',
        'dim'
      )
    )
    return
  }
  let message = given
  if (!message) {
    out(paint("· asking the chat's model for a commit message…\n", 'dim'))
    const s = await deps.suggest(ctx.conversationId)
    if (!s.ok || !s.detail) {
      out(paint(`· ${s.ok ? 'The model returned no message.' : s.error} Give one: /commit <message>\n`, 'yellow'))
      return
    }
    message = s.detail
  }
  out(`${renderCommitFiles(tree, paint)}\n`)
  const shown = stripControlChars(message)
    .split('\n')
    .map((l) => `  ${paint(l, 'cyan')}`)
    .join('\n')
  out(`${paint('Message:', 'bold')}\n${shown}\n`)
  const answer = await ctx.ask(
    paint(`Stage and commit ${tree.files.length === 1 ? 'this file' : `these ${tree.files.length} files`}? Repository hooks don't run. [y/N] `, 'yellow')
  )
  if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
    out(paint('· not committed\n', 'dim'))
    return
  }
  const r = await deps.commit(message)
  if (!r.ok) {
    out(paint(`· ${r.error}\n`, 'yellow'))
    return
  }
  const sync = await deps.sync().catch(() => null)
  const where = sync?.branch ? ` on ${oneLine(sync.branch)}` : ''
  out(paint(`· committed${r.detail ? ` ${oneLine(r.detail)}` : ''}${where}${canPush(sync) ? '; /push sends it' : ''}\n`, 'green'))
}

async function push(deps: GitDeps, ctx: GitContext): Promise<void> {
  const { paint, out } = ctx
  const sync = await deps.sync()
  if (!sync) {
    out(paint('· not a git repository, so there is nothing to push\n', 'dim'))
    return
  }
  if (!sync.branch) {
    out(paint('· check out a branch before pushing\n', 'yellow'))
    return
  }
  if (!sync.upstream && !sync.remote) {
    out(paint('· this repository has no remote to push to\n', 'dim'))
    return
  }
  if (!canPush(sync)) {
    out(paint(`· nothing to push: ${oneLine(sync.branch)} has no commits that ${oneLine(sync.upstream ?? sync.remote ?? 'the remote')} lacks\n`, 'dim'))
    return
  }
  const target = sync.upstream ? oneLine(sync.upstream) : `${oneLine(sync.remote ?? 'the remote')} (first push)`
  out(paint(`· pushing ${plural(sync.ahead, 'commit')} on ${oneLine(sync.branch)} to ${target}…\n`, 'dim'))
  const r = await deps.push()
  if (!r.ok) {
    out(paint(`· ${r.error}\n`, 'yellow'))
    return
  }
  out(paint(`· pushed to ${r.detail ? oneLine(r.detail) : target}\n`, 'green'))
}

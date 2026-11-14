/**
 * Turns raw tool calls into terse, human-readable rows and groups consecutive
 * tool activity together — so a run of eight `read_file`s reads as a compact list
 * instead of eight fat cards. Pure logic, unit-tested; the rendering lives in
 * `ToolGroup.tsx`.
 */
import type {
  AssistantItem,
  DisplayItem,
  ElicitationItem,
  NoticeItem,
  PlanItem,
  QuestionItem,
  ReceiptItem,
  ToolItem,
  UserItem
} from './items'
import { PROPOSE_SESSION_TOOL } from '@shared/constants'
import { describeToolCall, type ToolDescription } from '@shared/toolLabel'
import { shortenPath } from './paths'

export { shortenPath }

export type { ToolDescription } from '@shared/toolLabel'

/** A concise verb + target for a tool call, used in the compact row. */
export function describeTool(item: ToolItem): ToolDescription {
  return describeToolCall(item.name, item.args, { summary: item.summary, shorten: shortenPath })
}

// ---- What an approval asks ------------------------------------------------

/**
 * Tools whose one-line header already names the whole request (a path, a pattern, a
 * URL, a PR number), or whose row shows the rest inline (a plan's list, a gallery).
 */
const HEADER_SAYS_ALL = new Set([
  'read_file',
  'list_dir',
  'glob',
  'git_status',
  'git_diff',
  'search_files',
  'ast_grep',
  'read_shell_output',
  'kill_shell',
  'web_fetch',
  'view_localhost',
  'web_search',
  'todo_write',
  'pr_sweep',
  'show_images',
  'render_mockup',
  'review_changes',
  'gh_pr_list',
  'gh_pr_view',
  'gh_pr_checks',
  'gh_pr_checkout',
  'gh_issue_list',
  'gh_issue_view',
  'gh_run_list',
  'gh_run_view',
  'list_scheduled_runs',
  'cancel_scheduled_run',
  'recall_history',
  'recall_memory',
  'memory_delete',
  'skill'
])

/** A GitHub write's long-form text (a body, a comment), shown after its other fields. */
const GH_TEXT_FIELDS = new Set(['body', 'comment'])

/** "delete_branch" as "Delete branch". */
function fieldLabel(key: string): string {
  const words = key.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A GitHub write's fields, one per line ("Title: Fix the parser"), then its body or
 * comment in full. The PR or issue number is left out: the header already shows it.
 */
function ghRequestText(args: Record<string, unknown>): string | null {
  const fields: string[] = []
  const texts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (key === 'number' || value === undefined || value === null || value === '') continue
    if (GH_TEXT_FIELDS.has(key) && typeof value === 'string') {
      texts.push(value)
      continue
    }
    const shown =
      typeof value === 'string' ? value : typeof value === 'boolean' ? (value ? 'yes' : 'no') : JSON.stringify(value)
    fields.push(`${fieldLabel(key)}: ${shown}`)
  }
  const parts = [fields.join('\n'), ...texts].filter((p) => p.trim() !== '')
  return parts.length > 0 ? parts.join('\n\n') : null
}

/**
 * What an approval card spells out under its one-line header, as plain text: the
 * whole command for a shell call, the title and text a GitHub write will post, and
 * the arguments of an MCP tool or any other tool whose header leaves something out.
 * Null when the header already says it all, or when the row shows the change as a
 * diff (`hasDiff`).
 */
export function approvalRequestText(item: ToolItem, opts: { hasDiff: boolean }): string | null {
  if (opts.hasDiff) return null
  const args = item.args ?? {}
  if (item.name === 'run_shell') {
    return typeof args.command === 'string' && args.command.trim() ? args.command : null
  }
  if (HEADER_SAYS_ALL.has(item.name)) return null
  if (item.name.startsWith('gh_')) return ghRequestText(args)
  return Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : null
}

// ---- Grouping ------------------------------------------------------------

export type RenderNode =
  | { kind: 'user'; id: string; item: UserItem }
  | { kind: 'assistant'; id: string; item: AssistantItem }
  | { kind: 'notice'; id: string; item: NoticeItem }
  | { kind: 'question'; id: string; item: QuestionItem }
  | { kind: 'plan'; id: string; item: PlanItem }
  | { kind: 'elicitation'; id: string; item: ElicitationItem }
  | { kind: 'receipt'; id: string; item: ReceiptItem }
  | { kind: 'toolgroup'; id: string; items: ToolItem[] }
  /** A propose_session call that became a card (its own node, not a tool row). */
  | { kind: 'proposal'; id: string; item: ToolItem }

/** Tool names that are pure navigation noise and never get their own row. */
const HIDDEN_TOOLS = new Set(['list_dir'])

/** Whether a tool row is a `propose_session` call that became a card. */
export function isProposalCard(item: ToolItem): boolean {
  return (
    item.name === PROPOSE_SESSION_TOOL &&
    item.status === 'done' &&
    (item.output ?? '').startsWith('Proposed "')
  )
}

/**
 * Fold consecutive tool items into a single tool group, leaving text and notices
 * as standalone nodes. Grouping is what reclaims the vertical space. Navigation-
 * only tools (`list_dir`) are dropped outright — they tell the reader nothing the
 * surrounding reads and edits don't already imply.
 */
export function groupItems(items: DisplayItem[]): RenderNode[] {
  const nodes: RenderNode[] = []
  let group: ToolItem[] | null = null

  const flush = (): void => {
    if (group && group.length > 0) {
      nodes.push({ kind: 'toolgroup', id: `g-${group[0].id}`, items: group })
    }
    group = null
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      // Navigation-only tools are hidden as noise — UNLESS one is awaiting the
      // user's approval (a permission rule can force a prompt on any tool). Hiding
      // it then would leave the run wedged on a prompt that renders nothing.
      if (HIDDEN_TOOLS.has(item.name) && item.status !== 'awaiting-approval') continue
      // A proposal that went through renders as a card the user acts on. One that is
      // still running or was refused stays an ordinary tool row.
      if (isProposalCard(item)) {
        flush()
        nodes.push({ kind: 'proposal', id: item.id, item })
        continue
      }
      if (!group) group = []
      group.push(item)
      continue
    }
    flush()
    if (item.kind === 'user') nodes.push({ kind: 'user', id: item.id, item })
    else if (item.kind === 'assistant') nodes.push({ kind: 'assistant', id: item.id, item })
    else if (item.kind === 'notice') nodes.push({ kind: 'notice', id: item.id, item })
    else if (item.kind === 'question') nodes.push({ kind: 'question', id: item.id, item })
    else if (item.kind === 'plan') nodes.push({ kind: 'plan', id: item.id, item })
    else if (item.kind === 'elicitation') nodes.push({ kind: 'elicitation', id: item.id, item })
    else if (item.kind === 'receipt') nodes.push({ kind: 'receipt', id: item.id, item })
  }
  flush()
  return nodes
}

/**
 * A run of tool calls within a group: either a single tool (rendered with its own
 * diff/output) or a fold of consecutive `read_file` calls shown as "Read N files".
 */
export type ToolRun =
  | { kind: 'single'; id: string; item: ToolItem }
  | { kind: 'reads'; id: string; items: ToolItem[] }

/**
 * Collapse consecutive `read_file` calls inside a group into one aggregate run, so
 * a burst of reads renders as a single "Read N files" row instead of N rows. A lone
 * read stays a normal row, and every other tool — edits, shells, searches — keeps
 * its own row so its diff or output is never hidden behind a count. A read waiting
 * on the user's approval (a credential file always asks) keeps its own row too, since
 * that row holds the prompt the run is waiting on.
 */
export function foldReadRuns(items: ToolItem[]): ToolRun[] {
  const runs: ToolRun[] = []
  let reads: ToolItem[] | null = null

  const flush = (): void => {
    if (!reads) return
    if (reads.length >= 2) runs.push({ kind: 'reads', id: `r-${reads[0].id}`, items: reads })
    else runs.push({ kind: 'single', id: reads[0].id, item: reads[0] })
    reads = null
  }

  for (const item of items) {
    if (item.name === 'read_file' && item.status !== 'awaiting-approval') {
      if (!reads) reads = []
      reads.push(item)
      continue
    }
    flush()
    runs.push({ kind: 'single', id: item.id, item })
  }
  flush()
  return runs
}

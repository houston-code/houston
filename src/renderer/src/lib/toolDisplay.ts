/**
 * Turns raw tool calls into terse, human-readable rows and groups consecutive
 * tool activity together — so a run of eight `read_file`s reads as a compact list
 * instead of eight fat cards. Pure logic, unit-tested; the rendering lives in
 * `ToolGroup.tsx`.
 */
import type {
  AssistantItem,
  DisplayItem,
  NoticeItem,
  PlanItem,
  QuestionItem,
  ToolItem,
  UserItem
} from './items'

export interface ToolDescription {
  /** Short action label, e.g. "Read", "Run", "Search". */
  verb: string
  /** The thing acted on — a path, command, pattern or query. */
  target: string
  /** Render the target in a monospace font (paths/commands) vs prose (queries). */
  mono: boolean
}

/** Shorten a path to its last two segments, prefixed with an ellipsis. */
export function shortenPath(p: string, segments = 2): string {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length <= segments) return p
  return '…/' + parts.slice(-segments).join('/')
}

/** Collapse a shell command to a single trimmed line for the row. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ').trim()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A PR number (number or numeric string) rendered as "#N", or undefined. */
function prRef(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return `#${v}`
  if (typeof v === 'string' && v.trim()) return v.startsWith('#') ? v : `#${v}`
  return undefined
}

/** A concise verb + target for a tool call, used in the compact row. */
export function describeTool(item: ToolItem): ToolDescription {
  const a = item.args ?? {}
  const path = str(a.path)
  switch (item.name) {
    case 'read_file':
      return { verb: 'Read', target: path ? shortenPath(path) : item.summary ?? '', mono: true }
    case 'write_file':
      return { verb: 'Write', target: path ? shortenPath(path) : '', mono: true }
    case 'edit_file':
      return { verb: 'Edit', target: path ? shortenPath(path) : '', mono: true }
    case 'list_dir':
      return { verb: 'List', target: path ? shortenPath(path) : '.', mono: true }
    case 'glob':
      return { verb: 'Find', target: str(a.pattern) ?? '', mono: true }
    case 'search_files': {
      const pat = str(a.pattern) ?? ''
      const where = str(a.path)
      return { verb: 'Search', target: where ? `${pat} in ${shortenPath(where)}` : pat, mono: true }
    }
    case 'ast_grep': {
      const pat = str(a.pattern) ?? ''
      const where = str(a.path)
      return { verb: 'Structural search', target: where ? `${pat} in ${shortenPath(where)}` : pat, mono: true }
    }
    case 'run_shell':
      return { verb: 'Run', target: oneLine(str(a.command) ?? ''), mono: true }
    case 'read_shell_output':
      return { verb: 'Output', target: str(a.shell_id) ?? str(a.id) ?? '', mono: true }
    case 'kill_shell':
      return { verb: 'Kill', target: str(a.shell_id) ?? str(a.id) ?? '', mono: true }
    case 'web_fetch':
      return { verb: 'Fetch', target: str(a.url) ?? '', mono: true }
    case 'view_localhost':
      return { verb: 'View', target: str(a.url) ?? '', mono: true }
    case 'web_search':
      return { verb: 'Search web', target: str(a.query) ?? '', mono: false }
    case 'dispatch_agent':
      return { verb: 'Subagent', target: str(a.description) ?? 'research task', mono: false }
    case 'spawn_session':
      return { verb: 'Spawn session', target: str(a.title) ?? str(a.prompt) ?? '', mono: false }
    case 'review_changes': {
      const base = str(a.base)
      return { verb: 'Review', target: base ? `changes vs ${base}` : 'uncommitted changes', mono: false }
    }
    case 'todo_write':
      return { verb: 'Plan', target: '', mono: false }
    case 'pr_sweep':
      return { verb: 'PR sweep', target: str(a.mode) ?? '', mono: false }
    case 'gh_pr_create':
      return { verb: 'Open PR', target: str(a.title) ?? '', mono: false }
    case 'gh_pr_list':
      return { verb: 'List PRs', target: str(a.state) ?? 'open', mono: false }
    case 'gh_pr_view':
      return { verb: 'View PR', target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_pr_comment':
      return { verb: 'Comment PR', target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_pr_checkout':
      return { verb: 'Checkout PR', target: prRef(a.number) ?? '', mono: false }
    default:
      return { verb: item.name, target: item.summary ?? str(a.path) ?? str(a.url) ?? '', mono: true }
  }
}

// ---- Grouping ------------------------------------------------------------

export type RenderNode =
  | { kind: 'user'; id: string; item: UserItem }
  | { kind: 'assistant'; id: string; item: AssistantItem }
  | { kind: 'notice'; id: string; item: NoticeItem }
  | { kind: 'question'; id: string; item: QuestionItem }
  | { kind: 'plan'; id: string; item: PlanItem }
  | { kind: 'toolgroup'; id: string; items: ToolItem[] }

/** Tool names that are pure navigation noise and never get their own row. */
const HIDDEN_TOOLS = new Set(['list_dir'])

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
 * its own row so its diff or output is never hidden behind a count.
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
    if (item.name === 'read_file') {
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

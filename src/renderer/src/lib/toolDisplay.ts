/**
 * Turns raw tool calls into terse, human-readable rows and groups consecutive
 * tool activity together — so a run of eight `read_file`s reads as a compact list
 * instead of eight fat cards. Pure logic, unit-tested; the rendering lives in
 * `ToolGroup.tsx`.
 */
import type { AssistantItem, DisplayItem, NoticeItem, ToolItem, UserItem } from './items'

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
    case 'todo_write':
      return { verb: 'Plan', target: '', mono: false }
    default:
      return { verb: item.name, target: item.summary ?? str(a.path) ?? str(a.url) ?? '', mono: true }
  }
}

// ---- Grouping ------------------------------------------------------------

export type RenderNode =
  | { kind: 'user'; id: string; item: UserItem }
  | { kind: 'assistant'; id: string; item: AssistantItem }
  | { kind: 'notice'; id: string; item: NoticeItem }
  | { kind: 'toolgroup'; id: string; items: ToolItem[] }

/**
 * Fold consecutive tool items into a single tool group, leaving text and notices
 * as standalone nodes. Grouping is what reclaims the vertical space.
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
      if (!group) group = []
      group.push(item)
      continue
    }
    flush()
    if (item.kind === 'user') nodes.push({ kind: 'user', id: item.id, item })
    else if (item.kind === 'assistant') nodes.push({ kind: 'assistant', id: item.id, item })
    else if (item.kind === 'notice') nodes.push({ kind: 'notice', id: item.id, item })
  }
  flush()
  return nodes
}

/** A one-line summary of a finished tool group, shown when it is collapsed. */
export function groupSummary(items: ToolItem[]): string {
  const verbs = items.map((it) => describeTool(it).verb)
  const counts = new Map<string, number>()
  for (const v of verbs) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()]
    .map(([v, n]) => (n > 1 ? `${v} ×${n}` : v))
    .join(' · ')
}

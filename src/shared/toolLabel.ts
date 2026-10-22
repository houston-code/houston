/**
 * The verb and target a tool call is shown as ("Write hello.txt", "Run npm test"),
 * shared so the desktop's tool rows and the terminal's name a call the same way.
 * The desktop shortens long paths to fit a row; the terminal keeps them whole.
 */
import { parseMcpToolName } from './mcp'

export interface ToolDescription {
  /** Short action label, e.g. "Read", "Run", "Search". */
  verb: string
  /** The thing acted on — a path, command, pattern or query. */
  target: string
  /** Render the target in a monospace font (paths/commands) vs prose (queries). */
  mono: boolean
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

/** The row verb for a gh_pr_set_state action. */
function prStateVerb(action: unknown): string {
  switch (action) {
    case 'close':
      return 'Close PR'
    case 'reopen':
      return 'Reopen PR'
    case 'ready':
      return 'Mark PR ready'
    case 'draft':
      return 'Draft PR'
    default:
      return 'Update PR'
  }
}

/**
 * The files an apply_patch envelope (or unified diff) touches, from its headers.
 * Display only: the main process does the real parsing.
 */
function patchFiles(patch: string): string[] {
  const files = new Set<string>()
  for (const line of patch.split('\n')) {
    const envelope = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    const unified = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
    const path = (envelope?.[1] ?? unified?.[1])?.trim()
    if (path && path !== '/dev/null') files.add(path)
  }
  return [...files]
}

/** A concise verb + target for a tool call, used in the compact row. */
export function describeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  opts: { summary?: string; shorten?: (path: string) => string } = {}
): ToolDescription {
  const a = args ?? {}
  const shortenPath = opts.shorten ?? ((p: string): string => p)
  const path = str(a.path)
  switch (name) {
    case 'read_file':
      return { verb: 'Read', target: path ? shortenPath(path) : opts.summary ?? '', mono: true }
    case 'write_file':
      return { verb: 'Write', target: path ? shortenPath(path) : '', mono: true }
    case 'edit_file':
    case 'multi_edit':
      return { verb: 'Edit', target: path ? shortenPath(path) : '', mono: true }
    case 'apply_patch': {
      const files = patchFiles(str(a.patch) ?? '')
      const target = files.length === 1 ? shortenPath(files[0]) : files.length > 1 ? `${files.length} files` : ''
      return { verb: 'Patch', target, mono: files.length === 1 }
    }
    case 'git_status':
      return { verb: 'Git status', target: '', mono: false }
    case 'git_diff':
      return { verb: 'Git diff', target: path ? shortenPath(path) : '', mono: true }
    case 'notebook_edit': {
      const cell = typeof a.cell === 'number' ? a.cell : undefined
      const mode = str(a.mode) ?? 'replace'
      const verb = mode === 'insert' ? 'Insert cell' : mode === 'delete' ? 'Delete cell' : 'Edit cell'
      const where = path ? shortenPath(path) : ''
      return { verb, target: cell !== undefined ? `${cell} in ${where}` : where, mono: true }
    }
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
    case 'show_images': {
      const n = Array.isArray(a.images) ? a.images.length : 0
      const count = `${n} image${n === 1 ? '' : 's'}`
      const title = str(a.title)
      return { verb: 'Show', target: title ? `${title} (${count})` : count, mono: false }
    }
    case 'render_mockup': {
      const n = Array.isArray(a.variants) ? a.variants.length : 1
      return { verb: 'Render', target: `${str(a.file) ?? 'mockup'} (${n} variant${n === 1 ? '' : 's'})`, mono: false }
    }
    case 'view_localhost':
      return { verb: 'View', target: str(a.url) ?? '', mono: true }
    case 'web_search':
      return { verb: 'Search web', target: str(a.query) ?? '', mono: false }
    case 'dispatch_agent':
      return { verb: 'Subagent', target: str(a.description) ?? 'research task', mono: false }
    case 'dispatch_writable_agent':
      return { verb: 'Writable subagent', target: str(a.description) ?? 'task', mono: false }
    case 'spawn_session':
      return { verb: 'Spawn session', target: str(a.title) ?? str(a.prompt) ?? '', mono: false }
    case 'schedule_run':
      return { verb: 'Schedule', target: str(a.name) ?? str(a.spec) ?? '', mono: false }
    case 'list_scheduled_runs':
      return { verb: 'List schedules', target: '', mono: false }
    case 'cancel_scheduled_run':
      return { verb: 'Cancel schedule', target: str(a.id) ?? '', mono: true }
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
    case 'gh_pr_checks':
      return { verb: 'PR checks', target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_pr_review':
      return { verb: 'Review PR', target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_pr_merge':
      return { verb: 'Merge PR', target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_pr_set_state':
      return { verb: prStateVerb(a.action), target: prRef(a.number) ?? '(current)', mono: false }
    case 'gh_issue_list':
      return { verb: 'List issues', target: str(a.state) ?? 'open', mono: false }
    case 'gh_issue_view':
      return { verb: 'View issue', target: prRef(a.number) ?? '', mono: false }
    case 'gh_issue_create':
      return { verb: 'Open issue', target: str(a.title) ?? '', mono: false }
    case 'gh_issue_comment':
      return { verb: 'Comment issue', target: prRef(a.number) ?? '', mono: false }
    case 'gh_issue_set_state':
      return {
        verb: a.action === 'close' ? 'Close issue' : a.action === 'reopen' ? 'Reopen issue' : 'Update issue',
        target: prRef(a.number) ?? '',
        mono: false
      }
    case 'gh_run_list':
      return { verb: 'List CI runs', target: str(a.branch) ?? str(a.workflow) ?? '', mono: false }
    case 'gh_run_view':
      return { verb: 'View CI run', target: str(a.run_id) ?? (typeof a.run_id === 'number' ? String(a.run_id) : ''), mono: true }
    case 'gh_repo_create':
      return { verb: 'Create repo', target: str(a.name) ?? '', mono: true }
    case 'skill':
      return { verb: 'Skill', target: str(a.name) ?? '', mono: false }
    case 'recall_history':
      return { verb: 'Recall', target: str(a.query) ?? '', mono: false }
    default: {
      // An MCP tool's wire name is mcp__<server>__<tool>; show it as "<tool>" from
      // "<server>" rather than the mangled identifier.
      const mcp = parseMcpToolName(name)
      if (mcp) return { verb: mcp.toolName, target: opts.summary ?? `via ${mcp.serverId}`, mono: false }
      return { verb: name, target: opts.summary ?? str(a.path) ?? str(a.url) ?? '', mono: true }
    }
  }
}

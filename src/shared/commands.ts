/**
 * Slash commands. Built-in action commands (e.g. /new) have no template; custom
 * commands are prompt templates loaded from `.houston/commands/*.md` in the
 * workspace. Pure helpers live here so main + renderer share one definition.
 */
import type { ReasoningEffort } from './agent'
import { hasContext } from './commandContext'

export interface Command {
  name: string
  description: string
  /** Prompt template for a custom command; absent for built-in action commands. */
  template?: string
  /**
   * Run the moment it's submitted instead of expanding into the composer for
   * editing. For first-party action templates like `/review` that should "just
   * work" — the expanded prompt is sent as a normal turn, not previewed.
   */
  autoRun?: boolean
  /** Menu heading the command is listed under; custom commands have none. */
  group?: CommandGroup
  /**
   * What may follow the name, shown dimmed beside it (for example `[name]`). A
   * custom command sets it with its `argument-hint` frontmatter.
   */
  args?: string
  /**
   * Where a custom command was loaded from: the workspace's `.houston/commands`
   * (`project`, untrusted unless the folder is) or the user's `~/.houston/commands`.
   */
  source?: 'project' | 'user'
  /** `/<skill-name>`: runs a skill (listed under its own heading). */
  skill?: boolean
  /** Custom-command frontmatter `model`: the model this one turn runs on. */
  model?: string
  /** Custom-command frontmatter `effort`: the thinking effort for this one turn. */
  effort?: ReasoningEffort
  /** Custom-command frontmatter `agent`: dispatch the expanded prompt to this subagent. */
  agent?: string
  /**
   * Custom-command frontmatter `allowed-tools`, as written: tools pre-approved for
   * this one turn, in permission-rule syntax (`read_file`, `run_shell(git status*)`).
   */
  allowedTools?: string
  /**
   * `/mcp__<server>__<prompt>`: runs a prompt template an MCP server exposes. Set by
   * the main process from the connected servers; the clients fetch the prompt through
   * it when the command runs.
   */
  mcpPrompt?: McpPromptRef
}

/** One argument an MCP prompt declares (`prompts/list`). */
export interface McpPromptArgSpec {
  name: string
  description?: string
  required?: boolean
}

/** Which server's prompt a `/mcp__<server>__<prompt>` command runs, and what it takes. */
export interface McpPromptRef {
  /** The MCP server id (as configured, or `proj-`/`run-` prefixed). */
  server: string
  /** The prompt's own name on the server, sent back on `prompts/get`. */
  prompt: string
  /** Its declared arguments, in the server's order. */
  arguments: McpPromptArgSpec[]
}

/** Menu headings, in the order the menu shows them. Custom commands come last. */
export const COMMAND_GROUPS = ['Chat', 'Modes', 'Review and undo', 'Extend', 'Setup', 'Terminal'] as const
export type CommandGroup = (typeof COMMAND_GROUPS)[number]
/** Heading for a workspace's own commands (`.houston/commands`). */
export const CUSTOM_COMMAND_GROUP = 'Custom'
/** Heading for the skills, each runnable as `/<skill-name>`. */
export const SKILL_COMMAND_GROUP = 'Skills'
/** Heading for the connected MCP servers' prompts, each runnable as `/mcp__<server>__<prompt>`. */
export const MCP_PROMPT_COMMAND_GROUP = 'MCP prompts'

/** Parse a leading slash command from composer text: "/name the rest" → {name, args}. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  const sp = rest.search(/\s/)
  if (sp === -1) return { name: rest, args: '' }
  return { name: rest.slice(0, sp), args: rest.slice(sp + 1).trim() }
}

/**
 * Expand a custom-command template. `$ARGUMENTS` is replaced with the args (every
 * occurrence); if the template has no placeholder, non-empty args are appended.
 */
export function expandTemplate(template: string, args: string): string {
  // Positional placeholders first: `/deploy staging v2` → $1=staging, $2=v2. A
  // command that wants "the second word" had to make the user re-type it in the
  // right shape, or parse $ARGUMENTS in prose and hope.
  const words = args.split(/\s+/).filter(Boolean)
  let out = template
  if (/\$\d/.test(out)) {
    out = out.replace(/\$(\d)/g, (_m, d: string) => words[Number(d) - 1] ?? '')
  }
  if (out.includes('$ARGUMENTS')) return out.split('$ARGUMENTS').join(args)
  // A template that consumed positionals has already used the args; appending them
  // again would repeat them.
  if (out !== template) return out
  return args ? `${out.trimEnd()}\n\n${args}` : out
}

/** The heading a command is listed under. */
export function commandGroup(cmd: Command): string {
  return cmd.group ?? (cmd.skill ? SKILL_COMMAND_GROUP : cmd.mcpPrompt ? MCP_PROMPT_COMMAND_GROUP : CUSTOM_COMMAND_GROUP)
}

/** The commands ordered by menu heading (stable within one), for an unfiltered menu. */
export function groupCommands(commands: Command[]): Command[] {
  const order: string[] = [...COMMAND_GROUPS, CUSTOM_COMMAND_GROUP, SKILL_COMMAND_GROUP, MCP_PROMPT_COMMAND_GROUP]
  return commands
    .map((c, i) => ({ c, i, g: order.indexOf(commandGroup(c)) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.c)
}

/** True when every character of `needle` appears in `hay` in order. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i === needle.length
}

/**
 * How well a command answers what was typed after the slash; lower is better, null
 * is no match. The command the text names exactly comes first (its name, then an
 * alias, as {@link resolveCommand} reads it), so `/agent` is never taken for
 * `/agents`. Then a name that starts with it, then an alias that does, then a name
 * containing it, then a word of the description starting with it (so `/perm` finds
 * `/approval`), then the letters appearing in order in the name.
 */
function commandRank(cmd: Command, q: string): number | null {
  const name = cmd.name.toLowerCase()
  if (name === q) return 0
  if (COMMAND_ALIASES[q] === cmd.name) return 1
  if (name.startsWith(q)) return 2
  for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
    if (target === cmd.name && alias.startsWith(q)) return 3
  }
  if (name.includes(q)) return 4
  if (q.length >= 3) {
    const words = cmd.description.toLowerCase().split(/[^a-z0-9]+/)
    if (words.some((w) => w.startsWith(q))) return 5
  }
  if (q.length >= 2 && isSubsequence(q, name)) return 6
  return null
}

/**
 * The commands that answer what was typed after the slash (case-insensitive), best
 * first. Nothing typed lists every command under its menu heading.
 */
export function matchCommands(commands: Command[], query: string): Command[] {
  const q = query.toLowerCase()
  if (!q) return groupCommands(commands)
  return commands
    .map((c, i) => ({ c, i, rank: commandRank(c, q) }))
    .filter((x): x is { c: Command; i: number; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c)
}

/**
 * Second names for built-in commands, accepted by both clients: what the terminal
 * has always taken (`/diff`, `/providers`, …), so a name learned in one client
 * works in the other.
 */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  diff: 'changes',
  providers: 'login',
  sessions: 'resume',
  aside: 'btw',
  think: 'reasoning',
  proposed: 'proposals',
  bashes: 'tasks',
  paste: 'image',
  bug: 'feedback',
  q: 'quit'
}

/**
 * Resolve a command by exact name, case-insensitively (matches the menu), or by
 * one of its {@link COMMAND_ALIASES} when that command is in the list.
 */
export function resolveCommand(commands: Command[], name: string): Command | undefined {
  const n = name.toLowerCase()
  const direct = commands.find((c) => c.name.toLowerCase() === n)
  if (direct) return direct
  // Own-property only: a typed `/constructor` must not resolve to Object's members.
  const target = Object.hasOwn(COMMAND_ALIASES, n) ? COMMAND_ALIASES[n] : undefined
  return target ? commands.find((c) => c.name === target) : undefined
}

/**
 * `/agent <name> <task>` — hand a job to one of the workspace's own subagents.
 *
 * `.houston/agents/*.md` lets a project define specialized agents, and the model
 * can dispatch them. The user could not: `/agents` listed them and that was the
 * whole surface, so the only way to use one you had written was to describe it in
 * prose and hope the model picked the right one. Shared so both clients recognize
 * an invocation and phrase the dispatch identically.
 *
 * Returns the agent name and its task, or null when the arg isn't a valid one.
 */
export function parseAgentInvocation(arg: string): { name: string; task: string } | null {
  const trimmed = arg.trim()
  if (!trimmed) return null
  const sp = trimmed.search(/\s/)
  const name = sp === -1 ? trimmed : trimmed.slice(0, sp)
  if (!/^[\w-]+$/.test(name)) return null
  return { name, task: sp === -1 ? '' : trimmed.slice(sp + 1).trim() }
}

/**
 * The turn that runs a named subagent.
 *
 * Phrased as an instruction to dispatch rather than as the task itself: the
 * subagent tools are the model's, and routing through them keeps everything that
 * hangs off a dispatch — the agent's own system prompt, its tool allow-list, its
 * model, the approval tier for a writable one — exactly as it is when the model
 * chooses. A second path into subagents would be a second set of rules to keep in
 * step.
 */
export function agentInvocationPrompt(name: string, task: string): string {
  const what = task || 'Use your judgment about what needs doing here, and report back.'
  return `Use the \`${name}\` subagent for this task. Dispatch it with everything it needs to work on its own, then report what it found.\n\n${what}`
}

/**
 * Merge built-in and custom commands, dropping any custom command that collides
 * with a built-in name (built-ins win) so the list has no duplicates.
 */
export function mergeCommands(builtin: Command[], custom: Command[]): Command[] {
  const names = new Set(builtin.map((c) => c.name.toLowerCase()))
  return [...builtin, ...custom.filter((c) => !names.has(c.name.toLowerCase()))]
}

/**
 * Whether a custom command needs the main process to run it: a frontmatter option
 * that changes how its turn runs (model, effort, agent, allowed-tools), or a
 * template that pulls in `@file` or `` !`command` `` context. The desktop composer
 * can't express those by filling the message box, so such a command runs straight
 * away, prepared by the main process.
 */
export function commandHasRunOptions(cmd: Command): boolean {
  // An MCP prompt is fetched from its server by the main process.
  if (cmd.mcpPrompt) return true
  if (cmd.model || cmd.effort || cmd.agent || cmd.allowedTools) return true
  // Only a workspace's or the user's own command; the first-party templates have none.
  return cmd.source !== undefined && cmd.template !== undefined && hasContext(cmd.template)
}

/**
 * The first-party `/review` command's prompt. Shared so every client (GUI + TUI)
 * runs the exact same adversarial-review turn from one definition.
 */
export const REVIEW_TEMPLATE =
  'Review my current uncommitted changes for correctness, security, and quality. Use the review_changes tool to run the adversarial review (a separate reviewer per dimension, then a verification pass), then fix any confirmed issues and summarize what you found.'

/**
 * What `/review [base-branch | pr# | path ...]` reviews.
 *
 *  - nothing: the uncommitted changes (the plain {@link REVIEW_TEMPLATE});
 *  - `#12`, `12` or a pull request URL: that pull request;
 *  - a first word that can only be a path (`.`, `./src`, `src/`, a glob): the
 *    uncommitted changes in the paths given;
 *  - any other first word: a base branch, reviewing everything since this branch
 *    split from it. A word like `src/api` could be either, so the prompt says to
 *    treat it as a path when it names no branch, tag or commit.
 *
 * Words after the first are paths the review is limited to.
 */
export type ReviewTarget =
  | { kind: 'uncommitted'; paths: string[] }
  | { kind: 'base'; base: string; paths: string[] }
  | { kind: 'pr'; number: number; paths: string[] }

const PR_ARG = /^(?:#?(\d{1,9})|https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d{1,9})(?:[/?#]\S*)?)$/

/** Whether a word can only be a path, never a branch name. */
function pathOnly(word: string): boolean {
  return word === '.' || word.startsWith('./') || word.endsWith('/') || word.includes('*')
}

/** Parse what follows `/review`. Pure: nothing is checked against the repository. */
export function parseReviewArgs(args: string): ReviewTarget {
  const words = args.split(/\s+/).filter(Boolean)
  if (!words.length) return { kind: 'uncommitted', paths: [] }
  const [first, ...rest] = words
  const pr = PR_ARG.exec(first)
  if (pr) return { kind: 'pr', number: Number(pr[1] ?? pr[2]), paths: rest }
  if (pathOnly(first)) return { kind: 'uncommitted', paths: words }
  return { kind: 'base', base: first, paths: rest }
}

/** A value written into the prompt, quoted so the model passes it exactly as typed. */
const quoted = (s: string): string => JSON.stringify(s)
const quotedList = (paths: string[]): string => `[${paths.map(quoted).join(', ')}]`

const REVIEW_STEPS =
  'to run the adversarial review (a separate reviewer per dimension, then a verification pass), then fix any confirmed issues and summarize what you found.'

/** The prompt `/review` sends for `target`. No target is exactly {@link REVIEW_TEMPLATE}. */
export function reviewPrompt(target: ReviewTarget): string {
  const scope = target.paths.length ? ` and paths ${quotedList(target.paths)}` : ''
  switch (target.kind) {
    case 'uncommitted':
      if (!target.paths.length) return REVIEW_TEMPLATE
      return `Review my current uncommitted changes in ${target.paths.join(', ')} for correctness, security, and quality. Use the review_changes tool with paths ${quotedList(target.paths)} ${REVIEW_STEPS}`
    case 'base': {
      const b = target.base
      return (
        `Review the changes on this branch since it split from ${b}, committed and uncommitted, for correctness, security, and quality. ` +
        `Use the review_changes tool with base ${quoted(`${b}...`)} (the three dots review from where this branch split from ${b})${scope} ${REVIEW_STEPS} ` +
        `If ${quoted(b)} names no branch, tag or commit in this repository, it is a path: review my uncommitted changes in it instead (review_changes with paths ${quotedList([b, ...target.paths])}).`
      )
    }
    case 'pr': {
      const n = target.number
      const focus = target.paths.length ? ` Limit the review to ${target.paths.join(', ')}.` : ''
      return (
        `Review pull request #${n} for correctness, security, and quality. Read it with gh_pr_view (number ${n}, diff true).${focus} ` +
        `If its head branch is the branch checked out here, use the review_changes tool with base set to its base branch followed by three dots (for example "origin/main...")${scope} ${REVIEW_STEPS} ` +
        "Otherwise review the pull request's diff yourself, checking each finding against the code, and report the confirmed findings without changing any files."
      )
    }
  }
}

/** The short line the `/review` chip shows for `target`. */
export function reviewTargetLabel(target: ReviewTarget): string {
  const within = target.paths.length ? ` in ${target.paths.join(', ')}` : ''
  switch (target.kind) {
    case 'uncommitted':
      return `Uncommitted changes${within}`
    case 'base':
      return `Changes since ${target.base}${within}`
    case 'pr':
      return `Pull request #${target.number}${within}`
  }
}

/**
 * The first-party `/init` command's prompt: write (or improve) the project's
 * AGENTS.md, the instructions file Houston loads at the start of every run.
 */
export const INIT_TEMPLATE =
  "Write an AGENTS.md at the root of this project for coding agents working in it. First look around: the README, the build and package files, the test setup, CI config, and a few representative source files. Then write a short file (aim for under 80 lines) covering how to install, build, run, and test, with the exact commands; how the code is laid out; the conventions a newcomer would get wrong; and anything that must not be done. Only write what you verified in the repository, not general advice. If an AGENTS.md or CLAUDE.md already exists, read it first and improve it in place instead of starting over, keeping what is still true. Finish with a short summary of what you wrote."

/** The interactive clients that surface built-in slash commands. */
export type CommandClient = 'gui' | 'tui'

/**
 * A built-in command in the canonical catalog: a `Command` plus the set of
 * clients that surface it. Some built-ins are shared (`/new`, `/help`), some are
 * client-specific (the TUI has terminal-only `/theme` and `/exit`; the GUI has
 * approval-policy presets like `/auto`), so a flat shared list would be wrong —
 * the `clients` tag is what lets one catalog drive both menus.
 */
export interface BuiltinCommand extends Command {
  /** Clients that expose this command. */
  clients: CommandClient[]
  /**
   * What the desktop menu says instead, where the app does the job differently from
   * the terminal (it opens a Settings page rather than printing or taking
   * subcommands). `args: null` shows no argument hint there.
   */
  gui?: { description?: string; args?: string | null }
}

/**
 * Every built-in slash command, the single source of truth across clients. The
 * GUI and TUI each used to keep a private copy that drifted out of sync; both now
 * derive their menus from this list via `builtinCommands(client)`. It is also the
 * authoritative answer to "what slash commands does Houston have?", so the
 * product's own self-knowledge can never disagree with what the clients offer.
 *
 * Template commands (a `template` that expands into a prompt turn, e.g. `/review`)
 * are present in every client and win over a same-named custom command via
 * `mergeCommands`; the rest are actions handled by each client.
 */
export const BUILTIN_COMMAND_CATALOG: BuiltinCommand[] = [
  { name: 'new', group: 'Chat', description: 'Start a new chat', clients: ['gui', 'tui'] },
  { name: 'clear', group: 'Chat', description: 'Start a new chat (alias for /new)', clients: ['gui', 'tui'] },
  {
    name: 'compact', group: 'Chat', args: '[focus]',
    description: 'Summarize older turns to free up context now (/compact [what to keep in detail])',
    clients: ['gui', 'tui']
  },
  {
    name: 'retry', group: 'Chat',
    description: 'Run your last message again after a turn that failed',
    clients: ['gui', 'tui']
  },
  {
    name: 'plan', group: 'Modes',
    description: 'Plan mode: read-only (research & propose, no edits/commands)',
    clients: ['gui', 'tui']
  },
  { name: 'ask', group: 'Modes', description: 'Approval: ask before every edit and command', clients: ['gui', 'tui'] },
  { name: 'auto', group: 'Modes', description: 'Approval: auto-approve edits, ask for commands', clients: ['gui', 'tui'] },
  { name: 'full', group: 'Modes', description: 'Approval: full auto (sandboxed)', clients: ['gui', 'tui'] },
  { name: 'model', group: 'Modes', args: '[name]', description: 'List or switch the active model', clients: ['gui', 'tui'] },
  { name: 'login', group: 'Setup', description: 'Set or update an API key (also: /providers)', clients: ['gui', 'tui'] },
  {
    name: 'settings', group: 'Setup', args: '[page]',
    description: 'Show a summary of your current settings',
    clients: ['gui', 'tui'],
    gui: { description: 'Open Settings, or one page of it' }
  },
  { name: 'undo', group: 'Review and undo', description: "Revert the files the last turn changed", clients: ['gui', 'tui'] },
  { name: 'redo', group: 'Review and undo', description: 'Put back what /undo reverted', clients: ['gui', 'tui'] },
  {
    name: 'rewind', group: 'Review and undo',
    description: 'Rewind to an earlier message: the conversation, the code, or both',
    clients: ['gui', 'tui']
  },
  {
    name: 'changes', group: 'Review and undo',
    description: 'What is different in the working tree (also /diff)',
    clients: ['gui', 'tui']
  },
  {
    name: 'reasoning', group: 'Modes', args: '[level]',
    description: 'Show or set thinking effort (off | low | medium | high | xhigh)',
    clients: ['gui', 'tui']
  },
  {
    name: 'usage', group: 'Setup',
    description: 'Spend and tokens per day and per project, from the chats on this computer',
    clients: ['gui', 'tui']
  },
  {
    name: 'doctor', group: 'Setup',
    description: 'Check your setup: model, sandbox, tools, MCP',
    clients: ['gui', 'tui']
  },
  {
    name: 'config', group: 'Terminal', args: '[key[=value]]',
    description: 'Pick and change a terminal setting, or show or set one (/config --help lists them)',
    clients: ['tui']
  },
  {
    name: 'status', group: 'Terminal',
    description: 'Version, model, approval, sandbox, network, MCP, settings sources and cost on one screen',
    clients: ['tui']
  },
  {
    name: 'feedback', group: 'Terminal',
    description: 'Report an issue: see what the report holds, then open it or print its link (also /bug)',
    clients: ['tui']
  },
  {
    name: 'vim', group: 'Terminal', args: '[on|off]',
    description: 'Vim keys in the composer (/vim [on|off])',
    clients: ['tui']
  },
  {
    name: 'add-dir', group: 'Terminal', args: '[path]',
    description: 'Let the agent work in another folder this session (/add-dir alone lists them)',
    clients: ['tui']
  },
  {
    name: 'cd', group: 'Terminal', args: '<path>',
    description: "Move this session's working folder, and the chat with it",
    clients: ['tui']
  },
  {
    name: 'notify', group: 'Terminal', args: '[auto|osc|bell|off]',
    description: 'Choose the bell and notification sent when a run needs you',
    clients: ['tui']
  },
  {
    name: 'screen-reader', group: 'Terminal', args: '[on|off]',
    description: 'Plain lines for a screen reader: no redraws, numbered choices',
    clients: ['tui']
  },
  {
    name: 'reduce-motion', group: 'Terminal', args: '[on|off]',
    description: 'Hold the activity line still instead of animating the spinner',
    clients: ['tui']
  },
  {
    name: 'verbose', group: 'Terminal',
    description: "Show each tool's full output as it runs",
    clients: ['tui']
  },
  {
    name: 'focus', group: 'Terminal', args: '[on|off]',
    description: 'Show only your messages, one line per tool call, and the final reply',
    clients: ['tui']
  },
  {
    name: 'thoughts', group: 'Terminal', args: '[show|summary|hide]',
    description: "How the model's reasoning shows as it streams (Alt-T cycles it)",
    clients: ['tui']
  },
  {
    name: 'transcript', group: 'Terminal',
    description: 'The whole session full screen, with reasoning and full tool output (Ctrl-O)',
    clients: ['tui']
  },
  {
    name: 'output', group: 'Terminal', args: '[n]',
    description: 'Reprint a tool result in full (/output [n])',
    clients: ['tui']
  },
  {
    name: 'copy', group: 'Terminal', args: '[n]',
    description: 'Copy a reply, or one of its code blocks, to the clipboard',
    clients: ['tui']
  },
  { name: 'approval', group: 'Modes', args: '[mode]', description: 'Show or set the approval policy', clients: ['gui', 'tui'] },
  { name: 'resume', group: 'Chat', args: '[search]', description: 'Reopen (or search) a saved session', clients: ['gui', 'tui'] },
  {
    name: 'spawned', group: 'Terminal',
    description: 'List the background sessions the agent started, and open one',
    clients: ['tui']
  },
  {
    name: 'tasks', group: 'Terminal', args: '[n | kill n]',
    description: 'List the background shells and subagents of this chat, show one, or stop one',
    clients: ['tui']
  },
  {
    name: 'proposals', group: 'Terminal',
    description: 'List the sessions the agent proposed, and start, ask here, or dismiss one',
    clients: ['tui']
  },
  {
    name: 'btw', group: 'Chat', args: '[question]',
    description: 'Ask a quick side question; the answer stays out of this chat',
    clients: ['gui', 'tui']
  },
  {
    name: 'loop', group: 'Chat', args: '[interval] <prompt>',
    description: 'Run a prompt on a schedule in this folder (/loop 10m check CI)',
    clients: ['gui', 'tui']
  },
  {
    name: 'schedule', group: 'Chat', args: '[cancel n]',
    description: 'List the scheduled runs, or cancel one',
    clients: ['gui', 'tui']
  },
  {
    name: 'fork', group: 'Chat', args: '[n]',
    description: 'Branch the current session into a copy, or fork from your n-th message',
    clients: ['gui', 'tui']
  },
  { name: 'rename', group: 'Chat', args: '<title>', description: 'Give this chat a title', clients: ['tui'] },
  {
    name: 'export', group: 'Chat', args: '[md|json] [path] [--copy]',
    description: 'Write this chat to a Markdown or JSON file, or copy it (secrets masked)', clients: ['tui']
  },
  { name: 'delete', group: 'Chat', description: 'Delete this chat (asks first)', clients: ['tui'] },
  {
    name: 'permissions', group: 'Setup', args: '[remove n | allow n | add …]',
    description: 'Saved permission rules and recent denials: remove a rule, allow a denial, or add one',
    clients: ['tui']
  },
  { name: 'cost', group: 'Setup', description: 'Session token and cost totals', clients: ['gui', 'tui'] },
  {
    name: 'context', group: 'Setup',
    description: 'What fills the context now, part by part',
    clients: ['gui', 'tui']
  },
  {
    name: 'skills', group: 'Extend',
    description: 'List the skills (.houston/skills and .agents/skills); run one with /<name>',
    clients: ['gui', 'tui']
  },
  {
    name: 'agents', group: 'Extend',
    description: 'List the workspace agents (.houston/agents)',
    clients: ['gui', 'tui']
  },
  {
    name: 'agent', group: 'Extend', args: '<name> <task>',
    description: 'Hand a task to one of your .houston/agents (/agent <name> <task>)',
    clients: ['gui', 'tui']
  },
  {
    name: 'mcp', group: 'Extend',
    description: 'List MCP servers (add, remove, enable, disable, reconnect, login, logout, registry search)',
    clients: ['gui', 'tui'],
    gui: { description: 'Manage MCP servers in Settings' }
  },
  {
    name: 'trust', group: 'Setup',
    description: "Show this folder's project-config trust (/trust forget re-decides)",
    clients: ['gui', 'tui'],
    gui: { description: "Review this folder's project-config trust in Settings (/trust forget asks again)" }
  },
  { name: 'hooks', group: 'Extend', description: 'List configured hooks', clients: ['gui', 'tui'] },
  {
    name: 'memory', group: 'Extend',
    description: 'Review saved memories (show, edit, pin, forget, on, off)',
    clients: ['gui', 'tui'],
    gui: { description: 'Review saved memories in Settings' }
  },
  {
    name: 'theme', group: 'Setup', args: '[name]',
    description: 'List or switch the color theme',
    clients: ['gui', 'tui'],
    gui: { description: 'Switch the app theme (system, dark, light), or open Appearance settings', args: '[system|dark|light]' }
  },
  { name: 'image', group: 'Terminal', args: '[path]', description: 'Attach an image: from your clipboard, or /image <path>', clients: ['tui'] },
  { name: 'cwd', group: 'Setup', description: 'Show the working directory', clients: ['gui', 'tui'] },
  { name: 'share', group: 'Chat', description: 'Copy an invite to Houston to share with a friend', clients: ['gui', 'tui'] },
  { name: 'help', group: 'Setup', description: 'List the available slash commands', clients: ['gui', 'tui'] },
  {
    name: 'init',
    group: 'Setup',
    description: 'Write or improve AGENTS.md, the instructions file for this project',
    clients: ['gui', 'tui'],
    autoRun: true,
    template: INIT_TEMPLATE
  },
  {
    name: 'review', group: 'Review and undo', args: '[base-branch | pr# | path]',
    description: 'Adversarial review of your uncommitted changes, a branch, a pull request, or a path',
    clients: ['gui', 'tui'],
    // Runs immediately on submit rather than expanding into the composer.
    autoRun: true,
    template: REVIEW_TEMPLATE
  },
  { name: 'exit', group: 'Terminal', description: 'Leave', clients: ['tui'] },
  { name: 'quit', group: 'Terminal', description: 'Leave', clients: ['tui'] }
]

/**
 * Strip the catalog-only tags, yielding a plain `Command`; for the desktop, with its
 * own wording where the catalog gives one.
 */
function toCommand(c: BuiltinCommand, client?: CommandClient): Command {
  const gui = client === 'gui' ? c.gui : undefined
  const cmd: Command = { name: c.name, description: gui?.description ?? c.description }
  if (c.template !== undefined) cmd.template = c.template
  if (c.autoRun !== undefined) cmd.autoRun = c.autoRun
  if (c.group !== undefined) cmd.group = c.group
  const args = gui && gui.args !== undefined ? gui.args : c.args
  if (args !== undefined && args !== null) cmd.args = args
  return cmd
}

/** The built-in commands a given client surfaces, as plain `Command`s. */
export function builtinCommands(client: CommandClient): Command[] {
  return BUILTIN_COMMAND_CATALOG.filter((c) => c.clients.includes(client)).map((c) => toCommand(c, client))
}

/**
 * Where the desktop app does what a terminal-only command does. Typed into the
 * app's composer, these names were sent to the model as a message; the app now
 * answers with this instead. Every terminal-only built-in has an entry (a test
 * holds the catalog to that).
 */
const DESKTOP_EQUIVALENT: Readonly<Record<string, string>> = {
  vim: 'the app\'s composer has no vim mode',
  config: 'in the app, every setting is in Settings',
  status: 'in the app, Settings > About shows the version, and /doctor checks the setup',
  feedback: 'in the app, use Help > Report an Issue',
  'add-dir': 'in the app, add folders the agent may use under Settings, Workspace, Additional folders',
  cd: 'in the app, the project folder button by the message box opens another folder, in a new chat',
  'reduce-motion': 'the app follows your system\'s reduce motion setting',
  notify: 'in the app, notifications and sounds are under Settings > General > Notifications',
  'screen-reader': 'the app works with your screen reader as it is, and Settings has Read replies to screen readers',
  verbose: 'in the app, open a tool row to see its full output',
  focus: 'the app folds each tool call into a row you can open',
  output: 'in the app, open a tool row to see its full output',
  thoughts: 'in the app, reasoning folds above each reply; Settings > Appearance > Always show reasoning keeps it open',
  transcript: 'in the app, the chat itself is the full transcript: open a tool row or the reasoning to see it in full',
  copy: 'in the app, use the copy button on a reply or code block',
  spawned: 'in the app, sessions the agent started are listed under this chat in the sidebar',
  tasks: 'in the app, background commands are in the Background tasks list in the right-hand dock, and subagents show under the tool call that started them',
  proposals: 'in the app, proposed sessions appear as cards in the chat, with Start and Dismiss',
  image: 'in the app, attach an image with the + button, or paste or drop it into the message box',
  rename: "in the app, rename a chat from its More actions menu in the sidebar",
  export: "in the app, export a chat from its More actions menu in the sidebar, or the File menu",
  delete: "in the app, delete a chat from its More actions menu in the sidebar",
  permissions: 'in the app, saved rules and recent denials are under Settings > Permissions',
  exit: 'close the window to leave',
  quit: 'close the window to leave'
}

/**
 * For a command only the terminal has, a one-line note saying so and pointing at
 * the desktop's way to do it; null for any other name.
 */
export function terminalOnlyNote(name: string): string | null {
  const n = name.toLowerCase()
  const canonical = (Object.hasOwn(COMMAND_ALIASES, n) ? COMMAND_ALIASES[n] : undefined) ?? n
  const entry = BUILTIN_COMMAND_CATALOG.find((c) => c.name === canonical)
  if (!entry || entry.clients.includes('gui')) return null
  const where = Object.hasOwn(DESKTOP_EQUIVALENT, canonical) ? DESKTOP_EQUIVALENT[canonical] : undefined
  return `/${n} is a terminal command${where ? `: ${where}` : ''}.`
}

/**
 * First-party template commands (those that expand into a prompt turn, e.g.
 * `/review`). Unlike custom commands (loaded per workspace from
 * `.houston/commands`), these ship with the app, are present in every client, and
 * win over a same-named custom command via `mergeCommands`.
 */
export const BUILTIN_TEMPLATE_COMMANDS: Command[] = BUILTIN_COMMAND_CATALOG.filter(
  (c) => c.template !== undefined
).map((c) => toCommand(c))

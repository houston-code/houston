/**
 * Slash commands. Built-in action commands (e.g. /new) have no template; custom
 * commands are prompt templates loaded from `.houston/commands/*.md` in the
 * workspace. Pure helpers live here so main + renderer share one definition.
 */

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
  /** What may follow the name, shown dimmed beside it (for example `[name]`). */
  args?: string
}

/** Menu headings, in the order the menu shows them. Custom commands come last. */
export const COMMAND_GROUPS = ['Chat', 'Modes', 'Review and undo', 'Extend', 'Setup', 'Terminal'] as const
export type CommandGroup = (typeof COMMAND_GROUPS)[number]
/** Heading for a workspace's own commands (`.houston/commands`). */
export const CUSTOM_COMMAND_GROUP = 'Custom'

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
  return cmd.group ?? CUSTOM_COMMAND_GROUP
}

/** The commands ordered by menu heading (stable within one), for an unfiltered menu. */
export function groupCommands(commands: Command[]): Command[] {
  const order: string[] = [...COMMAND_GROUPS, CUSTOM_COMMAND_GROUP]
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
 * is no match. A name that starts with it comes first, then an alias that does,
 * then a name containing it, then a word of the description starting with it (so
 * `/perm` finds `/approval`), then the letters appearing in order in the name.
 */
function commandRank(cmd: Command, q: string): number | null {
  const name = cmd.name.toLowerCase()
  if (name.startsWith(q)) return 0
  for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
    if (target === cmd.name && alias.startsWith(q)) return 1
  }
  if (name.includes(q)) return 2
  if (q.length >= 3) {
    const words = cmd.description.toLowerCase().split(/[^a-z0-9]+/)
    if (words.some((w) => w.startsWith(q))) return 3
  }
  if (q.length >= 2 && isSubsequence(q, name)) return 4
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
  paste: 'image',
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
  const target = COMMAND_ALIASES[n]
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
 * The first-party `/review` command's prompt. Shared so every client (GUI + TUI)
 * runs the exact same adversarial-review turn from one definition.
 */
export const REVIEW_TEMPLATE =
  'Review my current uncommitted changes for correctness, security, and quality. Use the review_changes tool to run the adversarial review (a separate reviewer per dimension, then a verification pass), then fix any confirmed issues and summarize what you found.'

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
  { name: 'compact', group: 'Chat', description: 'Summarize older turns to free up context now', clients: ['gui', 'tui'] },
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
  { name: 'settings', group: 'Setup', args: '[page]', description: 'Show a summary of your current settings', clients: ['gui', 'tui'] },
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
    clients: ['gui']
  },
  {
    name: 'doctor', group: 'Setup',
    description: 'Check your setup: model, sandbox, tools, MCP',
    clients: ['gui', 'tui']
  },
  {
    name: 'vim', group: 'Terminal', args: '[on|off]',
    description: 'Vim keys in the composer (/vim [on|off])',
    clients: ['tui']
  },
  {
    name: 'verbose', group: 'Terminal',
    description: "Show each tool's full output as it runs",
    clients: ['tui']
  },
  {
    name: 'output', group: 'Terminal', args: '[n]',
    description: 'Reprint a tool result in full (/output [n])',
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
    name: 'proposals', group: 'Terminal',
    description: 'List the sessions the agent proposed, and start, ask here, or dismiss one',
    clients: ['tui']
  },
  {
    name: 'btw', group: 'Chat', args: '[question]',
    description: 'Ask a quick side question; the answer stays out of this chat',
    clients: ['gui', 'tui']
  },
  { name: 'fork', group: 'Chat', description: 'Branch the current session into a copy', clients: ['gui', 'tui'] },
  { name: 'rename', group: 'Chat', args: '<title>', description: 'Give this chat a title', clients: ['tui'] },
  {
    name: 'export', group: 'Chat', args: '[md|json] [path]',
    description: 'Write this chat to a Markdown or JSON file', clients: ['tui']
  },
  { name: 'delete', group: 'Chat', description: 'Delete this chat (asks first)', clients: ['tui'] },
  {
    name: 'permissions', group: 'Setup', args: '[remove n]',
    description: 'List the saved permission rules, or remove one', clients: ['tui']
  },
  { name: 'cost', group: 'Setup', description: 'Session token and cost totals', clients: ['gui', 'tui'] },
  {
    name: 'context', group: 'Setup',
    description: 'What fills the context now, part by part',
    clients: ['gui', 'tui']
  },
  {
    name: 'skills', group: 'Extend',
    description: 'List the workspace skills (.houston/skills)',
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
  { name: 'mcp', group: 'Extend', description: 'List MCP servers (add, remove, login, logout)', clients: ['gui', 'tui'] },
  {
    name: 'trust', group: 'Setup',
    description: "Show this folder's project-config trust (/trust forget re-decides)",
    clients: ['gui', 'tui']
  },
  { name: 'hooks', group: 'Extend', description: 'List configured hooks', clients: ['gui', 'tui'] },
  { name: 'memory', group: 'Extend', description: 'Review saved memories (show, edit, pin, forget, on, off)', clients: ['gui', 'tui'] },
  { name: 'theme', group: 'Setup', args: '[name]', description: 'List or switch the color theme', clients: ['gui', 'tui'] },
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
    name: 'review', group: 'Review and undo',
    description: 'Adversarial review of your uncommitted changes',
    clients: ['gui', 'tui'],
    // Runs immediately on submit rather than expanding into the composer.
    autoRun: true,
    template: REVIEW_TEMPLATE
  },
  { name: 'exit', group: 'Terminal', description: 'Leave', clients: ['tui'] },
  { name: 'quit', group: 'Terminal', description: 'Leave', clients: ['tui'] }
]

/** Strip the catalog-only `clients` tag, yielding a plain `Command`. */
function toCommand(c: BuiltinCommand): Command {
  const cmd: Command = { name: c.name, description: c.description }
  if (c.template !== undefined) cmd.template = c.template
  if (c.autoRun !== undefined) cmd.autoRun = c.autoRun
  if (c.group !== undefined) cmd.group = c.group
  if (c.args !== undefined) cmd.args = c.args
  return cmd
}

/** The built-in commands a given client surfaces, as plain `Command`s. */
export function builtinCommands(client: CommandClient): Command[] {
  return BUILTIN_COMMAND_CATALOG.filter((c) => c.clients.includes(client)).map(toCommand)
}

/**
 * Where the desktop app does what a terminal-only command does. Typed into the
 * app's composer, these names were sent to the model as a message; the app now
 * answers with this instead. Every terminal-only built-in has an entry (a test
 * holds the catalog to that).
 */
const DESKTOP_EQUIVALENT: Readonly<Record<string, string>> = {
  vim: 'the app\'s composer has no vim mode',
  verbose: 'in the app, open a tool row to see its full output',
  output: 'in the app, open a tool row to see its full output',
  spawned: 'in the app, sessions the agent started are listed under this chat in the sidebar',
  proposals: 'in the app, proposed sessions appear as cards in the chat, with Start and Dismiss',
  image: 'in the app, attach an image with the + button, or paste or drop it into the message box',
  rename: "in the app, rename a chat from its More actions menu in the sidebar",
  export: "in the app, export a chat from its More actions menu in the sidebar, or the File menu",
  delete: "in the app, delete a chat from its More actions menu in the sidebar",
  permissions: 'in the app, saved rules are under Settings > Permissions',
  exit: 'close the window to leave',
  quit: 'close the window to leave'
}

/**
 * For a command only the terminal has, a one-line note saying so and pointing at
 * the desktop's way to do it; null for any other name.
 */
export function terminalOnlyNote(name: string): string | null {
  const n = name.toLowerCase()
  const canonical = COMMAND_ALIASES[n] ?? n
  const entry = BUILTIN_COMMAND_CATALOG.find((c) => c.name === canonical)
  if (!entry || entry.clients.includes('gui')) return null
  const where = DESKTOP_EQUIVALENT[canonical]
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
).map(toCommand)

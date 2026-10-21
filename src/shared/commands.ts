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
}

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

/** Commands whose name starts with the typed prefix (case-insensitive). */
export function matchCommands(commands: Command[], prefix: string): Command[] {
  const p = prefix.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(p))
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
  { name: 'new', description: 'Start a new chat', clients: ['gui', 'tui'] },
  { name: 'clear', description: 'Start a new chat (alias for /new)', clients: ['gui', 'tui'] },
  { name: 'compact', description: 'Summarize older turns to free up context now', clients: ['gui', 'tui'] },
  {
    name: 'retry',
    description: 'Run your last message again after a turn that failed',
    clients: ['gui', 'tui']
  },
  {
    name: 'plan',
    description: 'Plan mode: read-only (research & propose, no edits/commands)',
    clients: ['gui', 'tui']
  },
  { name: 'ask', description: 'Approval: ask before every edit and command', clients: ['gui', 'tui'] },
  { name: 'auto', description: 'Approval: auto-approve edits, ask for commands', clients: ['gui', 'tui'] },
  { name: 'full', description: 'Approval: full auto (sandboxed)', clients: ['gui', 'tui'] },
  { name: 'model', description: 'List or switch the active model', clients: ['gui', 'tui'] },
  { name: 'login', description: 'Set or update an API key (also: /providers)', clients: ['gui', 'tui'] },
  { name: 'settings', description: 'Show a summary of your current settings', clients: ['gui', 'tui'] },
  { name: 'undo', description: "Revert the files the last turn changed", clients: ['gui', 'tui'] },
  { name: 'redo', description: 'Put back what /undo reverted', clients: ['gui', 'tui'] },
  {
    name: 'rewind',
    description: 'Rewind to an earlier message: the conversation, the code, or both',
    clients: ['gui', 'tui']
  },
  {
    name: 'changes',
    description: 'What is different in the working tree (also /diff)',
    clients: ['gui', 'tui']
  },
  {
    name: 'reasoning',
    description: 'Show or set thinking effort (off | low | medium | high | xhigh)',
    clients: ['gui', 'tui']
  },
  {
    name: 'doctor',
    description: 'Check your setup: model, sandbox, tools, MCP',
    clients: ['gui', 'tui']
  },
  {
    name: 'vim',
    description: 'Vim keys in the composer (/vim [on|off])',
    clients: ['tui']
  },
  {
    name: 'verbose',
    description: "Show each tool's full output as it runs",
    clients: ['tui']
  },
  {
    name: 'output',
    description: 'Reprint a tool result in full (/output [n])',
    clients: ['tui']
  },
  { name: 'approval', description: 'Show or set the approval policy', clients: ['gui', 'tui'] },
  { name: 'resume', description: 'Reopen (or search) a saved session', clients: ['gui', 'tui'] },
  {
    name: 'spawned',
    description: 'List the background sessions the agent started, and open one',
    clients: ['tui']
  },
  {
    name: 'proposals',
    description: 'List the sessions the agent proposed, and start, ask here, or dismiss one',
    clients: ['tui']
  },
  {
    name: 'btw',
    description: 'Ask a quick side question; the answer stays out of this chat',
    clients: ['gui', 'tui']
  },
  { name: 'fork', description: 'Branch the current session into a copy', clients: ['gui', 'tui'] },
  { name: 'cost', description: 'Session token and cost totals', clients: ['gui', 'tui'] },
  {
    name: 'skills',
    description: 'List the workspace skills (.houston/skills)',
    clients: ['gui', 'tui']
  },
  {
    name: 'agents',
    description: 'List the workspace agents (.houston/agents)',
    clients: ['gui', 'tui']
  },
  {
    name: 'agent',
    description: 'Hand a task to one of your .houston/agents (/agent <name> <task>)',
    clients: ['gui', 'tui']
  },
  { name: 'mcp', description: 'List MCP servers (add, remove, login, logout)', clients: ['gui', 'tui'] },
  {
    name: 'trust',
    description: "Show this folder's project-config trust (/trust forget re-decides)",
    clients: ['gui', 'tui']
  },
  { name: 'hooks', description: 'List configured hooks', clients: ['gui', 'tui'] },
  { name: 'theme', description: 'List or switch the color theme', clients: ['gui', 'tui'] },
  { name: 'image', description: 'Attach an image: from your clipboard, or /image <path>', clients: ['tui'] },
  { name: 'cwd', description: 'Show the working directory', clients: ['gui', 'tui'] },
  { name: 'share', description: 'Copy an invite to Houston to share with a friend', clients: ['gui', 'tui'] },
  { name: 'help', description: 'List the available slash commands', clients: ['gui', 'tui'] },
  {
    name: 'review',
    description: 'Adversarial review of your uncommitted changes',
    clients: ['gui', 'tui'],
    // Runs immediately on submit rather than expanding into the composer.
    autoRun: true,
    template: REVIEW_TEMPLATE
  },
  { name: 'exit', description: 'Leave', clients: ['tui'] },
  { name: 'quit', description: 'Leave', clients: ['tui'] }
]

/** Strip the catalog-only `clients` tag, yielding a plain `Command`. */
function toCommand(c: BuiltinCommand): Command {
  const cmd: Command = { name: c.name, description: c.description }
  if (c.template !== undefined) cmd.template = c.template
  if (c.autoRun !== undefined) cmd.autoRun = c.autoRun
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

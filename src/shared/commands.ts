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
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(args)
  return args ? `${template.trimEnd()}\n\n${args}` : template
}

/** Commands whose name starts with the typed prefix (case-insensitive). */
export function matchCommands(commands: Command[], prefix: string): Command[] {
  const p = prefix.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(p))
}

/** Resolve a command by exact name, case-insensitively (matches the menu). */
export function resolveCommand(commands: Command[], name: string): Command | undefined {
  const n = name.toLowerCase()
  return commands.find((c) => c.name.toLowerCase() === n)
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
 * First-party template commands available in every client. Unlike custom commands
 * (loaded per workspace from `.houston/commands`), these ship with the app. They
 * behave like custom commands — a `/name` expands to a prompt turn — but are always
 * present and win over a same-named custom command via `mergeCommands`.
 */
export const BUILTIN_TEMPLATE_COMMANDS: Command[] = [
  {
    name: 'review',
    description: 'Adversarial review of your uncommitted changes',
    // Runs immediately on submit rather than expanding into the composer.
    autoRun: true,
    template: REVIEW_TEMPLATE
  }
]

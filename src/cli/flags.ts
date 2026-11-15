/**
 * The standalone CLI's command-line surface as data: every run-mode flag and every
 * subcommand. It is the one source for three things that used to drift apart: the
 * argv check (which flags take a value, see `cliArgvError` in index.ts), the Options
 * and subcommand lines of `--help` (rendered from it, see `renderOptions` and
 * `renderSubcommands`), and the shell completion scripts (completion.ts). Adding a
 * flag here documents it and completes it; leaving it out makes it an unknown option.
 *
 * Kept free of imports so the entry can load it before anything else.
 */

/**
 * How a flag reads its value: `value` always takes the next word (or `=value`),
 * `switch` never does, `prompt` takes the next word unless it is another flag (`-p`
 * with the prompt piped in), and `optional` takes the next word unless it starts with
 * `-` (`-w` with a generated branch name).
 */
export type FlagKind = 'value' | 'switch' | 'prompt' | 'optional'

/** What a shell completes after the flag: a folder, a file, or one of fixed words. */
export type FlagCompletion = 'dir' | 'file' | readonly string[]

export interface CliFlag {
  /** Every spelling, short first: `['-C', '--cwd']`. */
  names: readonly string[]
  kind: FlagKind
  /** The `--help` lines; absent for flags the Usage block documents (`-i`, `-p`, `--acp`). */
  label?: string
  help?: readonly string[]
  /** One line for a completion menu; defaults to the first help line. */
  summary?: string
  /** May be given more than once (`--add-dir a --add-dir b`). */
  repeatable?: boolean
  complete?: FlagCompletion
}

export const APPROVAL_POLICIES = ['plan', 'ask', 'auto-edit', 'full-auto'] as const
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const

export const CLI_FLAGS: readonly CliFlag[] = [
  { names: ['-i', '--interactive', '--tui'], kind: 'switch', summary: 'interactive session, even when stdin is not a terminal' },
  { names: ['-p', '--prompt'], kind: 'prompt', summary: 'one-shot run of this prompt (- reads it from stdin)' },
  { names: ['--acp'], kind: 'switch', summary: 'serve the Agent Client Protocol on stdio, for editors' },
  {
    names: ['-C', '--cwd'],
    kind: 'value',
    label: '-C, --cwd <dir>',
    help: ['project folder (default: the current directory)'],
    complete: 'dir'
  },
  {
    names: ['--add-dir'],
    kind: 'value',
    label: '--add-dir <dir>',
    help: ['another folder the agent may read and edit this session', "(repeatable; like Settings' additional directories, not saved)"],
    repeatable: true,
    complete: 'dir'
  },
  {
    names: ['--provider'],
    kind: 'value',
    label: '--provider <id>',
    help: ['provider id from your settings (default: your selection)']
  },
  { names: ['--model'], kind: 'value', label: '--model <id>', help: ['model id (default: your selection)'] },
  {
    names: ['--approval'],
    kind: 'value',
    label: '--approval <policy>',
    help: ['plan | ask | auto-edit | full-auto', '(-p defaults to plan, which changes nothing)'],
    summary: 'approval policy',
    complete: APPROVAL_POLICIES
  },
  { names: ['--full-auto'], kind: 'switch', label: '--full-auto', help: ['same as --approval full-auto'] },
  {
    names: ['--on-approval'],
    kind: 'value',
    label: '--on-approval <mode>',
    help: ['(-p) approval prompts with no human: allow | deny | fail', '(default: deny, or allow under full-auto)'],
    complete: ['allow', 'deny', 'fail']
  },
  {
    names: ['--allow-shell-network'],
    kind: 'switch',
    label: '--allow-shell-network',
    help: ['(-p) let shell commands reach the network this run', '(default: offline, except under full-auto with', '--on-approval allow)']
  },
  {
    names: ['--json'],
    kind: 'switch',
    label: '--json',
    help: ['(-p) machine-readable: an init line, one JSON event per', 'line, then a {"type":"result",...} summary line'],
    summary: '(-p) machine-readable output, one JSON event per line'
  },
  {
    names: ['--effort'],
    kind: 'value',
    label: '--effort <level>',
    help: [
      `starting reasoning effort (also -p and --acp): ${EFFORT_LEVELS.join(' | ')}`,
      '(interactive: change it later with /reasoning)'
    ],
    summary: 'starting reasoning effort',
    complete: EFFORT_LEVELS
  },
  {
    names: ['--max-turns'],
    kind: 'value',
    label: '--max-turns <n>',
    help: ['(-p, --acp) hard cap on model steps for each turn']
  },
  {
    names: ['--unattended'],
    kind: 'switch',
    label: '--unattended',
    help: ['(--acp) nobody answers while a prompt runs: the agent asks', 'no questions and keeps going until the work is done'],
    summary: '(--acp) nobody answers while a prompt runs'
  },
  {
    names: ['--max-cost'],
    kind: 'value',
    label: '--max-cost <usd>',
    help: ['(-p) stop the run once its estimated cost reaches this (exit 3)']
  },
  {
    names: ['--verify'],
    kind: 'value',
    label: '--verify <command>',
    help: ['(-p) after the agent edits, run this check and send failures back']
  },
  {
    names: ['--no-memory'],
    kind: 'switch',
    label: '--no-memory',
    help: ['(-p) run without the memories saved in earlier sessions']
  },
  {
    names: ['--allowed-tools'],
    kind: 'value',
    label: '--allowed-tools <list>',
    help: ['only these tools: names, name*, or name(pattern),', "comma-separated, e.g. 'read_file,run_shell(git *)'"],
    summary: 'only these tools (comma-separated)'
  },
  {
    names: ['--disallowed-tools'],
    kind: 'value',
    label: '--disallowed-tools <list>',
    help: ['never these tools (wins over --allowed-tools)']
  },
  {
    names: ['--append-system-prompt'],
    kind: 'value',
    label: '--append-system-prompt <text|@file>',
    help: ['add instructions to the system prompt for this session'],
    repeatable: true
  },
  {
    names: ['--output-schema'],
    kind: 'value',
    label: '--output-schema <file|json>',
    help: ['(-p) the final answer must be JSON matching this schema', "(--json puts it in the result line's structured_output)"],
    complete: 'file'
  },
  {
    names: ['--mcp-config'],
    kind: 'value',
    label: '--mcp-config <file>',
    help: ['extra MCP servers for this session only'],
    repeatable: true,
    complete: 'file'
  },
  { names: ['-n', '--name'], kind: 'value', label: '-n, --name <title>', help: ["title the session's chat"] },
  {
    names: ['-w', '--worktree'],
    kind: 'optional',
    label: '-w, --worktree [name]',
    help: [
      'start in a new git worktree on a new branch from the',
      'current HEAD (default name: generated); interactive',
      'exit removes it if unused, -p keeps it'
    ],
    summary: 'start in a new git worktree on a new branch'
  },
  {
    names: ['--input-format'],
    kind: 'value',
    label: '--input-format stream-json',
    help: ['(with --json) read one {"type":"user","content":"..."}', 'line per turn from stdin until end of input'],
    summary: '(with --json) read one user turn per stdin line',
    complete: ['stream-json']
  },
  { names: ['--continue'], kind: 'switch', label: '--continue', help: ["reopen the folder's most recent session"] },
  { names: ['--resume'], kind: 'value', label: '--resume <id>', help: ['reopen a specific session'] },
  {
    names: ['--screen-reader'],
    kind: 'switch',
    label: '--screen-reader',
    help: [
      'interactive: plain lines for a screen reader (no spinner,',
      'redraws or color; numbered choices). Also',
      'HOUSTON_SCREEN_READER=1, or /screen-reader on to keep it'
    ],
    summary: 'interactive: plain lines for a screen reader'
  },
  { names: ['-h', '--help'], kind: 'switch', label: '-h, --help', help: ['this help'] },
  { names: ['-v', '--version'], kind: 'switch', label: '-v, --version', help: ['print the version'] }
]

/** A word after a subcommand: a verb (`mcp add`) or a flag (`doctor --json`). */
export interface CliWord {
  name: string
  summary: string
}

export interface CliSubcommand {
  name: string
  /** The `--help` line's left side, after `houston `. */
  usage: string
  summary: string
  /** Its verbs (`list`, `add`, ...), completed as its first word. */
  verbs?: readonly CliWord[]
  /** Its own flags, completed anywhere after it. */
  flags?: readonly CliWord[]
  /** Completes a folder as its first word (`open [dir]`). */
  dirArg?: boolean
  /** Further `--help` lines for other forms of it (`open --chat <id>`). */
  moreUsage?: readonly { usage: string; summary: string }[]
}

export const SHELLS = ['bash', 'zsh', 'fish'] as const
export type Shell = (typeof SHELLS)[number]

export const CLI_SUBCOMMANDS: readonly CliSubcommand[] = [
  {
    name: 'providers',
    usage: 'providers [...]',
    summary: 'manage model providers and their API keys',
    verbs: [
      { name: 'list', summary: 'list configured providers and hosts to add' },
      { name: 'add', summary: 'add a catalog host, or --url for a custom endpoint' },
      { name: 'remove', summary: 'remove a provider you added' },
      { name: 'set-key', summary: 'store an API key' },
      { name: 'remove-key', summary: 'forget a stored API key' }
    ]
  },
  {
    name: 'mcp',
    usage: 'mcp [...]',
    summary: 'list, add, remove, and sign in to MCP servers',
    verbs: [
      { name: 'list', summary: 'list MCP servers and whether each connects' },
      { name: 'add', summary: 'add a stdio server (<name> -- <command>) or a remote one (--url)' },
      { name: 'remove', summary: 'remove an MCP server' },
      { name: 'login', summary: 'sign in to a remote server' },
      { name: 'logout', summary: "forget a remote server's sign-in" }
    ],
    flags: [
      { name: '--url', summary: 'add a remote server at this http(s) URL' },
      { name: '--sse', summary: 'use the older HTTP+SSE transport' }
    ]
  },
  {
    name: 'doctor',
    usage: 'doctor [--json]',
    summary: 'check your setup; exits 1 when a check fails',
    flags: [{ name: '--json', summary: 'print the report as JSON' }]
  },
  {
    name: 'update',
    usage: 'update [--yes]',
    summary: 'print the upgrade command for this install; --yes runs it',
    flags: [{ name: '--yes', summary: 'run the upgrade command' }]
  },
  {
    name: 'completion',
    usage: 'completion bash|zsh|fish',
    summary: 'print a shell completion script',
    verbs: SHELLS.map((s) => ({ name: s, summary: `completion script for ${s}` }))
  },
  {
    name: 'schedule-daemon',
    usage: 'schedule-daemon [...]',
    summary: 'fire scheduled runs while Houston is closed',
    verbs: [
      { name: 'run', summary: 'fire scheduled runs until stopped' },
      { name: 'install', summary: 'start it at login, and now' },
      { name: 'uninstall', summary: 'stop it and remove it from login' },
      { name: 'status', summary: 'whether it is installed and running' }
    ]
  },
  {
    name: 'open',
    usage: 'open [dir]',
    summary: 'open a folder in the Houston desktop app',
    dirArg: true,
    flags: [{ name: '--chat', summary: 'open a saved chat by its id' }],
    moreUsage: [{ usage: 'open --chat <id>', summary: 'open a saved chat in the Houston desktop app' }]
  }
]

/** The help column: labels up to this wide share a line with their help. */
const HELP_COLUMN = 24
const LABEL_INDENT = '  '

/** The Options block of `--help`, rendered from CLI_FLAGS. */
export function renderOptions(flags: readonly CliFlag[] = CLI_FLAGS): string {
  const lines: string[] = []
  const pad = ' '.repeat(HELP_COLUMN)
  for (const f of flags) {
    if (!f.label || !f.help?.length) continue
    const head = `${LABEL_INDENT}${f.label}`
    const [first, ...rest] = f.help
    if (head.length < HELP_COLUMN) lines.push(`${head.padEnd(HELP_COLUMN - 1)} ${first}`)
    else lines.push(head, `${pad}${first}`)
    for (const r of rest) lines.push(`${pad}${r}`)
  }
  return `${lines.join('\n')}\n`
}

/** The subcommand lines of the Usage block, rendered from CLI_SUBCOMMANDS. */
export function renderSubcommands(subs: readonly CliSubcommand[] = CLI_SUBCOMMANDS): string {
  const line = (usage: string, summary: string): string => `${LABEL_INDENT}${`houston ${usage}`.padEnd(36)} ${summary}`
  return `${subs.flatMap((s) => [line(s.usage, s.summary), ...(s.moreUsage ?? []).map((m) => line(m.usage, m.summary))]).join('\n')}\n`
}

/** Every spelling of the flags of one kind. */
export function flagNames(kind: FlagKind, flags: readonly CliFlag[] = CLI_FLAGS): Set<string> {
  return new Set(flags.filter((f) => f.kind === kind).flatMap((f) => f.names))
}

/** The completion-menu line for a flag. */
export function flagSummary(f: CliFlag): string {
  return f.summary ?? f.help?.[0] ?? ''
}

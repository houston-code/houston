import type * as CliRun from './run'
import { launchDetached, resolveDirectory, runOpenCommand } from './openInApp'

/**
 * Standalone CLI entry — the interactive TUI (`-i`) and one-shot headless (`-p`)
 * clients as a plain Node program, no Electron (and so no Chromium, no display
 * server). It reuses the exact client wiring the desktop app boots
 * (terminalEntry.ts) after swapping in Node-side host capabilities:
 *
 *   - profile dir: the same per-platform path Electron resolves (paths.ts), so
 *     settings and conversations are shared with the desktop app when both are
 *     installed; `HOUSTON_DATA_DIR` isolates a profile.
 *   - credentials: env-first with an optional credentials file (credentials.ts) —
 *     Electron's safeStorage needs a running desktop app and an OS keyring.
 *
 * Capabilities that require Chromium stay desktop-only: `view_localhost`
 * (offscreen screenshot) needs a capture backend the CLI never wires, so the loop
 * omits it from the toolset entirely — the agent isn't offered a tool it can't
 * use. The build (scripts/build-cli.mjs) fails if `electron` ever sneaks into this
 * entry's module graph.
 *
 * This file stays light on purpose: it answers `-h`/`-v` and checks the Node version
 * before anything else is evaluated, and only then loads the real program (run.ts:
 * host wiring, the agent core, the store, the TUI) with a dynamic import. The bundle
 * turns that import into a lazily initialised module, so `houston --version` skips
 * evaluating the whole agent.
 */

// Injected by the build (scripts/build-cli.mjs); absent under tsc/vitest.
declare const __HOUSTON_VERSION__: string | undefined

const VERSION = typeof __HOUSTON_VERSION__ === 'string' ? __HOUSTON_VERSION__ : 'dev'

/** Node major this build targets (esbuild `target: node22`); older crashes cryptically. */
const MIN_NODE_MAJOR = 22

/**
 * The bundle is emitted for Node 22, and `engines` doesn't govern a downloaded
 * `.cjs`, so guard the runtime explicitly: an old Node otherwise dies with an
 * opaque syntax/API error. Pure (takes the version string) so it's unit-testable.
 * Returns an error message, or null when the runtime is new enough / unparseable.
 */
export function nodeVersionError(nodeVersion: string, min = MIN_NODE_MAJOR): string | null {
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (Number.isNaN(major)) return null // unrecognizable version — don't block on it
  if (major < min) {
    return `Houston CLI requires Node ${min} or newer (this is ${nodeVersion}). Install Node ${min}+ and re-run.`
  }
  return null
}

export const USAGE = `Houston CLI ${VERSION}: coding agent in your terminal (no desktop app required).

Usage:
  houston [options]                    stay-resident interactive session (bare command; same as -i)
  houston -i [options]                 interactive session, even when stdin is not a terminal
                                       (also --interactive, --tui)
  houston -p "<prompt>" [options]      one-shot run; assistant text on stdout (also --prompt)
  houston -p - [options] < task.md     one-shot run with the prompt read from stdin
  houston --acp                        serve the Agent Client Protocol on stdio, for editors

  houston providers [...]              manage model providers and their API keys
  houston open [dir]                   open a folder in the Houston desktop app

Options:
  -C, --cwd <dir>       project folder (default: the current directory)
  --provider <id>       provider id from your settings (default: your selection)
  --model <id>          model id (default: your selection)
  --approval <policy>   plan | ask | auto-edit | full-auto
                        (-p defaults to plan, which changes nothing)
  --full-auto           same as --approval full-auto
  --on-approval <mode>  (-p) approval prompts with no human: allow | deny | fail
                        (default: deny, or allow under full-auto)
  --allow-shell-network (-p) let shell commands reach the network this run
                        (default: offline, except under full-auto with
                        --on-approval allow)
  --json                (-p) machine-readable: an init line, one JSON event per
                        line, then a {"type":"result",...} summary line
  --effort <level>      (-p) reasoning effort for this run: off | low | medium | high | xhigh
  --max-turns <n>       (-p) hard cap on model steps for this run
  --max-cost <usd>      (-p) tell the agent to wrap up once the run costs this much
  --verify <command>    (-p) after the agent edits, run this check and send failures back
  --no-memory           (-p) run without the memories saved in earlier sessions
  --allowed-tools <list>
                        (-p) only these tools: names, name*, or name(pattern),
                        comma-separated, e.g. 'read_file,run_shell(git *)'
  --disallowed-tools <list>
                        (-p) never these tools (wins over --allowed-tools)
  --append-system-prompt <text|@file>
                        (-p) add instructions to the system prompt for this run
  --output-schema <file|json>
                        (-p) the final answer must be JSON matching this schema
                        (--json puts it in the result line's structured_output)
  --mcp-config <file>   (-p) extra MCP servers for this run only
  --input-format stream-json
                        (with --json) read one {"type":"user","content":"..."}
                        line per turn from stdin until end of input
  --continue            reopen the folder's most recent session
  --resume <id>         reopen a specific session
  -h, --help            this help
  -v, --version         print the version

One-shot exit codes:
  0  the agent finished              1  error, stall, or --on-approval fail
  2  bad flag value or empty prompt  3  hit a budget (step cap or output limit)
  4  the answer did not match --output-schema
  5  the last --verify check still failed

Providers:
  houston providers                    list configured providers and hosts to add
  houston providers add <id>           add a catalog host (e.g. openrouter, groq)
  houston providers add --url <url>    add a custom OpenAI-compatible endpoint
  houston providers remove <id>        remove a provider you added
  houston providers set-key <id> [key] store an API key (key from arg or stdin)
  houston providers remove-key <id>    forget a stored API key

Credentials (checked in this order):
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / HOUSTON_API_KEY_<ID>
  <profile>/cli-credentials.json: {"<provider-id>": "<key>"} with 0600 perms

Custom provider/MCP auth headers (optional):
  <profile>/cli-headers.json: {"provider:<id>"|"mcp:<id>": {"<Header>": "<value>"}} with 0600 perms

MCP OAuth (remote servers that require sign-in):
  run /mcp login <n> in an interactive session; tokens land in <profile>/cli-mcp-oauth.json (0600)

Profile: shared with the desktop app; override with HOUSTON_DATA_DIR.
`

/** The Usage block of --help: the run modes, without the option list. */
export function shortUsage(): string {
  const start = USAGE.indexOf('Usage:')
  const end = USAGE.indexOf('Options:')
  return start >= 0 && end > start ? USAGE.slice(start, end) : USAGE
}

/** Flags that take a value (`--flag value` or `--flag=value`). */
const VALUE_FLAGS = new Set([
  '-C',
  '--cwd',
  '--provider',
  '--model',
  '--approval',
  '--resume',
  '--on-approval',
  '--effort',
  '--max-turns',
  '--max-cost',
  '--verify',
  '--allowed-tools',
  '--disallowed-tools',
  '--append-system-prompt',
  '--output-schema',
  '--mcp-config',
  '--input-format'
])
/** Flags that stand alone. */
const SWITCH_FLAGS = new Set([
  '-i',
  '--interactive',
  '--tui',
  '--acp',
  '--full-auto',
  '--continue',
  '--json',
  '--allow-shell-network',
  '--no-memory',
  '-h',
  '--help',
  '-v',
  '--version'
])
/** `-p` takes the prompt, or nothing (then the prompt comes from piped stdin). */
const PROMPT_FLAGS = new Set(['-p', '--prompt'])

function flagName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq >= 0 ? arg.slice(0, eq) : arg
}

/**
 * Check a run-mode command line (everything after `houston`) for a typo'd flag, a
 * flag missing its value, or a stray word. The run-mode parsers skip what they
 * don't know (they also read the desktop app's argv, where Electron adds its own),
 * so without this `houston --modle x` or `houston "fix the bug"` silently opened an
 * empty session. Returns the message to show above the usage, or null when fine.
 */
export function cliArgvError(args: string[]): string | null {
  const isKnown = (a: string): boolean => {
    const n = flagName(a)
    return VALUE_FLAGS.has(n) || SWITCH_FLAGS.has(n) || PROMPT_FLAGS.has(n)
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const name = flagName(arg)
    const inline = arg.includes('=')
    if (PROMPT_FLAGS.has(name)) {
      // Its value is the next word unless that is another flag (`-p --json` with
      // the prompt piped in).
      if (!inline && args[i + 1] !== undefined && !isKnown(args[i + 1])) i++
      continue
    }
    if (VALUE_FLAGS.has(name)) {
      if (inline) continue
      if (args[i + 1] === undefined) return `${name} needs a value`
      i++
      continue
    }
    if (SWITCH_FLAGS.has(name)) {
      if (inline) return `${name} takes no value`
      continue
    }
    if (arg.startsWith('-') && arg !== '-') return `unknown option: ${name}`
    return `unexpected argument: ${JSON.stringify(arg)}. To run a prompt once, use -p ${JSON.stringify(arg)}`
  }
  return null
}

/** The loaded program module, once a real mode has been reached (fatal logging, flush). */
let program: typeof CliRun | undefined

/**
 * Load the real program. Only reached for a real mode, never for `-h`/`-v`. Injectable
 * so tests can observe which invocations reach it.
 */
export async function loadProgram(): Promise<typeof CliRun> {
  program ??= await import('./run')
  return program
}

/** Run one CLI invocation and return its exit code. */
export async function main(
  argv: string[] = process.argv,
  load: () => Promise<typeof CliRun> = loadProgram
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  // `houston open [dir]` hands a folder to the desktop app. Matched only as the very
  // first argument, so a prompt that happens to be the word "open" (`-p open`) still
  // runs as a prompt. Needs no profile or credentials, so it runs before the wiring.
  if (argv[2] === 'open') {
    return runOpenCommand(argv.slice(3), {
      cwd: process.cwd(),
      platform: process.platform,
      resolveDirectory,
      launch: launchDetached,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s)
    })
  }

  // Checked after -h/-v (those stay useful on any Node) but before any real work.
  const versionError = nodeVersionError(process.version)
  if (versionError) {
    process.stderr.write(`${versionError}\n`)
    return 1
  }

  const run = await load()
  return run.runCli(argv, {
    version: VERSION,
    usage: USAGE,
    argvProblem: (args) => {
      const error = cliArgvError(args)
      // The short usage, not all of --help: the error must stay on screen.
      return error ? `houston: ${error}\n\n${shortUsage()}Run houston --help for every option.\n` : null
    }
  })
}

/** Log a fatal error to the profile log when the program (and so the logger) is loaded. */
function logFatal(tag: string, err: unknown): void {
  program?.log.error(tag, err)
}

/** Flush debounced rule-usage writes, which process.exit would otherwise drop. */
function flushBeforeExit(): void {
  program?.flushRuleUsage()
}

/** True when this module is the executed entry (bundled CLI), not an import. */
function isDirectRun(): boolean {
  return typeof require !== 'undefined' && require.main === module
}

if (isDirectRun()) {
  // Mirror the desktop headless path's fatal handling: log, one-line stderr, exit.
  process.on('uncaughtException', (err) => {
    logFatal('uncaughtException', err)
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logFatal('unhandledRejection', reason)
    process.stderr.write(`Fatal: ${reason instanceof Error ? reason.message : String(reason)}\n`)
    process.exit(1)
  })

  void main().then(
    (code) => {
      flushBeforeExit()
      process.exit(code)
    },
    (e) => {
      process.stderr.write(`Fatal: ${(e as Error).message}\n`)
      flushBeforeExit()
      process.exit(1)
    }
  )
}

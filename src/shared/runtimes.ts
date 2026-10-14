/**
 * Language runtimes the agent commonly shells out to, and how to tell that one is
 * missing from a `run_shell` result.
 *
 * When `node` (or `python3`, `go`, …) isn't installed, the agent used to discover
 * it mid-run and improvise: write a whole project it could never build, or try a
 * system install (`brew install node`) from inside the sandbox, which can't work.
 * Detecting it here lets Houston do two things instead: tell the model plainly
 * not to install system packages itself, and show the user a one-click install
 * in their own terminal.
 *
 * Pure and string-only; the main process supplies the platform and whether
 * Homebrew is present when it builds the install suggestion.
 */

export type RuntimeId = 'node' | 'python' | 'go' | 'rust' | 'deno' | 'bun'

export interface RuntimeInfo {
  id: RuntimeId
  /** Display name. */
  label: string
  /** Executables that belong to this runtime (a missing one implies the runtime is). */
  commands: readonly string[]
  /** Official download page, the fallback when there's no install command. */
  url: string
  /** `brew install …` formula on macOS. */
  brew?: string
  /** `winget install …` package id on Windows. */
  winget?: string
  /** An official cross-platform installer command (POSIX shells). */
  posixInstaller?: string
}

export const RUNTIMES: readonly RuntimeInfo[] = [
  {
    id: 'node',
    label: 'Node.js',
    commands: ['node', 'npm', 'npx', 'corepack'],
    url: 'https://nodejs.org/en/download',
    brew: 'node',
    winget: 'OpenJS.NodeJS.LTS'
  },
  {
    id: 'python',
    label: 'Python',
    commands: ['python3', 'python', 'pip3', 'pip'],
    url: 'https://www.python.org/downloads/',
    brew: 'python'
  },
  {
    id: 'go',
    label: 'Go',
    commands: ['go', 'gofmt'],
    url: 'https://go.dev/dl/',
    brew: 'go',
    winget: 'GoLang.Go'
  },
  {
    id: 'rust',
    label: 'Rust',
    commands: ['cargo', 'rustc', 'rustup'],
    url: 'https://rustup.rs/',
    winget: 'Rustlang.Rustup',
    posixInstaller: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  },
  {
    id: 'deno',
    label: 'Deno',
    commands: ['deno'],
    url: 'https://docs.deno.com/runtime/getting_started/installation/',
    brew: 'deno',
    winget: 'DenoLand.Deno'
  },
  {
    id: 'bun',
    label: 'Bun',
    commands: ['bun', 'bunx'],
    url: 'https://bun.sh/docs/installation',
    brew: 'oven-sh/bun/bun'
  }
]

const BY_COMMAND = new Map<string, RuntimeInfo>(
  RUNTIMES.flatMap((r) => r.commands.map((c) => [c, r] as const))
)

export function runtimeById(id: RuntimeId): RuntimeInfo {
  const r = RUNTIMES.find((x) => x.id === id)
  if (!r) throw new Error(`unknown runtime ${id}`)
  return r
}

/**
 * Shell diagnostics that mean "this executable isn't on PATH": bash and sh
 * ("x: command not found", dash's "x: not found"), zsh ("command not found: x"),
 * a `#!/usr/bin/env node` shebang ("env: node: No such file or directory",
 * how an installed npm script reports a missing node), and Windows `cmd.exe`
 * ("'node' is not recognized as an internal or external command"), the shell
 * run_shell falls back to when Git Bash isn't installed.
 */
const NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)[^\n]*?\b(?:ba|z|da)?sh: (?:line \d+: |\d+: )?([A-Za-z0-9._+-]+): (?:command )?not found/g,
  /(?:^|\n)[^\n]*?\bzsh: command not found: ([A-Za-z0-9._+-]+)/g,
  /(?:^|\n)[^\n]*?\benv: ['‘]?([A-Za-z0-9._+-]+)['’]?: No such file or directory/g,
  /(?:^|\n)'([A-Za-z0-9._+-]+)' is not recognized as an internal or external command/g
]

/**
 * Exit statuses that mean "command not found": 127 from POSIX shells (and Git
 * Bash on Windows), 9009 from `cmd.exe`.
 */
const NOT_FOUND_EXIT_CODES: ReadonlySet<number> = new Set([127, 9009])

/**
 * The runtime a failed shell command was missing, or null. Requires a
 * "command not found" exit status (see NOT_FOUND_EXIT_CODES) so a log line that
 * merely mentions the phrase can't trigger it. The first known runtime named wins.
 */
export function missingRuntime(output: string, exitCode: number | null | undefined): RuntimeInfo | null {
  if (exitCode == null || !NOT_FOUND_EXIT_CODES.has(exitCode)) return null
  let best: { index: number; runtime: RuntimeInfo } | null = null
  for (const re of NOT_FOUND_PATTERNS) {
    for (const m of output.matchAll(re)) {
      const runtime = BY_COMMAND.get(m[1])
      if (runtime && (!best || (m.index ?? 0) < best.index)) best = { index: m.index ?? 0, runtime }
    }
  }
  return best?.runtime ?? null
}

/** The exit code a `run_shell` result reports in its `[exit code: N]` trailer. */
export function shellExitCode(output: string): number | null {
  const all = [...output.matchAll(/\[exit code: (\d+)\]/g)]
  const last = all.at(-1)
  return last ? Number(last[1]) : null
}

/** How the user can install a runtime on this machine. */
export interface InstallSuggestion {
  /** A command to run in the user's own terminal, when there's a reliable one. */
  command?: string
  /** Official download page (always present, the fallback). */
  url: string
}

export function installSuggestion(
  runtime: RuntimeInfo,
  host: { platform: NodeJS.Platform; hasBrew: boolean; hasWinget?: boolean }
): InstallSuggestion {
  const { platform, hasBrew, hasWinget = true } = host
  let command: string | undefined
  if (platform === 'darwin' && hasBrew && runtime.brew) command = `brew install ${runtime.brew}`
  else if (platform === 'win32' && hasWinget && runtime.winget)
    command = `winget install --id ${runtime.winget} -e`
  else if (platform !== 'win32' && runtime.posixInstaller) command = runtime.posixInstaller
  return command ? { command, url: runtime.url } : { url: runtime.url }
}

/**
 * Appended to the `run_shell` result for the model. The point is to stop the
 * improvisation seen in practice: a system-level install attempted from inside
 * the sandbox (which can't succeed and isn't the agent's call to make), or a
 * whole project written against a toolchain nobody can run.
 */
export function missingRuntimeHint(runtime: RuntimeInfo): string {
  return (
    `[Houston: ${runtime.label} is not installed, or not on the PATH Houston sees. ` +
    `The user has been shown a one-click install. Do not install system packages ` +
    `yourself (brew, apt, winget, sudo, curl | sh); they can't work from the sandbox and ` +
    `are the user's call. Tell the user ${runtime.label} is needed and ask them to install ` +
    `it, then pause work that depends on it rather than writing code you can't run.]`
  )
}

/** One-line message for the terminal clients when a runtime is missing. User-facing. */
export function runtimeMissingLine(e: {
  label: string
  installCommand?: string
  url: string
}): string {
  return e.installCommand
    ? `! ${e.label} isn't installed. Install it in another terminal with: ${e.installCommand}  (or see ${e.url})`
    : `! ${e.label} isn't installed. Download it from ${e.url}`
}

import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * How to start a stdio MCP server's command on this platform.
 *
 * On Windows, Node's spawn (libuv) only finds `.com`/`.exe` files on PATH, and since
 * CVE-2024-27980 it refuses to run a `.cmd`/`.bat` without a shell. But most stdio
 * servers are launched through npm's shims (`npx`, `pnpm dlx`, a globally installed
 * server), which on Windows are `.cmd` files, so `npx -y some-server` failed with
 * ENOENT. Here the command is resolved against PATH + PATHEXT the way Windows itself
 * does, and a batch file is run through `cmd.exe /d /v:off /s /c` with every argument
 * quoted.
 *
 * cmd.exe re-parses that command line, so the quoting is the security boundary:
 * inside double quotes `&`, `|`, `<`, `>`, `^` and `(` are literal, but a `"` would end
 * the quoting, `%VAR%` expands even inside quotes, and `!VAR!` expands under delayed
 * expansion (which a batch file can turn on itself). There is no reliable escape for
 * those through cmd.exe plus a shim's own `%*` re-parse, so an argument containing one
 * (or a line break / NUL) is refused rather than passed on altered. `shell: true` is
 * never used.
 */

export interface StdioLaunch {
  command: string
  args: string[]
  /** Set when the args are a pre-quoted cmd.exe command line Node must not re-quote. */
  windowsVerbatimArguments?: boolean
}

export interface StdioLaunchDeps {
  /** Platform override (defaults to process.platform); injected in tests. */
  platform?: NodeJS.Platform
  exists?: (p: string) => boolean
  /** The cmd.exe to use (defaults to %ComSpec%, as Node's own shell option does). */
  comspec?: string
  /** Base for a relative command path (defaults to process.cwd()). */
  cwd?: string
}

/** Suffixes Windows can launch for a stdio server, in PATHEXT's default order. */
const DEFAULT_EXTS = ['.com', '.exe', '.bat', '.cmd']
const BATCH_EXTS = new Set(['.bat', '.cmd'])

/** Characters cmd.exe can't be made to pass through literally (see the module comment). */
const CMD_UNSAFE = /["%!\r\n\0]/

/** An environment variable looked up case-insensitively (Windows env names are). */
function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** The launchable suffixes in PATHEXT order (unknown ones like .js/.vbs/.ps1 dropped). */
function launchableExts(env: NodeJS.ProcessEnv): string[] {
  const listed = (envVar(env, 'PATHEXT') ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => DEFAULT_EXTS.includes(e))
  return listed.length > 0 ? [...new Set(listed)] : DEFAULT_EXTS
}

/**
 * The file a Windows command names: probed dir-major over PATH (each dir tried with
 * every PATHEXT suffix before the next dir, as Windows does), or relative to `cwd` /
 * as given for a path. The current directory is never searched for a bare name, so
 * a checkout can't plant an `npx.cmd` that shadows the real one. Null when nothing
 * matches, and the command is then spawned unchanged (to fail with ENOENT as before).
 */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  deps: StdioLaunchDeps = {}
): string | null {
  const exists = deps.exists ?? existsSync
  const exts = launchableExts(env)
  const ext = win32.extname(command).toLowerCase()
  const suffixes = DEFAULT_EXTS.includes(ext) ? [''] : exts
  if (/[\\/:]/.test(command)) {
    const base = win32.isAbsolute(command) ? command : win32.resolve(deps.cwd ?? process.cwd(), command)
    for (const s of suffixes) if (exists(base + s)) return base + s
    return null
  }
  const dirs = (envVar(env, 'PATH') ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const s of suffixes) {
      const candidate = win32.join(dir, command + s)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** One argument quoted for a cmd.exe command line, or an error when it can't be. */
function quoteForCmd(arg: string, what: string): string {
  if (CMD_UNSAFE.test(arg)) {
    throw new Error(
      `${what} contains a character (", %, ! or a line break) that can't be passed safely through cmd.exe, which Windows needs to run this server's .cmd/.bat command`
    )
  }
  // The target parses its argv with the MSVC rules, where backslashes right before
  // the closing quote escape it: double them so the quote still closes the argument.
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

/** Plan the spawn of a stdio server: unchanged off Windows, PATHEXT-aware on it. */
export function planStdioLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: StdioLaunchDeps = {}
): StdioLaunch {
  if ((deps.platform ?? process.platform) !== 'win32') return { command, args }
  const resolved = resolveWindowsCommand(command, env, deps)
  if (!resolved) return { command, args }
  if (!BATCH_EXTS.has(win32.extname(resolved).toLowerCase())) return { command: resolved, args }
  const line = [
    quoteForCmd(resolved, 'The command path'),
    ...args.map((a, i) => quoteForCmd(a, `Argument ${i + 1}`))
  ].join(' ')
  return {
    command: deps.comspec ?? process.env.ComSpec ?? 'cmd.exe',
    // /d: skip AutoRun commands; /v:off: no !VAR! expansion; /s /c: strip exactly
    // the outer quotes below and run the rest as one command.
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true
  }
}

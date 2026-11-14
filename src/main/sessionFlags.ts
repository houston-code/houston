import { promises as fsp, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  isReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type ToolScope,
  type ToolScopeEntry
} from '@shared/agent'
import type { McpServerConfig } from '@shared/types'
import { parseProjectMcpServers } from './agent/projectConfig'
import { parseToolList } from './agent/toolScope'
import { getTool } from './agent/tools'
import { stripControlChars } from './tui-wrap'

/**
 * Launch flags both terminal clients take, the interactive TUI and the one-shot
 * headless run alike: they shape a whole session rather than one mode's output.
 * Parsed here once so `houston -i --effort high` and `houston -p … --effort high`
 * can't drift apart, and resolved (files read, tool names checked) by
 * {@link resolveSessionInputs} before anything runs.
 */
export interface SessionFlags {
  /** `--effort`: the chat's starting reasoning effort. */
  effort?: ReasoningEffort
  /** `--allowed-tools`: the only tools (or tool calls) the session may use. */
  allowedTools?: ToolScopeEntry[]
  /** `--disallowed-tools`: tools (or tool calls) the session may never use. Wins over allowed. */
  disallowedTools?: ToolScopeEntry[]
  /** `--append-system-prompt`, each as given: text, or `@` and an absolute file path. */
  appendSystemPrompt?: string[]
  /** `--mcp-config`: absolute paths of files listing MCP servers for this session only. */
  mcpConfig?: string[]
  /** `-n` / `--name`: the chat's title, set at start. */
  title?: string
  /**
   * `--add-dir`: extra directories (absolute, checked to exist, deduped) the session's
   * runs may work in, sent as the run request's `addDirs`.
   */
  addDirs?: string[]
}

/** Flags {@link parseSessionFlag} reads that take a value. */
export const SESSION_VALUE_FLAGS = [
  '--effort',
  '--allowed-tools',
  '--disallowed-tools',
  '--append-system-prompt',
  '--mcp-config',
  '-n',
  '--name',
  '--add-dir'
] as const

/** Longest `--name` title accepted. */
export const MAX_SESSION_TITLE = 200

function nameOf(arg: string): string {
  const eq = arg.indexOf('=')
  return eq >= 0 ? arg.slice(0, eq) : arg
}

function valueAt(argv: string[], i: number): { value?: string; next: number } {
  const arg = argv[i]
  const eq = arg.indexOf('=')
  if (eq >= 0) return { value: arg.slice(eq + 1), next: i }
  const v = argv[i + 1]
  if (v === undefined) return { value: undefined, next: i }
  return { value: v, next: i + 1 }
}

function quoted(value: string | undefined): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

/**
 * A directory for `--add-dir` or the TUI's `/add-dir`, resolved against `base` (where
 * the command was typed, or the session's folder) and checked to exist.
 */
export function resolveAddDir(value: string | undefined, base: string): { dir: string } | { error: string } {
  const v = value?.trim()
  if (!v) return { error: 'needs the path of a directory, like ../shared' }
  const dir = isAbsolute(v) ? v : resolvePath(base, v)
  try {
    if (statSync(dir).isDirectory()) return { dir }
  } catch {
    // reported below
  }
  return { error: `${JSON.stringify(v)} is not a directory` }
}

/**
 * Read the session flag at `argv[i]` into `flags`. Returns the index of the last
 * word it consumed, or null when `argv[i]` isn't a session flag (the caller's own
 * parser handles it). A bad value goes to `bad` (the first one is kept by the
 * caller) and the flag is left unset. Paths resolve against `cwd`.
 */
export function parseSessionFlag(
  argv: string[],
  i: number,
  cwd: string,
  flags: SessionFlags,
  bad: (message: string) => void
): number | null {
  const name = nameOf(argv[i])
  switch (name) {
    case '--effort': {
      const { value, next } = valueAt(argv, i)
      if (isReasoningEffort(value)) flags.effort = value
      else bad(`--effort must be one of ${REASONING_EFFORTS.join(', ')} (got ${quoted(value)})`)
      return next
    }
    case '--allowed-tools':
    case '--disallowed-tools': {
      const { value, next } = valueAt(argv, i)
      const parsed = parseToolList(value ?? '', name)
      if ('error' in parsed) bad(parsed.error)
      else if (name === '--allowed-tools') flags.allowedTools = [...(flags.allowedTools ?? []), ...parsed.entries]
      else flags.disallowedTools = [...(flags.disallowedTools ?? []), ...parsed.entries]
      return next
    }
    case '--append-system-prompt': {
      const { value, next } = valueAt(argv, i)
      if (value === undefined || !value.trim() || value.trim() === '@') {
        bad('--append-system-prompt needs text, or @ and a file path, like --append-system-prompt @ci-rules.md')
      } else {
        const v = value.startsWith('@') ? `@${resolvePath(cwd, value.slice(1))}` : value
        flags.appendSystemPrompt = [...(flags.appendSystemPrompt ?? []), v]
      }
      return next
    }
    case '--mcp-config': {
      const { value, next } = valueAt(argv, i)
      if (value?.trim()) flags.mcpConfig = [...(flags.mcpConfig ?? []), resolvePath(cwd, value.trim())]
      else bad('--mcp-config needs the path of a JSON file listing MCP servers')
      return next
    }
    case '-n':
    case '--name': {
      const { value, next } = valueAt(argv, i)
      // A title reaches the terminal (the /resume list, the status of a resumed chat),
      // so control characters never make it in.
      const title = stripControlChars(value ?? '').replace(/\s+/g, ' ').trim()
      if (!title) bad(`${name} needs a title, like ${name} "fix the login bug"`)
      else if (title.length > MAX_SESSION_TITLE) bad(`${name} takes at most ${MAX_SESSION_TITLE} characters`)
      else flags.title = title
      return next
    }
    case '--add-dir': {
      const { value, next } = valueAt(argv, i)
      const added = resolveAddDir(value, cwd)
      if ('error' in added) bad(`--add-dir: ${added.error}`)
      else if (!flags.addDirs?.includes(added.dir)) flags.addDirs = [...(flags.addDirs ?? []), added.dir]
      return next
    }
    default:
      return null
  }
}

/** The session flags, as set in `flags`, for spreading into a parser's result. */
export function sessionFlagFields(flags: SessionFlags): SessionFlags {
  return {
    ...(flags.effort !== undefined ? { effort: flags.effort } : {}),
    ...(flags.allowedTools !== undefined ? { allowedTools: flags.allowedTools } : {}),
    ...(flags.disallowedTools !== undefined ? { disallowedTools: flags.disallowedTools } : {}),
    ...(flags.appendSystemPrompt?.length ? { appendSystemPrompt: flags.appendSystemPrompt } : {}),
    ...(flags.mcpConfig?.length ? { mcpConfig: flags.mcpConfig } : {}),
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    ...(flags.addDirs?.length ? { addDirs: flags.addDirs } : {})
  }
}

/** A scope entry the way the flag spelled it (the init line, the startup note). */
export const scopeEntryText = (e: ToolScopeEntry): string => (e.match === '*' ? e.tool : `${e.tool}(${e.match})`)

/** Most MCP servers `--mcp-config` may add, matching the cap on a project's own. */
const MAX_RUN_MCP_SERVERS = 10

/** Largest `--output-schema` / `--append-system-prompt` / `--mcp-config` file read, in bytes. */
export const MAX_INPUT_FILE_BYTES = 256 * 1024

/** Read a flag's file, refusing an oversized one before loading it. */
export async function readFlagFile(path: string): Promise<string> {
  const { size } = await fsp.stat(path)
  if (size > MAX_INPUT_FILE_BYTES) throw new Error(`larger than ${MAX_INPUT_FILE_BYTES / 1024} KB`)
  return fsp.readFile(path, 'utf8')
}

/** What the session flags that name files or tools resolve to. */
export interface SessionInputs {
  appendSystemPrompt?: string
  mcpServers?: McpServerConfig[]
  toolScope?: ToolScope
}

/** How {@link resolveSessionInputs} reaches the disk (injectable for tests). */
export interface SessionInputFs {
  readFile: (path: string) => Promise<string>
}

/** Read a flag's file through `readFile`, as text or the usage error. */
export async function readSessionFile(
  path: string,
  flag: string,
  readFile: (path: string) => Promise<string>
): Promise<string | { error: string }> {
  try {
    const text = await readFile(path)
    if (Buffer.byteLength(text) > MAX_INPUT_FILE_BYTES) {
      return { error: `${flag}: ${path} is larger than ${MAX_INPUT_FILE_BYTES / 1024} KB` }
    }
    return text
  } catch (e) {
    return { error: `${flag}: cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` }
  }
}

/**
 * Read and validate the session flags that name files or tools. Returns the values,
 * or the usage error for the first bad one, so a missing file or a misspelled tool
 * stops the session before any model call. (`--add-dir` is checked while parsing.)
 */
export async function resolveSessionInputs(
  flags: SessionFlags,
  fs: SessionInputFs
): Promise<SessionInputs | { error: string }> {
  const out: SessionInputs = {}

  if (flags.appendSystemPrompt?.length) {
    const parts: string[] = []
    for (const arg of flags.appendSystemPrompt) {
      const text = arg.startsWith('@')
        ? await readSessionFile(arg.slice(1), '--append-system-prompt', fs.readFile)
        : arg
      if (typeof text !== 'string') return text
      if (!text.trim()) return { error: `--append-system-prompt: ${arg.startsWith('@') ? arg.slice(1) : 'the text'} is empty` }
      parts.push(text.trim())
    }
    out.appendSystemPrompt = parts.join('\n\n')
  }

  if (flags.mcpConfig?.length) {
    const servers: McpServerConfig[] = []
    for (const path of flags.mcpConfig) {
      const text = await readSessionFile(path, '--mcp-config', fs.readFile)
      if (typeof text !== 'string') return text
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (e) {
        return { error: `--mcp-config: ${path} is not valid JSON (${(e as Error).message})` }
      }
      const list = (raw as { mcpServers?: unknown } | null)?.mcpServers
      if (!Array.isArray(list)) {
        return { error: `--mcp-config: ${path} needs an "mcpServers" array, the same shape as .houston/settings.json` }
      }
      // The project-config parser is the validator (ids sanitized, a runnable target
      // required, values typed); an entry it drops is reported rather than skipped.
      for (const [i, entry] of list.entries()) {
        const [server] = parseProjectMcpServers({ mcpServers: [entry] })
        if (!server) {
          return { error: `--mcp-config: ${path}: server ${i + 1} needs an "id" and a "command" or "url"` }
        }
        if (servers.some((s) => s.id === server.id)) {
          return { error: `--mcp-config: two servers share the id "${server.id}"` }
        }
        servers.push(server)
      }
    }
    if (servers.length > MAX_RUN_MCP_SERVERS) {
      return { error: `--mcp-config: at most ${MAX_RUN_MCP_SERVERS} servers per run (got ${servers.length})` }
    }
    if (servers.length) out.mcpServers = servers
  }

  if (flags.allowedTools || flags.disallowedTools) {
    // A misspelled name would quietly scope nothing: a disallowed typo denies no
    // call, an allowed typo offers no tool. Built-in names are checked here; an MCP
    // tool's name isn't known until its server connects, so `mcp__` names pass.
    for (const [flag, list] of [
      ['--allowed-tools', flags.allowedTools],
      ['--disallowed-tools', flags.disallowedTools]
    ] as const) {
      const unknown = (list ?? []).find((e) => !e.tool.includes('*') && !e.tool.startsWith('mcp__') && !getTool(e.tool))
      if (unknown) return { error: `${flag}: unknown tool "${unknown.tool}"` }
    }
    out.toolScope = {
      ...(flags.allowedTools ? { allowed: flags.allowedTools } : {}),
      ...(flags.disallowedTools ? { disallowed: flags.disallowedTools } : {})
    }
  }

  return out
}

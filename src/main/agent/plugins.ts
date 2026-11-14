import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { log } from '../logger'

/**
 * Local plugins: small JS files in `.houston/plugins/*.js` that register
 * lifecycle hooks the agent loop fires as it runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRUST BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────────
 * Plugins are executable JavaScript evaluated IN-PROCESS, and a `vm` context is
 * NOT a security sandbox: a plugin can walk the prototype chain of the host
 * `houston.on` function it's handed back to the host realm's `Function`
 * constructor and reach `process`/`require`, i.e. arbitrary code execution in the
 * unsandboxed main process. A `.houston/plugins/*.js` file shipped inside a
 * repository is therefore attacker-controlled the moment you open that repo — the
 * same threat model `projectConfig.ts` already refuses to honor project hooks /
 * MCP servers / `allow` rules for.
 *
 * So workspace plugins are NOT loaded automatically. `loadTrustedPlugins` runs
 * them only when BOTH hold:
 *
 *  - the user turned on the `projectPlugins` setting (off by default). It is a
 *    master switch that alone is never enough: it is one global boolean, so on its
 *    own it would run the plugins of EVERY repository opened afterwards, a fresh
 *    malicious clone included; and
 *  - the user trusted THIS folder (the trusted-folders consent in projectConfig.ts)
 *    while its plugin files were exactly what is on disk now. Each plugin's name
 *    and content hash is part of the folder's elevated-config fingerprint, so a
 *    plugin added or edited afterwards (a `git pull`, or a file the sandboxed agent
 *    wrote, which is itself a protected write that asks first) drops the folder
 *    back to untrusted, and nothing runs until the user consents to the new set.
 *
 * The sources evaluated are the very bytes that were fingerprinted
 * (`readPluginFiles` reads them once, into the project config), so a file swapped
 * between the trust check and the load can't run unconsented. Houston never
 * executes plugins fetched from a registry, downloaded at runtime, or supplied by
 * the model, only files already on disk in a folder the user trusted.
 *
 * The remaining measures below are defense-in-depth against an *accidentally*
 * buggy (not adversarial) plugin once a user has opted in — they are not, and
 * cannot be, a boundary against a determined attacker:
 *
 *  1. Hooks are OBSERVATIONAL ONLY. `onToolStart` / `onToolResult` /
 *     `onUserMessage` receive a frozen copy of the event and their return value
 *     is ignored — a plugin can log/notify/measure but can NOT block a tool,
 *     mutate tool input, or alter the conversation. (Shell `PreToolUse` hooks
 *     remain the supported way to *block* a call.) This keeps the control-flow
 *     surface empty.
 *  2. Each plugin file is evaluated in a fresh `vm` context with NO ambient
 *     `require`, `process`, `module`, `globalThis`, network, or filesystem — the
 *     only capability handed in is the `houston.on(event, fn)` registrar. This is
 *     not a security sandbox against a determined attacker (a `vm` context is not
 *     a trust boundary), but it removes the easy footguns and documents intent.
 *  3. Every hook invocation is wrapped in try/catch and a wall-clock timeout, so
 *     a throwing or slow plugin degrades to a logged warning instead of stalling
 *     or crashing the agent loop. The synchronous part of each call runs under a
 *     `vm` watchdog (`runInContext` with `timeout`), so a busy loop or runaway
 *     regex is terminated at the budget instead of freezing the main process; an
 *     async listener's later continuations run outside the watchdog and are only
 *     bounded by the promise timeout (they are abandoned, not interrupted).
 *  4. Warnings go to the file logger (and, from the loop, to a run notice), never
 *     to stderr, which would draw over the terminal UI.
 *
 * If you need a plugin that can block tools or reach the network, that's a larger
 * design question (sandboxing, capability grants, approval UX) — out of scope
 * here on purpose.
 */

export const PLUGINS_DIR = '.houston/plugins'
const MAX_PLUGINS = 50
/** Cap a plugin file's size so a runaway file can't be slurped into memory. */
const MAX_PLUGIN_BYTES = 256 * 1024
/** Per-hook wall-clock budget; a slower hook is abandoned (its work may finish but is ignored). */
const HOOK_TIMEOUT_MS = 1_000
/** Time budget for evaluating a plugin file's top-level code at load. */
const LOAD_TIMEOUT_MS = 1_000

/** The lifecycle events a plugin can subscribe to. */
export type PluginEvent = 'onToolStart' | 'onToolResult' | 'onUserMessage'
const PLUGIN_EVENTS: readonly PluginEvent[] = ['onToolStart', 'onToolResult', 'onUserMessage']

/** Payload for `onToolStart`: a tool is about to run. */
export interface ToolStartEvent {
  tool: string
  input: Record<string, unknown>
}

/** Payload for `onToolResult`: a tool just finished. */
export interface ToolResultEvent {
  tool: string
  input: Record<string, unknown>
  output: string
  ok: boolean
}

/** Payload for `onUserMessage`: the user sent a message that started a run. */
export interface UserMessageEvent {
  text: string
}

interface PluginEventMap {
  onToolStart: ToolStartEvent
  onToolResult: ToolResultEvent
  onUserMessage: UserMessageEvent
}

type Listener = (payload: unknown) => unknown

/** One registered hook, tagged with the plugin file it came from (for diagnostics). */
interface Registration {
  plugin: string
  event: PluginEvent
  fn: Listener
}

/**
 * A loaded set of plugins. Holds the registered listeners and fires lifecycle
 * events. Invocation never throws and never blocks the caller beyond the per-hook
 * timeout — a plugin error is reported via the injected `warn` and otherwise
 * ignored.
 */
export class PluginHost {
  private readonly registrations: Registration[]
  private readonly warn: (msg: string) => void

  constructor(registrations: Registration[] = [], warn: (msg: string) => void = defaultWarn) {
    this.registrations = registrations
    this.warn = warn
  }

  /** Number of registered listeners (across all events). */
  get size(): number {
    return this.registrations.length
  }

  /** True if at least one listener is registered for `event`. */
  has(event: PluginEvent): boolean {
    return this.registrations.some((r) => r.event === event)
  }

  /**
   * Fire one lifecycle event. Listeners run sequentially; each is sandboxed in
   * try/catch + timeout and its return value is discarded (hooks are
   * observational). Resolves once every listener has settled or timed out.
   */
  async emit<E extends PluginEvent>(event: E, payload: PluginEventMap[E]): Promise<void> {
    const listeners = this.registrations.filter((r) => r.event === event)
    if (listeners.length === 0) return
    // Hand each listener a frozen, structured copy so it can't mutate shared state
    // the loop relies on, and one plugin can't see another's edits.
    const frozen = freezeDeep(structuredCopy(payload))
    for (const reg of listeners) {
      const started = Date.now()
      try {
        const result = callUnderWatchdog(reg.fn, frozen, HOOK_TIMEOUT_MS)
        await withTimeout(Promise.resolve(result), Math.max(0, HOOK_TIMEOUT_MS - (Date.now() - started)))
      } catch (e) {
        this.warn(`[plugin:${reg.plugin}] ${event} failed: ${errMessage(e)}`)
      }
    }
  }
}

/**
 * A dedicated context whose only job is to host the watchdog call. The listener
 * and payload are injected as globals for the duration of one synchronous
 * `runInContext`, which V8 terminates when `timeout` elapses. That interrupts any
 * JS running on the thread during the call, including a listener compiled in a
 * plugin's own context or in the main realm.
 */
const watchdogContext = vm.createContext(Object.create(null))
const watchdogScript = new vm.Script('__houstonListener(__houstonPayload)', {
  filename: 'houston-plugin-watchdog'
})

/**
 * Call `fn(payload)` with its synchronous part bounded by `timeoutMs`. Returns
 * whatever the listener returns (a promise for an async listener). Throws the
 * listener's own error, or a "timed out" error when the watchdog fired.
 */
function callUnderWatchdog(fn: Listener, payload: unknown, timeoutMs: number): unknown {
  const ctx = watchdogContext as Record<string, unknown>
  ctx.__houstonListener = fn
  ctx.__houstonPayload = payload
  try {
    return watchdogScript.runInContext(watchdogContext, { timeout: Math.max(1, timeoutMs) })
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`timed out after ${timeoutMs}ms`, { cause: e })
    }
    throw e
  } finally {
    ctx.__houstonListener = undefined
    ctx.__houstonPayload = undefined
  }
}

function defaultWarn(msg: string): void {
  log.warn(msg)
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** Reject `p` if it doesn't settle within `ms`. The underlying work isn't cancelled. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Deep structured copy, falling back to a shallow spread for non-cloneable input. */
function structuredCopy<T>(v: T): T {
  try {
    return structuredClone(v)
  } catch {
    return { ...(v as object) } as T
  }
}

/** Recursively freeze an object so listeners can't mutate the payload. */
function freezeDeep<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const key of Object.keys(v)) freezeDeep((v as Record<string, unknown>)[key])
    Object.freeze(v)
  }
  return v
}

/**
 * Evaluate one plugin's source in an isolated `vm` context and collect the hooks
 * it registers via `houston.on(event, fn)`. Returns the registrations, or `[]` if
 * the file fails to evaluate (the error is reported via `warn`).
 *
 * Exported for testing; `loadPlugins` calls it per file.
 */
export function evaluatePlugin(
  plugin: string,
  source: string,
  warn: (msg: string) => void = defaultWarn
): Registration[] {
  const registrations: Registration[] = []

  const on = (event: unknown, fn: unknown): void => {
    if (typeof event !== 'string' || !(PLUGIN_EVENTS as readonly string[]).includes(event)) {
      warn(`[plugin:${plugin}] ignored unknown event: ${String(event)}`)
      return
    }
    if (typeof fn !== 'function') {
      warn(`[plugin:${plugin}] on(${event}) expects a function`)
      return
    }
    registrations.push({ plugin, event: event as PluginEvent, fn: fn as Listener })
  }

  // The ONLY capability exposed to the plugin. No require/process/module/global
  // fetch — a fresh context starts with just the JS built-ins plus `houston`.
  const sandbox = Object.freeze({ houston: Object.freeze({ on }) })
  const context = vm.createContext(sandbox)

  try {
    const script = new vm.Script(source, { filename: `${PLUGINS_DIR}/${plugin}` })
    script.runInContext(context, { timeout: LOAD_TIMEOUT_MS })
  } catch (e) {
    warn(`[plugin:${plugin}] failed to load: ${errMessage(e)}`)
    return []
  }
  return registrations
}

/** One plugin file as read from disk: what runs, and what the folder's trust covers. */
export interface ProjectPluginFile {
  /** The file name inside `.houston/plugins/`. */
  name: string
  /** Hex SHA-256 of the file's bytes: what the trust fingerprint binds. */
  sha256: string
  /** The file's text, evaluated as-is once the folder is trusted. */
  source: string
}

/** The plugin files a workspace would load, plus the ones skipped and why. */
export interface PluginFiles {
  files: ProjectPluginFile[]
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Read every `.houston/plugins/*.js` file that would load (a regular `.js` file with
 * a plain name, under the size cap, at most {@link MAX_PLUGINS}, in sorted order) and
 * hash each one. Evaluates nothing. Never throws: a missing directory is no plugins,
 * an unreadable or oversized file is reported in `skipped`.
 *
 * This is the one reader behind both the trust fingerprint (projectConfig.ts) and the
 * loader, so the set the user consents to and the set that runs can't drift apart.
 */
export async function readPluginFiles(workspace: string): Promise<PluginFiles> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, PLUGINS_DIR), { withFileTypes: true })
  } catch {
    return { files: [], skipped: [] }
  }
  // Deterministic order so multi-plugin behavior (and the fingerprint) is stable
  // across runs and platforms. `isFile()` is false for a symlink, so a link pointing
  // out of the project is never read.
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js') && /^[\w.-]+$/.test(e.name))
    .map((e) => e.name)
    .sort()
  const files: ProjectPluginFile[] = []
  const skipped: PluginFiles['skipped'] = []
  for (const name of names) {
    if (files.length >= MAX_PLUGINS) break
    try {
      const path = join(workspace, PLUGINS_DIR, name)
      const stat = await fs.stat(path)
      if (stat.size > MAX_PLUGIN_BYTES) {
        skipped.push({ name, reason: `file exceeds ${MAX_PLUGIN_BYTES} bytes` })
        continue
      }
      const bytes = await fs.readFile(path)
      // Re-checked on the bytes actually read: the file may have grown since the stat.
      if (bytes.length > MAX_PLUGIN_BYTES) {
        skipped.push({ name, reason: `file exceeds ${MAX_PLUGIN_BYTES} bytes` })
        continue
      }
      files.push({
        name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: bytes.toString('utf8')
      })
    } catch (e) {
      skipped.push({ name, reason: errMessage(e) })
    }
  }
  return { files, skipped }
}

/** Evaluate already-read plugin files into one host. Never throws. */
function hostFromFiles(files: ProjectPluginFile[], warn: (msg: string) => void): PluginHost {
  const registrations: Registration[] = []
  for (const f of files) registrations.push(...evaluatePlugin(f.name, f.source, warn))
  return new PluginHost(registrations, warn)
}

/**
 * Load every `.houston/plugins/*.js` file in the workspace, evaluate each in
 * isolation, and return a `PluginHost` aggregating their registered hooks. A file
 * that's missing, oversized, or fails to evaluate is skipped (reported via
 * `warn`) rather than aborting the load. Always resolves, never throws.
 *
 * This applies NO trust gate; the agent loop goes through {@link loadTrustedPlugins}.
 */
export async function loadPlugins(
  workspace: string,
  warn: (msg: string) => void = defaultWarn
): Promise<PluginHost> {
  const { files, skipped } = await readPluginFiles(workspace)
  for (const s of skipped) warn(`[plugin:${s.name}] skipped: ${s.reason}`)
  return hostFromFiles(files, warn)
}

/**
 * Evaluate a workspace's plugins ONLY when the user opted in with the
 * `projectPlugins` setting AND trusted this folder for its current plugin files.
 * `trusted` is the loop's folder-trust verdict for the elevated-config fingerprint,
 * which covers each plugin file's name and hash (see projectConfig.ts). Because
 * plugins are executable JS run in-process (and `vm` is not a security boundary, see
 * the trust-boundary note above), either gate failing returns an empty host and
 * evaluates nothing. The global setting by itself never suffices: without the
 * per-folder consent it would run any repository's plugins, a freshly cloned
 * malicious one included.
 *
 * `files` are the sources read when the fingerprint was computed, so what runs is
 * byte-for-byte what was trusted.
 */
export async function loadTrustedPlugins(
  files: ProjectPluginFile[],
  gate: { enabled: boolean | undefined; trusted: boolean },
  warn: (msg: string) => void = defaultWarn
): Promise<PluginHost> {
  if (gate.enabled !== true || gate.trusted !== true || files.length === 0) {
    return new PluginHost([], warn)
  }
  return hostFromFiles(files, warn)
}

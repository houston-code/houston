import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

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
 * So workspace plugins are NOT loaded automatically. `loadPluginsIfEnabled` only
 * runs them when the user has explicitly turned on the `projectPlugins` setting
 * (off by default) for a project they trust. Houston never executes plugins
 * fetched from a registry, downloaded at runtime, or supplied by the model — only
 * files already sitting on disk in a project the user opted into.
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
 *     or crashing the agent loop.
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
      try {
        await withTimeout(Promise.resolve(reg.fn(frozen)), HOOK_TIMEOUT_MS)
      } catch (e) {
        this.warn(`[plugin:${reg.plugin}] ${event} failed: ${errMessage(e)}`)
      }
    }
  }
}

function defaultWarn(msg: string): void {
  console.warn(msg)
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

/**
 * Load every `.houston/plugins/*.js` file in the workspace, evaluate each in
 * isolation, and return a `PluginHost` aggregating their registered hooks. A file
 * that's missing, oversized, or fails to evaluate is skipped (reported via
 * `warn`) rather than aborting the load. Always resolves — never throws.
 */
export async function loadPlugins(
  workspace: string,
  warn: (msg: string) => void = defaultWarn
): Promise<PluginHost> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, PLUGINS_DIR), { withFileTypes: true })
  } catch {
    return new PluginHost([], warn)
  }

  const registrations: Registration[] = []
  // Deterministic order so multi-plugin behavior is stable across runs/platforms.
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js') && /^[\w.-]+$/.test(e.name))
    .map((e) => e.name)
    .sort()

  let loaded = 0
  for (const name of files) {
    if (loaded >= MAX_PLUGINS) break
    let source: string
    try {
      const stat = await fs.stat(join(workspace, PLUGINS_DIR, name))
      if (stat.size > MAX_PLUGIN_BYTES) {
        warn(`[plugin:${name}] skipped: file exceeds ${MAX_PLUGIN_BYTES} bytes`)
        continue
      }
      source = await fs.readFile(join(workspace, PLUGINS_DIR, name), 'utf8')
    } catch (e) {
      warn(`[plugin:${name}] skipped: ${errMessage(e)}`)
      continue
    }
    registrations.push(...evaluatePlugin(name, source, warn))
    loaded++
  }

  return new PluginHost(registrations, warn)
}

/**
 * Load workspace plugins ONLY when the user has explicitly opted in via the
 * `projectPlugins` setting. Because plugins are executable JS evaluated in-process
 * (and `vm` is not a security boundary — see the trust-boundary note above),
 * auto-running a repo's `.houston/plugins/*.js` on open would be arbitrary code
 * execution from an untrusted repository. When the setting is anything other than
 * `true`, this returns an empty `PluginHost` and never touches the workspace files.
 */
export async function loadPluginsIfEnabled(
  workspace: string,
  enabled: boolean | undefined,
  warn: (msg: string) => void = defaultWarn
): Promise<PluginHost> {
  if (enabled !== true) return new PluginHost([], warn)
  return loadPlugins(workspace, warn)
}

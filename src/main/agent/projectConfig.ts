import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { HOOK_EVENTS, type Hook, type McpServerConfig, type PermissionRule } from '@shared/types'
import { sanitizeServerId } from '@shared/mcp'
import { parseTightenOnlyRules } from './permissions'
import { loadProjectCommands } from './commands'
import { readPluginFiles, type ProjectPluginFile } from './plugins'
import { contextCommands } from '@shared/commandContext'
import { parseStatusLineConfig, type StatusLineConfig } from '@shared/statusLine'

/**
 * Per-project config from `.houston/settings.json` in the workspace.
 *
 * SECURITY: this file is part of the project, so it is attacker-controlled when
 * you open an untrusted repo. Its *tightening* subset — `deny`/`ask` permission
 * rules — is always honored. Its ELEVATING subset — `allow` rules, hooks, and MCP
 * servers, which can auto-approve actions or spawn processes — is parsed but
 * honored only once the user explicitly trusts the folder (the trusted-folders
 * consent; see `FolderTrust` in @shared/types). The trust decision is bound to a
 * fingerprint of the elevating subset, so a later change to it (e.g. a `git pull`
 * that adds a hook) drops back to untrusted and re-prompts instead of silently
 * running new commands.
 *
 * The project's plugin files (`.houston/plugins/*.js`, see plugins.ts) belong to the
 * same elevating subset: they are JavaScript the main process evaluates, outside the
 * sandbox. Each one's name and content hash is part of the fingerprint, so trusting
 * a folder consents to exactly those files, and a plugin added or edited later (by a
 * pull, or by the agent itself) un-trusts the folder until the user looks again.
 *
 * The same tighten-only shape is reused, one tier up, by the admin-locked managed
 * policy (see managedPolicy.ts), which outranks both this file and the user.
 */

export const PROJECT_CONFIG = '.houston/settings.json'
const MAX_PROJECT_RULES = 100
const MAX_PROJECT_HOOKS = 25
const MAX_PROJECT_MCP_SERVERS = 10

/**
 * Validate untrusted project JSON into safe permission rules: well-formed entries
 * whose action is `deny` or `ask` only (`allow` and anything malformed dropped).
 * Pure + exported for testing.
 */
export function parseProjectRules(raw: unknown): PermissionRule[] {
  return parseTightenOnlyRules(raw, MAX_PROJECT_RULES)
}

/** The elevating subset of a project config — honored only for a trusted folder. */
export interface ProjectElevatedConfig {
  allowRules: PermissionRule[]
  hooks: Hook[]
  mcpServers: McpServerConfig[]
  /**
   * The project's `.houston/commands` that ask for more than a prompt: tools
   * pre-approved for their turn (`allowed-tools`), or shell commands their template
   * runs (`` !`command` ``). Part of the fingerprint, so a pull that adds or widens
   * one drops a trusted folder back to asking.
   */
  commands?: ProjectCommandGrant[]
  /**
   * The `.houston/plugins/*.js` files that would load, with their sources. They run
   * only when the `projectPlugins` setting is on AND the folder is trusted for this
   * exact set (see loadTrustedPlugins).
   */
  plugins: ProjectPluginFile[]
  /**
   * The terminal's custom status line command (`statusLine`), which runs in the user's
   * shell. Part of the fingerprint when set, so adding or changing it asks again.
   */
  statusLine?: StatusLineConfig
}

/** One project command's elevating parts, as the trust fingerprint sees them. */
export interface ProjectCommandGrant {
  name: string
  allowedTools?: string
  /** The shell commands its template runs, in order. */
  shell?: string[]
}

/**
 * Validate untrusted project JSON into `allow` permission rules (the elevating
 * counterpart of {@link parseProjectRules}). Pure + exported for testing.
 */
export function parseProjectAllowRules(raw: unknown): PermissionRule[] {
  const rules = (raw as { permissionRules?: unknown })?.permissionRules
  if (!Array.isArray(rules)) return []
  const out: PermissionRule[] = []
  for (const r of rules) {
    if (out.length >= MAX_PROJECT_RULES) break
    if (typeof r !== 'object' || r === null) continue
    const { action, tool, match, exact } = r as Record<string, unknown>
    if (action !== 'allow') continue
    if (typeof tool !== 'string' || typeof match !== 'string') continue
    // Keep `exact`: dropping it would read an exact allow as a glob, widening it.
    out.push(exact === true ? { action, tool, match, exact } : { action, tool, match })
  }
  return out
}

/** Validate untrusted project JSON into hooks (known event, non-empty command). */
export function parseProjectHooks(raw: unknown): Hook[] {
  const hooks = (raw as { hooks?: unknown })?.hooks
  if (!Array.isArray(hooks)) return []
  const out: Hook[] = []
  for (const h of hooks) {
    if (out.length >= MAX_PROJECT_HOOKS) break
    if (typeof h !== 'object' || h === null) continue
    const { event, matcher, command, timeout } = h as Record<string, unknown>
    if (typeof event !== 'string' || !(HOOK_EVENTS as string[]).includes(event)) continue
    if (typeof command !== 'string' || !command.trim()) continue
    out.push({
      event: event as Hook['event'],
      matcher: typeof matcher === 'string' && matcher.trim() ? matcher.trim() : '*',
      command: command.trim(),
      // Kept only when it is a positive number; the runner clamps it (hookTimeoutMs).
      ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? { timeout } : {})
    })
  }
  return out
}

/** A string map with only string values (headers, env), or undefined when empty. */
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Validate untrusted project JSON into MCP server configs. Ids are sanitized to
 * the namespacing-safe charset; entries with no runnable target (command or url)
 * are dropped. The configs carry their headers/env VALUES verbatim — the project
 * file is the source of truth for its own servers (the values are already
 * plaintext in the repo), unlike user-level servers whose values live in the
 * encrypted secret store.
 */
export function parseProjectMcpServers(raw: unknown): McpServerConfig[] {
  const servers = (raw as { mcpServers?: unknown })?.mcpServers
  if (!Array.isArray(servers)) return []
  const out: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const s of servers) {
    if (out.length >= MAX_PROJECT_MCP_SERVERS) break
    if (typeof s !== 'object' || s === null) continue
    const v = s as Record<string, unknown>
    const id = sanitizeServerId(typeof v.id === 'string' ? v.id : '')
    if (!id || seen.has(id)) continue
    const command = typeof v.command === 'string' ? v.command.trim() : ''
    const url = typeof v.url === 'string' ? v.url.trim() : ''
    if (!command && !url) continue
    const transport = v.transport === 'http' || v.transport === 'sse' || v.transport === 'stdio' ? v.transport : undefined
    seen.add(id)
    out.push({
      id,
      ...(typeof v.name === 'string' ? { name: v.name } : {}),
      ...(transport ? { transport } : {}),
      command,
      // Numbers and booleans are written as text (`"--port", 3000`); dropping them would
      // start the server with none of its arguments.
      ...(Array.isArray(v.args) && v.args.every((a) => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')
        ? { args: v.args.map((a) => String(a)) }
        : {}),
      ...(url ? { url } : {}),
      ...(stringMap(v.headers) ? { headers: stringMap(v.headers) } : {}),
      ...(stringMap(v.env) ? { env: stringMap(v.env) } : {}),
      ...(typeof v.cwd === 'string' && v.cwd.trim() ? { cwd: v.cwd.trim() } : {}),
      enabled: v.enabled !== false
    })
  }
  return out
}

/**
 * Merge a trusted folder's project MCP servers into the user's, namespaced under
 * a `proj-` id prefix so their tools read as `mcp__proj-<id>__<tool>` and can
 * never collide with (or impersonate) a user-configured server; on the rare
 * prefixed-id collision the user's server wins. The merged entries are marked
 * `origin: 'project'` so the connection manager reads their header/env values
 * from the config itself rather than the user's secret store, and they are never
 * persisted into the user's settings (the merge happens per run).
 *
 * A stdio server starts in the folder whose config named it ({@link inWorkspace}),
 * not wherever Houston itself was launched from.
 */
export function mergeProjectMcpServers(
  user: McpServerConfig[] | undefined,
  project: McpServerConfig[],
  workspace: string
): McpServerConfig[] {
  const taken = new Set((user ?? []).map((s) => s.id))
  const merged = [...(user ?? [])]
  for (const s of project) {
    const id = `proj-${s.id}`
    if (taken.has(id)) continue
    taken.add(id)
    merged.push(inWorkspace({ ...s, id, origin: 'project' }, workspace))
  }
  return merged
}

/**
 * A project or run stdio server with its working directory pinned to the run's
 * workspace: the workspace itself when the config names none, and a relative `cwd`
 * resolved against it. Left alone, the server would inherit Houston's own working
 * directory (`/` for the desktop app opened from Finder), so `uv run server.py`
 * would not find its script and a filesystem server given `.` would serve the
 * whole disk. The resolved path is part of the connection key, so two folders'
 * copies of the same entry never share one process. Remote servers are unchanged.
 */
function inWorkspace(s: McpServerConfig, workspace: string): McpServerConfig {
  const stdio = s.transport ? s.transport === 'stdio' : !!s.command || !s.url
  return stdio ? { ...s, cwd: resolve(workspace, s.cwd ?? '.') } : s
}

/**
 * Add a run's own MCP servers (the headless `--mcp-config`) to the configured ones,
 * under a `run-` id prefix so they can never shadow or impersonate a configured
 * server (a configured server wins a prefixed-id collision). Like project servers
 * they carry their header/env values in the config itself (`origin: 'project'`)
 * rather than the secret store, live for the run only, and start stdio servers in
 * the run's workspace.
 */
export function mergeRunMcpServers(
  configured: McpServerConfig[] | undefined,
  run: McpServerConfig[] | undefined,
  workspace: string
): McpServerConfig[] | undefined {
  if (!run?.length) return configured
  const taken = new Set((configured ?? []).map((s) => s.id))
  const merged = [...(configured ?? [])]
  for (const s of run) {
    const id = `run-${s.id}`
    if (taken.has(id)) continue
    taken.add(id)
    merged.push(inWorkspace({ ...s, id, origin: 'project' }, workspace))
  }
  return merged
}

/**
 * Fingerprint of the parsed elevating subset, binding a trust decision to what
 * was actually shown/consented to. Computed over the NORMALIZED (parsed) config,
 * so cosmetic file changes (whitespace, key order of ignored fields) don't churn
 * it, while any change to an allow rule, hook, MCP server, command
 * `allowed-tools`, or plugin file does.
 * Empty string when the project elevates nothing (then there is nothing to
 * consent to).
 *
 * Plugins enter as `name` + content `sha256` (never the source text itself), and
 * only when there are any, so a folder without plugins keeps the fingerprint an
 * earlier version recorded and its trust survives the upgrade. A folder that does
 * have plugins gets a new fingerprint, so a trust recorded before plugins were
 * covered reads as changed and is asked again with the plugins listed.
 */
export function elevatedConfigHash(elevated: ProjectElevatedConfig): string {
  const commands = elevated.commands ?? []
  const plugins = elevated.plugins ?? []
  if (
    !elevated.allowRules.length &&
    !elevated.hooks.length &&
    !elevated.mcpServers.length &&
    !commands.length &&
    !plugins.length &&
    !elevated.statusLine
  ) {
    return ''
  }
  // Commands and plugins each join the hashed tuple only when there are any, so a
  // folder trusted before they were fingerprinted keeps its trust until one
  // appears. Commands keep the bare position they were first hashed at (existing
  // trust in a commands-only folder survives); plugins go in tagged, so the tuple
  // stays unambiguous whichever of the two is present.
  const parts: unknown[] = [elevated.allowRules, elevated.hooks, elevated.mcpServers]
  if (commands.length) parts.push(commands)
  if (plugins.length) parts.push({ plugins: plugins.map((p) => ({ name: p.name, sha256: p.sha256 })) })
  // Tagged and only when set, like plugins: existing trust survives until one appears.
  if (elevated.statusLine) parts.push({ statusLine: elevated.statusLine })
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** The project's commands that carry elevating frontmatter, sorted by name. */
export async function projectCommandGrants(workspace: string): Promise<ProjectCommandGrant[]> {
  let commands
  try {
    commands = await loadProjectCommands(workspace)
  } catch {
    return []
  }
  const grants: ProjectCommandGrant[] = []
  for (const c of commands) {
    const shell = c.template ? contextCommands(c.template) : []
    if (!c.allowedTools && !shell.length) continue
    grants.push({
      name: c.name,
      ...(c.allowedTools ? { allowedTools: c.allowedTools } : {}),
      ...(shell.length ? { shell } : {})
    })
  }
  return grants.sort((a, b) => a.name.localeCompare(b.name))
}

export interface ProjectConfig {
  /** Project-scoped guardrail rules (deny/ask only), checked before global rules. */
  permissionRules: PermissionRule[]
  /** The elevating subset — apply ONLY when the folder's trust state is 'trusted'. */
  elevated: ProjectElevatedConfig
  /** Fingerprint of `elevated` ('' when it is empty); pairs with FolderTrust.hash. */
  elevatedHash: string
}

/**
 * Read + validate the workspace's `.houston/settings.json` and its plugin files.
 * Never throws.
 */
export async function loadProjectConfig(workspace: string): Promise<ProjectConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(workspace, PROJECT_CONFIG), 'utf8'))
  } catch {
    raw = undefined // missing or malformed — no project config
  }
  const commands = await projectCommandGrants(workspace)
  const statusLine = parseStatusLineConfig((raw as { statusLine?: unknown } | undefined)?.statusLine)
  const elevated: ProjectElevatedConfig = {
    allowRules: parseProjectAllowRules(raw),
    hooks: parseProjectHooks(raw),
    mcpServers: parseProjectMcpServers(raw),
    ...(commands.length ? { commands } : {}),
    plugins: (await readPluginFiles(workspace)).files,
    ...(statusLine ? { statusLine } : {})
  }
  return {
    permissionRules: parseProjectRules(raw),
    elevated,
    elevatedHash: elevatedConfigHash(elevated)
  }
}

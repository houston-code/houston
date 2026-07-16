import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { HOOK_EVENTS, type Hook, type McpServerConfig, type PermissionRule } from '@shared/types'
import { sanitizeServerId } from '@shared/mcp'
import { parseTightenOnlyRules } from './permissions'

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
    const { action, tool, match } = r as Record<string, unknown>
    if (action !== 'allow') continue
    if (typeof tool !== 'string' || typeof match !== 'string') continue
    out.push({ action, tool, match })
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
    const { event, matcher, command } = h as Record<string, unknown>
    if (typeof event !== 'string' || !(HOOK_EVENTS as string[]).includes(event)) continue
    if (typeof command !== 'string' || !command.trim()) continue
    out.push({
      event: event as Hook['event'],
      matcher: typeof matcher === 'string' && matcher.trim() ? matcher.trim() : '*',
      command: command.trim()
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
      ...(Array.isArray(v.args) && v.args.every((a) => typeof a === 'string') ? { args: v.args as string[] } : {}),
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
 */
export function mergeProjectMcpServers(
  user: McpServerConfig[] | undefined,
  project: McpServerConfig[]
): McpServerConfig[] {
  const taken = new Set((user ?? []).map((s) => s.id))
  const merged = [...(user ?? [])]
  for (const s of project) {
    const id = `proj-${s.id}`
    if (taken.has(id)) continue
    taken.add(id)
    merged.push({ ...s, id, origin: 'project' })
  }
  return merged
}

/**
 * Fingerprint of the parsed elevating subset, binding a trust decision to what
 * was actually shown/consented to. Computed over the NORMALIZED (parsed) config,
 * so cosmetic file changes (whitespace, key order of ignored fields) don't churn
 * it, while any change to an allow rule, hook, or MCP server does. Empty string
 * when the project elevates nothing (then there is nothing to consent to).
 */
export function elevatedConfigHash(elevated: ProjectElevatedConfig): string {
  if (!elevated.allowRules.length && !elevated.hooks.length && !elevated.mcpServers.length) return ''
  return createHash('sha256')
    .update(JSON.stringify([elevated.allowRules, elevated.hooks, elevated.mcpServers]))
    .digest('hex')
}

export interface ProjectConfig {
  /** Project-scoped guardrail rules (deny/ask only), checked before global rules. */
  permissionRules: PermissionRule[]
  /** The elevating subset — apply ONLY when the folder's trust state is 'trusted'. */
  elevated: ProjectElevatedConfig
  /** Fingerprint of `elevated` ('' when it is empty); pairs with FolderTrust.hash. */
  elevatedHash: string
}

/** Read + validate the workspace's `.houston/settings.json`. Never throws. */
export async function loadProjectConfig(workspace: string): Promise<ProjectConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(join(workspace, PROJECT_CONFIG), 'utf8'))
  } catch {
    raw = undefined // missing or malformed — no project config
  }
  const elevated: ProjectElevatedConfig = {
    allowRules: parseProjectAllowRules(raw),
    hooks: parseProjectHooks(raw),
    mcpServers: parseProjectMcpServers(raw)
  }
  return {
    permissionRules: parseProjectRules(raw),
    elevated,
    elevatedHash: elevatedConfigHash(elevated)
  }
}

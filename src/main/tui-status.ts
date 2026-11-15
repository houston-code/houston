import { APPROVAL_POLICY_LABEL, type ApprovalPolicy, type FolderTrustState, type McpServerStatus } from '@shared/types'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * `/status`: one screen answering "what is this session running on". Pure: the
 * driver gathers the facts (the host supplies what only it knows: how Houston was
 * installed, the sandbox, this chat's network grants, the managed policy) and this
 * renders them as plain `label: value` lines, which read the same on a screen reader.
 */

/** What only the host knows, gathered when /status runs. */
export interface HostStatusFacts {
  installMethod: string
  sandbox: { backend: string; enforced: boolean }
  /** `allowlist` (granted network goes through the egress allowlist) or `all`. */
  egressMode: 'allowlist' | 'all'
  /** This chat's network grants, or null before the chat has run (nothing granted yet). */
  network: {
    shellGranted: boolean
    shellDecided: boolean
    /** Destinations a network tool was allowed for this chat. */
    hosts: number
    /** Hosts allowed for this chat's shell commands past the allowlist. */
    shellHosts: number
  } | null
  /** The admin policy file, when one is installed, and how many rules it holds. */
  managed: { path: string; rules: number } | null
}

export interface StatusView {
  version: string
  host: HostStatusFacts | null
  provider: { id: string; model: string; name: string } | null
  effort: string
  policy: ApprovalPolicy
  /** Configured (enabled) MCP servers, and their live connection states. */
  mcp: { configured: number; statuses: readonly Pick<McpServerStatus, 'state'>[] }
  settingsPath: string | null
  /** This folder's `.houston/settings.json`: absent, or present with its trust state. */
  project: { exists: boolean; elevates: boolean; trust: FolderTrustState } | null
  cost: string
  /** settings.usageLimitWait: whether a turn stopped at a usage limit waits for the reset. */
  usageLimitWait: boolean
}

/** What a chat's shell commands can reach right now, in a phrase. */
export function describeShellNetwork(
  network: HostStatusFacts['network'],
  policy: ApprovalPolicy,
  egressMode: 'allowlist' | 'all'
): string {
  const where = egressMode === 'all' ? 'any domain' : 'the egress allowlist'
  if (network?.shellGranted) return `on for this chat, to ${where}`
  if (network?.shellDecided) return 'off: declined for this chat'
  if (policy === 'full-auto' && egressMode === 'allowlist') return 'on in full auto, to the egress allowlist'
  return 'off until you allow it (asked when a command needs it)'
}

/** "2 connected, 1 failed, 1 needs sign-in", or "none configured". */
export function summarizeMcp(mcp: StatusView['mcp']): string {
  if (!mcp.configured && !mcp.statuses.length) return 'none configured'
  const connected = mcp.statuses.filter((s) => s.state === 'connected').length
  const failed = mcp.statuses.filter((s) => s.state === 'error').length
  const auth = mcp.statuses.filter((s) => s.state === 'needs-auth').length
  const idle = Math.max(0, mcp.configured - mcp.statuses.length)
  const parts = [`${connected} connected`, `${failed} failed`]
  if (auth) parts.push(`${auth} needs sign-in`)
  if (idle) parts.push(`${idle} not started yet`)
  return parts.join(', ')
}

function projectLine(p: StatusView['project']): string {
  if (!p || !p.exists) return 'none in this folder'
  if (!p.elevates) return 'present (guardrails only, no trust needed)'
  switch (p.trust) {
    case 'trusted':
      return 'present, trusted: its allow rules, hooks and MCP servers apply'
    case 'untrusted':
      return 'present, never trusted: its extra permissions are ignored'
    case 'changed':
      return 'present, changed since you trusted it: extra permissions are off (/trust)'
    case 'undecided':
      return 'present, not trusted yet: extra permissions are off (/trust)'
  }
}

export function renderStatus(v: StatusView, paint: Painter): string {
  const h = v.host
  const row = (label: string, value: string): string => `  ${`${label}:`.padEnd(18)}${stripControlChars(value)}`
  const model = v.provider
    ? `${v.provider.name === v.provider.model ? v.provider.model : `${v.provider.name} (${v.provider.model})`}, ${v.provider.id}`
    : 'none (run /login)'
  const lines = [
    paint('Status', 'bold'),
    row('version', `Houston ${v.version}`),
    row('installed with', h?.installMethod ?? 'unknown'),
    row('model', model),
    row('thinking effort', v.effort),
    row('approval', `${v.policy} (${APPROVAL_POLICY_LABEL[v.policy]})`),
    row(
      'sandbox',
      h ? (h.sandbox.enforced ? `${h.sandbox.backend}, enforced` : `${h.sandbox.backend}, not confining (commands run unconfined)`) : 'unknown'
    ),
    row('shell network', h ? describeShellNetwork(h.network, v.policy, h.egressMode) : 'unknown'),
    ...(h?.network && (h.network.hosts || h.network.shellHosts)
      ? [row('allowed hosts', `${h.network.hosts} for network tools, ${h.network.shellHosts} for shell commands, this chat`)]
      : []),
    row('usage limits', v.usageLimitWait ? 'wait for the reset, then continue (/config usage-limit-wait)' : 'stop the turn (/config usage-limit-wait)'),
    row('MCP servers', summarizeMcp(v.mcp)),
    row('user settings', v.settingsPath ?? 'unknown'),
    row('project settings', projectLine(v.project)),
    row('managed policy', h?.managed ? `${h.managed.path} (${h.managed.rules} rule${h.managed.rules === 1 ? '' : 's'})` : 'none'),
    row('session cost', v.cost),
    paint('  /doctor checks the setup in depth; /cost breaks the spend down by model', 'dim')
  ]
  return lines.join('\n')
}

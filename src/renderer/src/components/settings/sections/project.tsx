import type { PermissionPolicyView, PermissionRule } from '@shared/types'
import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

type TrustState = NonNullable<PermissionPolicyView['project']>['trust']

/** Whether a project's elevating config (allow rules, hooks, MCP servers) is in effect. */
export function TrustBadge({ trust }: { trust: TrustState }): JSX.Element | null {
  if (trust === 'none') return null
  const [tone, text] =
    trust === 'trusted'
      ? ['ok', 'In effect: you trust this folder']
      : trust === 'untrusted'
        ? ['warn', 'Ignored: you chose never to trust this folder']
        : trust === 'changed'
          ? ['warn', 'Ignored: changed since you trusted it']
          : ['warn', 'Ignored until you trust this folder']
  return <span className={`pill pill--${tone} trust-badge`}>{text}</span>
}

/** A permission rule shown, not edited: action, tool, and pattern. */
export function ReadOnlyRules({ rules, empty }: { rules: PermissionRule[]; empty: string }): JSX.Element {
  if (rules.length === 0) return <p className="settings-empty">{empty}</p>
  return (
    <ul className="ro-rules">
      {rules.map((r, i) => (
        <li key={i} className="ro-rule">
          <span className={`ro-rule__action ro-rule__action--${r.action}`}>{r.action}</span>
          <code className="ro-rule__tool">{r.tool || '*'}</code>
          <code className="ro-rule__match">{r.match}</code>
          {r.exact && <span className="settings-dim">exact</span>}
        </li>
      ))}
    </ul>
  )
}

/** This project's hooks, from its `.houston/settings.json`; read-only. */
export function ProjectHooksSection({ ctx }: { ctx: SettingsCtx }): JSX.Element | null {
  const project = ctx.policy?.project
  if (!project || project.hooks.length === 0) return null
  return (
    <SettingsSection
      title="This project's hooks"
      desc={
        <>
          From <code>.houston/settings.json</code> in the open project. They run after yours, and
          only while you trust the folder. Edit them in that file.
        </>
      }
    >
      <TrustBadge trust={project.trust} />
      <ul className="ro-rules">
        {project.hooks.map((h, i) => (
          <li key={i} className="ro-rule">
            <span className="ro-rule__action">{h.event}</span>
            <code className="ro-rule__tool">{h.matcher || '*'}</code>
            <code className="ro-rule__match">{h.command}</code>
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}

/** This project's MCP servers, from its `.houston/settings.json`; read-only. */
export function ProjectMcpSection({ ctx }: { ctx: SettingsCtx }): JSX.Element | null {
  const project = ctx.policy?.project
  if (!project || project.mcpServers.length === 0) return null
  return (
    <SettingsSection
      title="This project's MCP servers"
      desc={
        <>
          From <code>.houston/settings.json</code> in the open project, offered as{' '}
          <code>mcp__proj-&lt;id&gt;__&lt;tool&gt;</code> only while you trust the folder. Edit
          them in that file.
        </>
      }
    >
      <TrustBadge trust={project.trust} />
      <ul className="ro-rules">
        {project.mcpServers.map((sv) => (
          <li key={sv.id} className="ro-rule">
            <code className="ro-rule__tool">{sv.id}</code>
            <span className="ro-rule__action">{sv.transport}</span>
            <code className="ro-rule__match">{sv.target}</code>
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}

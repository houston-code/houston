import type { SandboxEgressSettings } from '@shared/egress'
import { removeFolderTrust } from '@shared/types'
import { DomainListField, SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** Extra directories the agent may read and write. */
export function AdditionalFoldersSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const additionalRoots = settings.additionalRoots ?? []
  const addRoot = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir && !additionalRoots.includes(dir)) {
      setSettings((s) => ({ ...s, additionalRoots: [...(s.additionalRoots ?? []), dir] }))
    }
  }
  const removeRoot = (dir: string): void =>
    setSettings((s) => ({
      ...s,
      additionalRoots: (s.additionalRoots ?? []).filter((d) => d !== dir)
    }))

  return (
    <SettingsSection
      title="Additional folders"
      desc={
        <>
          Extra directories the agent may read and write, beyond the project folder.
          They&apos;re added to the file tools&apos; allowed roots and the shell sandbox.
          Only add folders you trust the agent to modify.
        </>
      }
    >
      {additionalRoots.map((dir) => (
        <div className="rule" key={dir}>
          <code className="rule__path" title={dir}>
            {dir}
          </code>
          <button className="btn btn--sm btn--danger" onClick={() => removeRoot(dir)}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn--sm" onClick={() => void addRoot()}>
        + Add folder
      </button>
    </SettingsSection>
  )
}

/** Per-folder decisions on honoring a project's elevating config. */
export function TrustedFoldersSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection
      title="Trusted folders"
      desc={
        <>
          Projects whose <code>.houston/settings.json</code> asks for extra permissions
          (allow rules, hooks, MCP servers) and how you answered. Forget a decision to
          be asked again the next time that folder is open; a trusted project is also
          re-asked automatically whenever its configuration changes.
        </>
      }
    >
      {(settings.trustedFolders ?? []).length === 0 && (
        <p className="settings-empty">
          No decisions yet. You&apos;ll be asked when a project requests extra
          permissions.
        </p>
      )}
      {(settings.trustedFolders ?? []).map((t) => (
        <div className="rule" key={t.path}>
          <span
            className={`mcp-server__status ${t.decision === 'trusted' ? 'mcp-server__status--ok' : 'mcp-server__status--warn'}`}
          >
            {t.decision === 'trusted' ? 'trusted' : 'never'}
          </span>
          <code className="rule__path" title={t.path}>
            {t.path}
          </code>
          <span className="settings-dim">
            {new Date(t.decidedAt).toLocaleDateString()}
          </span>
          <button
            className="btn btn--sm btn--danger"
            title="Forget this decision (asks again on next open)"
            onClick={() =>
              setSettings((s) => ({
                ...s,
                trustedFolders: removeFolderTrust(s.trustedFolders, t.path)
              }))
            }
          >
            ✕
          </button>
        </div>
      ))}
    </SettingsSection>
  )
}

/** Where granted shell network may connect. */
export function SandboxEgressSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  // Sandbox egress: absent settings mean allowlist mode (the secure default).
  const egress = settings.sandboxEgress ?? {}
  const egressMode: 'allowlist' | 'all' = egress.mode === 'all' ? 'all' : 'allowlist'
  const patchEgress = (patch: Partial<SandboxEgressSettings>): void =>
    setSettings((s) => ({ ...s, sandboxEgress: { ...(s.sandboxEgress ?? {}), ...patch } }))

  return (
    <SettingsSection
      title="Sandbox egress"
      desc={
        <>
          Where shell commands may connect once network is granted. The allowlist
          restricts granted network to common development infrastructure (package
          registries, VCS hosts) plus the domains you add; each entry also covers its
          subdomains, and the deny list wins over every allow. &quot;All domains&quot;
          removes the restriction: any granted command can then reach any host.
        </>
      }
    >
      <label className="field">
        <span>Mode</span>
        <select
          value={egressMode}
          onChange={(e) =>
            patchEgress({ mode: e.target.value as SandboxEgressSettings['mode'] })
          }
        >
          <option value="allowlist">Allowlist (recommended)</option>
          <option value="all">All domains</option>
        </select>
      </label>
      {egressMode === 'allowlist' && (
        <>
          <DomainListField
            label="Additional allowed domains"
            domains={egress.allow ?? []}
            placeholder={'one domain per line, e.g. artifactory.corp.example'}
            onChange={(allow) => patchEgress({ allow })}
          />
          <DomainListField
            label="Denied domains"
            domains={egress.deny ?? []}
            placeholder={'one domain per line; overrides the allowlist'}
            onChange={(deny) => patchEgress({ deny })}
          />
        </>
      )}
    </SettingsSection>
  )
}

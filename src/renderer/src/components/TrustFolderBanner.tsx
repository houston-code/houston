import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, FolderTrustStatus } from '@shared/types'
import { Icon } from './Icon'

/**
 * A non-blocking inline banner asking whether to trust a folder whose project
 * config (`.houston/settings.json`, `.houston/commands`, `.houston/plugins/*.js`)
 * ELEVATES: defines `allow` permission rules, hooks, MCP servers, commands that
 * pre-approve tools, or plugin files. Those auto-approve actions or run processes
 * as the user, so an undecided (or drifted) folder runs with them OFF; this banner is
 * the consent that turns them on. Mirrors GitInitBanner's shape: never gates the
 * run, never steals focus.
 *
 * States it renders for: 'undecided' (first time) and 'changed' (the project's
 * elevating config no longer matches what was trusted — e.g. a pull added a
 * hook — so trust dropped and the user must re-consent). 'trusted', 'untrusted'
 * (a persisted Never), and 'none' render nothing.
 */
export function TrustFolderBanner({
  workspace,
  running,
  sessionDismissed,
  onNotNow,
  onDecided
}: {
  /** The active chat's workspace, or null when there is none. */
  workspace: string | null
  /** Whether a run is in progress — re-check when it finishes (a run may pull config). */
  running: boolean
  /** Whether the user chose "Not now" for this workspace this session (held by the caller). */
  sessionDismissed: boolean
  /** Called when the user picks "Not now" (session-only dismissal). */
  onNotNow: () => void
  /** Called with the fresh settings after a persisted decision, to keep copies in sync. */
  onDecided?: (settings: AppSettings) => void
}): JSX.Element | null {
  const [status, setStatus] = useState<FolderTrustStatus | null>(null)
  const [deciding, setDeciding] = useState(false)
  const wsRef = useRef(workspace)
  wsRef.current = workspace

  const refresh = useCallback(async (): Promise<void> => {
    const ws = wsRef.current
    if (!ws) {
      setStatus(null)
      return
    }
    try {
      const s = await window.api.getFolderTrustStatus(ws)
      if (wsRef.current !== ws) return // workspace switched mid-flight
      setStatus(s)
    } catch {
      // Non-fatal — leave the banner hidden rather than prompt on bad data.
    }
  }, [])

  useEffect(() => {
    if (workspace && !sessionDismissed) void refresh()
    else setStatus(null)
  }, [workspace, sessionDismissed, refresh])

  // Re-check when a run finishes: the run itself may have changed the project file.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running && workspace && !sessionDismissed) void refresh()
    wasRunning.current = running
  }, [running, workspace, sessionDismissed, refresh])

  const decide = useCallback(
    (decision: 'trusted' | 'never'): void => {
      const ws = wsRef.current
      if (!ws) return
      setDeciding(true)
      void window.api
        .decideFolderTrust(ws, decision)
        .then((next) => {
          onDecided?.(next)
          return refresh()
        })
        .finally(() => setDeciding(false))
    },
    [onDecided, refresh]
  )

  if (!workspace || sessionDismissed || !status || !status.counts) return null
  if (status.state !== 'undecided' && status.state !== 'changed') return null

  const c = status.counts
  const parts = [
    c.allowRules ? `${c.allowRules} allow rule${c.allowRules === 1 ? '' : 's'}` : '',
    c.hooks ? `${c.hooks} hook${c.hooks === 1 ? '' : 's'}` : '',
    c.mcpServers ? `${c.mcpServers} MCP server${c.mcpServers === 1 ? '' : 's'}` : '',
    c.commands
      ? `${c.commands} command${c.commands === 1 ? '' : 's'} that pre-approve${c.commands === 1 ? 's' : ''} tools or run${c.commands === 1 ? 's' : ''} shell commands`
      : '',
    // Name every plugin file: trusting the folder consents to running exactly these.
    c.plugins
      ? `${c.plugins} plugin${c.plugins === 1 ? '' : 's'}${status.plugins?.length ? ` (${status.plugins.join(', ')})` : ''}`
      : ''
  ].filter(Boolean)
  const summary = parts.join(', ')
  // Where the elevating config lives: the settings file, the commands folder, the
  // plugins folder, or any mix of them.
  const settingsPart = c.allowRules > 0 || c.hooks > 0 || c.mcpServers > 0
  const sources = [
    settingsPart || (!c.commands && !c.plugins) ? '.houston/settings.json' : '',
    c.commands ? '.houston/commands' : '',
    c.plugins ? '.houston/plugins' : ''
  ].filter(Boolean)
  const source =
    sources.length < 3 ? sources.join(' and ') : `${sources.slice(0, -1).join(', ')}, and ${sources[sources.length - 1]}`
  const pluginNote = c.plugins
    ? ' Plugins also need the projectPlugins setting turned on, and any plugin added or edited later asks again.'
    : ''

  return (
    <section className="git-init-banner trust-banner" role="region" aria-labelledby="trust-banner-title">
      <span className="git-init-banner__icon" aria-hidden="true">
        <Icon name="shield" size={16} />
      </span>
      <div className="git-init-banner__body">
        <p className="git-init-banner__title" id="trust-banner-title">
          {status.state === 'changed'
            ? 'This project’s trusted configuration changed'
            : 'This project asks for extra permissions'}
        </p>
        <p className="git-init-banner__text">
          {status.state === 'changed'
            ? `The extra permissions in this project’s ${source} changed since you trusted it (now: ${summary}). They stay off until you trust it again.${pluginNote}`
            : c.commands || c.plugins
              ? `It defines ${summary} (in ${source}). Hooks, MCP servers, plugins, and command templates’ shell commands run as you, and allow rules and pre-approving commands auto-approve matching actions, so only trust folders whose authors you trust. Until you decide, Houston ignores them.${pluginNote}`
              : `Its .houston/settings.json defines ${summary}. Hooks and MCP servers run as you, and allow rules auto-approve matching actions, so only trust folders whose authors you trust. Until you decide, Houston ignores them.`}
        </p>
        <div className="git-init-banner__actions">
          <button
            type="button"
            className="btn btn--sm btn--accent"
            onClick={() => decide('trusted')}
            disabled={deciding}
          >
            Trust this folder
          </button>
          <button type="button" className="btn btn--sm" onClick={onNotNow} disabled={deciding}>
            Not now
          </button>
          <button type="button" className="btn btn--sm" onClick={() => decide('never')} disabled={deciding}>
            Never for this folder
          </button>
        </div>
      </div>
    </section>
  )
}

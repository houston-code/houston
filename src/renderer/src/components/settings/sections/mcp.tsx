import { useEffect, useRef, useState } from 'react'
import type { AppSettings, McpServerConfig, McpServerStatus } from '@shared/types'
import { sanitizeServerId } from '@shared/mcp'
import { serverIdProblem } from '@shared/mcpCatalog'
import { HeadersField, SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'
import { McpAddPanels } from './mcpCatalog'

/**
 * A server's id. Typed freely and tidied to the namespacing-safe charset when the
 * field loses focus: tidying every keystroke would eat the `-` of `my-server` (a
 * trailing `-` is trimmed) before the next letter arrived.
 */
function ServerIdField({ id, onChange }: { id: string; onChange: (id: string) => void }): JSX.Element {
  const [text, setText] = useState(id)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(id)
  }, [id])
  return (
    <input
      className="rule__tool"
      placeholder="id"
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false
        const clean = sanitizeServerId(text)
        setText(clean)
        if (clean !== id) onChange(clean)
      }}
    />
  )
}

/**
 * A stdio server's arguments, one per line as in the catalog's review form, so an
 * argument may hold spaces (a folder path). Parsed when the field loses focus.
 */
function ArgsField({ args, onChange }: { args: string[]; onChange: (args: string[]) => void }): JSX.Element {
  const [text, setText] = useState(() => args.join('\n'))
  const focused = useRef(false)
  const joined = args.join('\n')
  useEffect(() => {
    if (!focused.current) setText(joined)
  }, [joined])
  return (
    <textarea
      className="mcp-server__args"
      rows={Math.max(3, text.split('\n').length)}
      placeholder={'args, one per line, e.g.\n-y\n@modelcontextprotocol/server-filesystem'}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false
        const parsed = text
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean)
        setText(parsed.join('\n'))
        onChange(parsed)
      }}
    />
  )
}

/** Model Context Protocol servers: stdio processes or remote HTTP/SSE endpoints. */
export function McpServersSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings, busy, setBusy, setFormError } = ctx
  const servers = settings.mcpServers ?? []
  const setServers = (next: McpServerConfig[]): void =>
    setSettings((s) => ({ ...s, mcpServers: next }))
  const addServer = (): void =>
    setServers([...servers, { id: '', command: '', args: [], enabled: true }])
  const patchServer = (i: number, patch: Partial<McpServerConfig>): void =>
    setServers(servers.map((sv, idx) => (idx === i ? { ...sv, ...patch } : sv)))
  const removeServer = (i: number): void => setServers(servers.filter((_, idx) => idx !== i))
  // Servers already saved: their env values, headers, and OAuth tokens are stored
  // under the id (this page only ever sees them masked), so the id can't change. A
  // server added here keeps its id editable until it signs in with OAuth or the page
  // is opened again.
  const [savedIds, setSavedIds] = useState(() => new Set(servers.map((sv) => sv.id).filter(Boolean)))
  const [renameHint, setRenameHint] = useState<number | null>(null)

  // Live per-server connection badges (connected / needs sign-in / error), read
  // once per modal open — the manager updates them on each run's reconcile.
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  useEffect(() => {
    let alive = true
    void window.api
      .getMcpStatuses()
      .then((s) => {
        if (alive) setMcpStatuses(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Merge the fresh derived hasOAuth flags into the working copy, preserving
  // every pending edit (same contract as applyKeyResult for provider keys).
  const applyOAuthFlags = (fresh: AppSettings): void =>
    setSettings((s) => ({
      ...s,
      mcpServers: s.mcpServers?.map((sv) => ({
        ...sv,
        hasOAuth: fresh.mcpServers?.find((x) => x.id === sv.id)?.hasOAuth ?? false
      }))
    }))


  // OAuth sign-in for a remote server. The flow reads the *persisted* server URL
  // by id, so the working edits are saved first (same pattern as fetchModels).
  const mcpSignIn = async (id: string): Promise<void> => {
    if (!id) return
    setBusy(`mcp-oauth:${id}`)
    setFormError(null)
    try {
      await ctx.persistNow()
      // The tokens are stored under this id from here on.
      setSavedIds((ids) => new Set(ids).add(id))
      const res = await window.api.mcpOAuthLogin(id)
      if (!res.ok) setFormError(`MCP sign-in failed: ${res.error ?? 'unknown error'}`)
      applyOAuthFlags(res.settings)
    } catch (e) {
      setFormError(`MCP sign-in failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const mcpSignOut = async (id: string): Promise<void> => {
    setBusy(`mcp-oauth:${id}`)
    setFormError(null)
    try {
      applyOAuthFlags(await window.api.mcpOAuthLogout(id))
    } catch (e) {
      setFormError(`Could not sign out: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsSection
      title="MCP servers"
      desc={
        <>
          Connect Model Context Protocol servers: a local <strong>stdio</strong> process
          or a remote <strong>HTTP</strong> or <strong>SSE</strong> endpoint. Remote
          servers authenticate with a bearer-token header or with <strong>OAuth</strong>{' '}
          (Sign in opens your browser; tokens are stored encrypted and refreshed
          automatically). Their tools are offered to the agent as{' '}
          <code>mcp__&lt;id&gt;__&lt;tool&gt;</code> and always require approval. stdio
          commands run as you (not sandboxed), so only add servers you trust.
        </>
      }
    >
      {servers.map((sv, i) => {
        const transport = sv.transport ?? (sv.url && !sv.command ? 'http' : 'stdio')
        const status = mcpStatuses.find((x) => x.id === sv.id)
        const locked = savedIds.has(sv.id)
        const idProblem = serverIdProblem(
          sv.id,
          servers.filter((_, idx) => idx !== i).map((other) => other.id)
        )
        return (
          <div className="mcp-server" key={i}>
            <div className="mcp-server__row">
              {locked ? (
                <input
                  className="rule__tool"
                  value={sv.id}
                  readOnly
                  aria-label={`Server id ${sv.id}`}
                  title="To rename a server, remove it and add it again"
                  onFocus={() => setRenameHint(i)}
                  onBlur={() => setRenameHint(null)}
                />
              ) : (
                <ServerIdField id={sv.id} onChange={(id) => patchServer(i, { id })} />
              )}
              <select
                value={transport}
                onChange={(e) =>
                  patchServer(i, {
                    transport: e.target.value as McpServerConfig['transport']
                  })
                }
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
              <label className="mcp-server__enabled" title="Enabled">
                <input
                  type="checkbox"
                  checked={sv.enabled}
                  onChange={(e) => patchServer(i, { enabled: e.target.checked })}
                />
              </label>
              <button
                className="btn btn--sm btn--danger"
                onClick={() => removeServer(i)}
              >
                ✕
              </button>
            </div>
            {renameHint === i && locked && (
              <p className="field__hint">To rename a server, remove it and add it again.</p>
            )}
            {idProblem && <p className="field__hint field__hint--warn">{idProblem}</p>}
            {transport === 'http' || transport === 'sse' ? (
              <>
                <input
                  className="mcp-server__args"
                  placeholder="url (e.g. https://example.com/mcp)"
                  value={sv.url ?? ''}
                  onChange={(e) => patchServer(i, { url: e.target.value })}
                />
                <HeadersField
                  className="mcp-server__args"
                  placeholder="headers, one per line (e.g. Authorization: Bearer TOKEN); or use OAuth sign-in below"
                  headers={sv.headers}
                  onChange={(headers) => patchServer(i, { headers })}
                />
                <div className="mcp-server__row">
                  {sv.hasOAuth ? (
                    <>
                      <span className="mcp-server__status mcp-server__status--ok">
                        Signed in with OAuth
                      </span>
                      <button
                        className="btn btn--sm"
                        disabled={busy !== null}
                        onClick={() => void mcpSignOut(sv.id)}
                      >
                        Sign out
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn--sm"
                      disabled={busy !== null || !sv.id || !sv.url}
                      title="For servers that require OAuth: opens your browser to authorize Houston, then stores the tokens encrypted"
                      onClick={() => void mcpSignIn(sv.id)}
                    >
                      {busy === `mcp-oauth:${sv.id}` ? 'Waiting for browser…' : 'Sign in (OAuth)'}
                    </button>
                  )}
                  {status && (
                    <span
                      className={`mcp-server__status${status.state === 'connected' ? ' mcp-server__status--ok' : status.state === 'needs-auth' ? ' mcp-server__status--warn' : ' mcp-server__status--err'}`}
                    >
                      {status.state === 'connected'
                        ? `Connected (${status.tools ?? 0} tool${status.tools === 1 ? '' : 's'})`
                        : status.state === 'needs-auth'
                          ? 'Needs sign-in'
                          : `Connection failed: ${status.error ?? 'unknown error'}`}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <input
                  className="mcp-server__args"
                  placeholder="command (e.g. npx)"
                  value={sv.command}
                  onChange={(e) => patchServer(i, { command: e.target.value })}
                />
                <ArgsField args={sv.args ?? []} onChange={(args) => patchServer(i, { args })} />
                <input
                  className="mcp-server__args"
                  placeholder="working directory (optional)"
                  value={sv.cwd ?? ''}
                  onChange={(e) => patchServer(i, { cwd: e.target.value || undefined })}
                />
                <HeadersField
                  env
                  className="mcp-server__args"
                  placeholder="env vars, one per line (e.g. GITHUB_TOKEN=ghp_xxx); values are stored encrypted"
                  headers={sv.env}
                  onChange={(env) => patchServer(i, { env })}
                />
                {status && (
                  <span
                    className={`mcp-server__status${status.state === 'connected' ? ' mcp-server__status--ok' : ' mcp-server__status--err'}`}
                  >
                    {status.state === 'connected'
                      ? `Connected (${status.tools ?? 0} tool${status.tools === 1 ? '' : 's'})`
                      : `Connection failed: ${status.error ?? 'unknown error'}`}
                  </span>
                )}
              </>
            )}
          </div>
        )
      })}
      <button className="btn btn--sm" onClick={addServer}>
        + Add MCP server
      </button>
      <McpAddPanels
        servers={servers}
        workspace={ctx.workspace}
        onAdd={(added) => setSettings((s) => ({ ...s, mcpServers: [...(s.mcpServers ?? []), ...added] }))}
      />
    </SettingsSection>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { ImportCandidate, ImportKind } from '@shared/importConfig'
import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

const KIND_HEADINGS: Array<[ImportKind, string]> = [
  ['rules', 'Instructions'],
  ['mcp', 'MCP servers'],
  ['skill', 'Skills'],
  ['command', 'Custom commands']
]

/** "Imported 3." plus anything that needs the user's attention next. */
export function importSummary(imported: ImportCandidate[], failed: number): string {
  const parts: string[] = []
  if (imported.length) parts.push(`Imported ${imported.length}.`)
  if (imported.some((c) => c.kind === 'mcp' && c.scope === 'user')) {
    parts.push('New MCP servers are switched off: review them under MCP Servers, then switch them on.')
  }
  if (imported.some((c) => c.kind === 'mcp' && c.scope === 'project')) {
    parts.push("This project's servers take effect once you trust the folder.")
  }
  if (failed) parts.push(`${failed} could not be imported.`)
  return parts.join(' ')
}

/**
 * Import from other tools: what other coding tools keep in the home folder and the
 * open project (instruction files, MCP servers, skills, custom commands), with a
 * checkbox each. Nothing is selected until the user picks it; importing copies, and
 * never overwrites what Houston already has.
 */
export function ImportSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { workspace, setSettings, persistNow } = ctx
  const [found, setFound] = useState<ImportCandidate[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [failures, setFailures] = useState<Array<{ name: string; reason: string }>>([])
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const res = await window.api.scanImports(workspace)
      setFound(res.candidates)
      setPicked((p) => new Set([...p].filter((id) => res.candidates.some((c) => c.id === id && c.status === 'new'))))
    } catch (e) {
      setFound([])
      setError(`Couldn't look for files: ${(e as Error).message}`)
    }
  }, [workspace])

  useEffect(() => {
    void scan()
  }, [scan])

  const fresh = (found ?? []).filter((c) => c.status === 'new')
  const toggle = (id: string, on: boolean): void =>
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const run = async (): Promise<void> => {
    if (picked.size === 0 || !found) return
    setBusy(true)
    setStatus(null)
    setError(null)
    setFailures([])
    try {
      // Imported user servers are saved to settings by main, so pending edits here
      // must reach disk first or the import would be lost under them (and vice versa).
      await persistNow()
      const ids = [...picked]
      const res = await window.api.applyImports(workspace, ids)
      const fresh = res.settings
      if (fresh) setSettings((s) => ({ ...s, mcpServers: fresh.mcpServers }))
      const byId = new Map(found.map((c) => [c.id, c]))
      const done = res.imported.map((id) => byId.get(id)).filter((c): c is ImportCandidate => !!c)
      setFailures(res.failed.map((f) => ({ name: byId.get(f.id)?.name ?? f.id, reason: f.reason })))
      setStatus(importSummary(done, res.failed.length))
      setPicked(new Set())
      await scan()
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title="Import from other tools"
      desc={
        <>
          Copies instruction files, MCP servers, skills and custom commands that other coding tools
          keep in your home folder{workspace ? ' or this project' : ''} into Houston&apos;s own
          locations. The originals are never moved or changed, and nothing Houston already has is
          overwritten. Imported MCP servers start switched off.
        </>
      }
    >
      {found === null ? (
        <p className="settings-empty" role="status">
          Looking…
        </p>
      ) : found.length === 0 ? (
        <p className="settings-empty">
          Nothing to import was found in your home folder{workspace ? ' or this project' : ''}.
        </p>
      ) : (
        <>
          {KIND_HEADINGS.map(([kind, heading]) => {
            const items = found.filter((c) => c.kind === kind)
            if (items.length === 0) return null
            return (
              <fieldset key={kind} className="import-group">
                <legend className="import-group__title">{heading}</legend>
                <ul className="import-list">
                  {items.map((c) => (
                    <li key={c.id} className={`import-item${c.status === 'present' ? ' import-item--present' : ''}`}>
                      <label className="import-item__label">
                        <input
                          type="checkbox"
                          checked={picked.has(c.id)}
                          disabled={c.status !== 'new' || busy}
                          onChange={(e) => toggle(c.id, e.target.checked)}
                        />
                        <span className="import-item__name">{c.name}</span>
                        <span className="pill">{c.scope === 'user' ? 'Your home folder' : 'This project'}</span>
                      </label>
                      <span className="import-item__path">
                        <code>{c.source}</code> to <code>{c.target}</code>
                      </span>
                      {c.detail && <span className="import-item__detail">{c.detail}</span>}
                      {c.note && <span className="import-item__note">{c.note}</span>}
                    </li>
                  ))}
                </ul>
              </fieldset>
            )
          })}
          <div className="import-actions">
            <button
              type="button"
              className="btn btn--sm btn--accent"
              disabled={busy || picked.size === 0}
              onClick={() => void run()}
            >
              {busy ? 'Importing…' : `Import selected${picked.size ? ` (${picked.size})` : ''}`}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || fresh.length === 0 || fresh.every((c) => picked.has(c.id))}
              onClick={() => setPicked(new Set(fresh.map((c) => c.id)))}
            >
              Select all new
            </button>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void scan()}>
              Look again
            </button>
          </div>
        </>
      )}
      {status && (
        <p className="field__hint" role="status">
          {status}
        </p>
      )}
      {failures.length > 0 && (
        <ul className="import-failures">
          {failures.map((f, i) => (
            <li key={i}>
              {f.name}: {f.reason}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}

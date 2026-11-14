import { useRef, useState } from 'react'
import type { McpServerConfig } from '@shared/types'
import { MCP_CATALOG, addPastedServers, catalogDraft } from '@shared/mcpCatalog'
import { parseMcpServersJson } from '@shared/mcpJson'
import { useEscapeWithin } from '../../../lib/useFocusTrap'
import type { RegistrySearchResult } from '@shared/mcpRegistry'
import { ReviewForm, addedMessage } from './mcpReview'
import { RegistryPanel } from './mcpRegistry'

/** The built-in catalog ("Recommended"): each entry with a Review button that opens the form above. */
function CatalogPanel({
  workspace,
  taken,
  onAdd
}: {
  workspace: string | null
  taken: string[]
  onAdd: (servers: McpServerConfig[], message: string) => void
}): JSX.Element {
  const [reviewing, setReviewing] = useState<string | null>(null)
  return (
    <ul className="mcp-catalog" aria-label="MCP server catalog">
      {MCP_CATALOG.map((entry) => (
        <li key={entry.id} className="mcp-catalog__item">
          <div className="mcp-catalog__head">
            <span className="mcp-catalog__name">{entry.name}</span>
            <span className="pill">{entry.publisher}</span>
            {reviewing !== entry.id && (
              <button
                type="button"
                className="btn btn--sm mcp-catalog__review"
                aria-label={`Review ${entry.name}`}
                onClick={() => setReviewing(entry.id)}
              >
                Review
              </button>
            )}
          </div>
          <span className="mcp-catalog__desc">{entry.description}</span>
          <code className="mcp-catalog__cmd">
            {entry.transport === 'http' ? entry.url : [entry.command, ...entry.args].join(' ')}
          </code>
          {reviewing === entry.id && (
            <ReviewForm
              draft={catalogDraft(entry, workspace)}
              taken={taken}
              onCancel={() => setReviewing(null)}
              onAdd={(server) => {
                setReviewing(null)
                onAdd([server], addedMessage(server))
              }}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

/** Paste a standard `mcpServers` JSON object; review what was read, then add it switched off. */
function PastePanel({
  current,
  onAdd
}: {
  current: McpServerConfig[]
  onAdd: (servers: McpServerConfig[], message: string) => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [read, setRead] = useState<{ servers: McpServerConfig[]; problems: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parse = (): void => {
    const res = parseMcpServersJson(text)
    if ('error' in res) {
      setError(res.error)
      setRead(null)
    } else {
      setError(null)
      setRead(res)
    }
  }
  const taken = current.map((s) => s.id)
  return (
    <div className="mcp-paste">
      <label className="mcp-review__field">
        <span>
          Paste an object with an <code>mcpServers</code> map, as server instructions usually give it
        </span>
        <textarea
          rows={6}
          value={text}
          placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "package"] }\n  }\n}'}
          onChange={(e) => {
            setText(e.target.value)
            setRead(null)
          }}
        />
      </label>
      <div className="mcp-review__actions">
        <button type="button" className="btn btn--sm" disabled={!text.trim()} onClick={parse}>
          Read it
        </button>
      </div>
      {error && (
        <p className="mcp-review__error" role="alert">
          {error}
        </p>
      )}
      {read && (
        <>
          <ul className="mcp-catalog" aria-label="Servers read from the JSON">
            {read.servers.map((s) => (
              <li key={s.id} className="mcp-catalog__item">
                <div className="mcp-catalog__head">
                  <span className="mcp-catalog__name">{s.id}</span>
                  {taken.includes(s.id) && <span className="settings-dim">already configured, will be skipped</span>}
                </div>
                <code className="mcp-catalog__cmd">
                  {s.command ? [s.command, ...(s.args ?? [])].join(' ') : `${s.transport} ${s.url ?? ''}`}
                </code>
                {s.env && <span className="mcp-catalog__desc">Variables: {Object.keys(s.env).join(', ')}</span>}
                {s.headers && <span className="mcp-catalog__desc">Headers: {Object.keys(s.headers).join(', ')}</span>}
              </li>
            ))}
          </ul>
          {read.problems.length > 0 && (
            <ul className="mcp-paste__problems">
              {read.problems.map((p) => (
                <li key={p}>Not read: {p}</li>
              ))}
            </ul>
          )}
          <div className="mcp-review__actions">
            <button
              type="button"
              className="btn btn--sm btn--accent"
              disabled={read.servers.every((s) => taken.includes(s.id))}
              onClick={() => {
                const { servers, added, skipped } = addPastedServers(current, read.servers)
                setText('')
                setRead(null)
                onAdd(
                  servers.slice(current.length),
                  `Added ${added.join(', ')}, switched off. Tick a box in the list to switch one on.${skipped.length ? ` Skipped ${skipped.join(', ')} (already configured).` : ''}`
                )
              }}
            >
              Add {read.servers.filter((s) => !taken.includes(s.id)).length} switched off
            </button>
          </div>
        </>
      )}
    </div>
  )
}

type AddPanel = 'catalog' | 'registry' | 'paste'

/**
 * "Recommended", "Browse registry" and "Paste JSON" under the MCP server list. All
 * three only append to the working list (which then saves like any edit); nothing is
 * connected or run from here, and a server added switched off stays inert until its
 * box is ticked.
 */
export function McpAddPanels({
  servers,
  workspace,
  onAdd,
  searchRegistry
}: {
  servers: McpServerConfig[]
  workspace: string | null
  onAdd: (added: McpServerConfig[]) => void
  /** Registry search; defaults to the main-process client over IPC. */
  searchRegistry?: (query: string, cursor?: string) => Promise<RegistrySearchResult>
}): JSX.Element {
  const [open, setOpen] = useState<AddPanel | null>(null)
  // Escape closes an open panel (and any pasted text in it) before it closes Settings.
  const rootRef = useRef<HTMLDivElement>(null)
  useEscapeWithin(rootRef, () => {
    if (open === null) return false
    setOpen(null)
  })
  const [message, setMessage] = useState<string | null>(null)
  const add = (added: McpServerConfig[], msg: string): void => {
    onAdd(added)
    setMessage(msg)
    setOpen(null)
  }
  const toggle = (which: AddPanel): void => {
    setMessage(null)
    setOpen((o) => (o === which ? null : which))
  }
  return (
    <div className="mcp-add" ref={rootRef}>
      <div className="mcp-review__actions">
        <button type="button" className="btn btn--sm" aria-expanded={open === 'catalog'} onClick={() => toggle('catalog')}>
          Recommended
        </button>
        <button type="button" className="btn btn--sm" aria-expanded={open === 'registry'} onClick={() => toggle('registry')}>
          Browse registry
        </button>
        <button type="button" className="btn btn--sm" aria-expanded={open === 'paste'} onClick={() => toggle('paste')}>
          Paste JSON
        </button>
      </div>
      {open === 'catalog' && <CatalogPanel workspace={workspace} taken={servers.map((s) => s.id)} onAdd={add} />}
      {open === 'registry' && (
        <RegistryPanel
          taken={servers.map((s) => s.id)}
          onAdd={add}
          search={searchRegistry ?? ((q, c) => window.api.searchMcpRegistry(q, c))}
        />
      )}
      {open === 'paste' && <PastePanel current={servers} onAdd={add} />}
      {message && (
        <p className="field__hint" role="status">
          {message}
        </p>
      )}
    </div>
  )
}

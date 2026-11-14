import { useEffect, useRef, useState } from 'react'
import type { McpServerConfig } from '@shared/types'
import { sanitizeServerId } from '@shared/mcp'
import { MCP_CATALOG, addPastedServers, catalogServer, freeServerId, serverProblem, type McpCatalogEntry } from '@shared/mcpCatalog'
import { parseMcpServersJson } from '@shared/mcpJson'
import { HeadersField } from '../fields'
import { useEscapeWithin } from '../../../lib/useFocusTrap'

/** Review a catalog entry before adding it: every field editable, nothing saved until Add. */
function ReviewForm({
  entry,
  workspace,
  taken,
  onAdd,
  onCancel
}: {
  entry: McpCatalogEntry
  workspace: string | null
  taken: string[]
  onAdd: (server: McpServerConfig) => void
  onCancel: () => void
}): JSX.Element {
  const [server, setServer] = useState<McpServerConfig>(() => {
    const s = catalogServer(entry, workspace)
    return { ...s, id: freeServerId(s.id, taken) }
  })
  // One argument per line, so a folder path with spaces stays one argument.
  const [argsText, setArgsText] = useState((server.args ?? []).join('\n'))
  const [switchOn, setSwitchOn] = useState(false)
  const [tried, setTried] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  // Escape cancels the review rather than closing Settings.
  const formRef = useRef<HTMLFormElement>(null)
  useEscapeWithin(formRef, onCancel)
  useEffect(() => firstRef.current?.focus(), [])

  const remote = server.transport === 'http' || server.transport === 'sse'
  // The id is tidied when its field loses focus (tidying every keystroke would eat the
  // `-` of `my-server`); Add reads the tidied form either way.
  const candidate: McpServerConfig = {
    ...server,
    id: sanitizeServerId(server.id),
    args: remote ? [] : argsText.split('\n').map((a) => a.trim()).filter(Boolean)
  }
  const problem = serverProblem(candidate, taken)
  const patch = (p: Partial<McpServerConfig>): void => setServer((s) => ({ ...s, ...p }))

  return (
    <form
      ref={formRef}
      className="mcp-review"
      aria-label={`Review ${entry.name}`}
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (!problem) onAdd({ ...candidate, enabled: switchOn })
      }}
    >
      <p className="mcp-review__title">
        {entry.name} <span className="settings-dim">from {entry.publisher}</span>
      </p>
      {entry.note && <p className="field__hint">{entry.note}</p>}
      {entry.needs && <p className="field__hint">Needs {entry.needs} installed.</p>}
      <label className="mcp-review__field">
        <span>Id</span>
        <input
          ref={firstRef}
          value={server.id}
          onChange={(e) => patch({ id: e.target.value })}
          onBlur={() => patch({ id: sanitizeServerId(server.id) })}
        />
      </label>
      {remote ? (
        <>
          <label className="mcp-review__field">
            <span>URL</span>
            <input value={server.url ?? ''} onChange={(e) => patch({ url: e.target.value })} />
          </label>
          <label className="mcp-review__field">
            <span>Headers, one per line (values are stored encrypted)</span>
            <HeadersField headers={server.headers} onChange={(headers) => patch({ headers })} />
          </label>
          {entry.headers && (
            <p className="field__hint">
              {Object.entries(entry.headers).map(([k, v]) => (
                <span key={k}>
                  <code>{k}</code>: {v}.{' '}
                </span>
              ))}
            </p>
          )}
        </>
      ) : (
        <>
          <label className="mcp-review__field">
            <span>Command</span>
            <input value={server.command} onChange={(e) => patch({ command: e.target.value })} />
          </label>
          <label className="mcp-review__field">
            <span>Arguments, one per line</span>
            <textarea rows={Math.max(2, argsText.split('\n').length)} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
          </label>
        </>
      )}
      <label className="mcp-review__check">
        <input type="checkbox" checked={switchOn} onChange={(e) => setSwitchOn(e.target.checked)} />
        Switch it on now (it starts the next time the agent runs)
      </label>
      {tried && problem && (
        <p className="mcp-review__error" role="alert">
          {problem}
        </p>
      )}
      <div className="mcp-review__actions">
        <button type="submit" className="btn btn--sm btn--accent">
          Add server
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The catalog: each entry with a Review button that opens the form above. */
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
              entry={entry}
              workspace={workspace}
              taken={taken}
              onCancel={() => setReviewing(null)}
              onAdd={(server) => {
                setReviewing(null)
                onAdd(
                  [server],
                  server.enabled
                    ? `Added ${server.id}. It starts the next time the agent runs.`
                    : `Added ${server.id}, switched off. Tick its box in the list to switch it on.`
                )
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

/**
 * "Add from catalog" and "Paste JSON" under the MCP server list. Both only append to
 * the working list (which then saves like any edit); nothing is connected or run
 * from here, and a server added switched off stays inert until its box is ticked.
 */
export function McpAddPanels({
  servers,
  workspace,
  onAdd
}: {
  servers: McpServerConfig[]
  workspace: string | null
  onAdd: (added: McpServerConfig[]) => void
}): JSX.Element {
  const [open, setOpen] = useState<'catalog' | 'paste' | null>(null)
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
  const toggle = (which: 'catalog' | 'paste'): void => {
    setMessage(null)
    setOpen((o) => (o === which ? null : which))
  }
  return (
    <div className="mcp-add" ref={rootRef}>
      <div className="mcp-review__actions">
        <button type="button" className="btn btn--sm" aria-expanded={open === 'catalog'} onClick={() => toggle('catalog')}>
          Add from catalog
        </button>
        <button type="button" className="btn btn--sm" aria-expanded={open === 'paste'} onClick={() => toggle('paste')}>
          Paste JSON
        </button>
      </div>
      {open === 'catalog' && <CatalogPanel workspace={workspace} taken={servers.map((s) => s.id)} onAdd={add} />}
      {open === 'paste' && <PastePanel current={servers} onAdd={add} />}
      {message && (
        <p className="field__hint" role="status">
          {message}
        </p>
      )}
    </div>
  )
}

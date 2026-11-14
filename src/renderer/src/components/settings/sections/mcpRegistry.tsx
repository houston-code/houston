import { useEffect, useRef, useState } from 'react'
import type { McpServerConfig } from '@shared/types'
import {
  registryDelivery,
  registryInstallOptions,
  type RegistrySearchResult,
  type RegistryServer
} from '@shared/mcpRegistry'
import { ReviewForm, addedMessage } from './mcpReview'

/**
 * "Browse registry": search the official MCP Registry and review an entry before
 * adding it. Every string shown here was written by the entry's publisher, so it is
 * rendered as plain text only (React escapes it, links are https:// only) and never
 * reaches the agent. An entry is added only through the review form, switched off
 * unless the user ticks the box, with every package pinned to an exact version.
 */
export function RegistryPanel({
  taken,
  onAdd,
  search
}: {
  taken: string[]
  onAdd: (servers: McpServerConfig[], message: string) => void
  search: (query: string, cursor?: string) => Promise<RegistrySearchResult>
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryServer[] | null>(null)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [searched, setSearched] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  // Only the newest request may fill the list, so a slow earlier answer can't overwrite it.
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const run = async (q: string, more?: string): Promise<void> => {
    const id = ++seq.current
    setBusy(true)
    setError(null)
    try {
      const res = await search(q, more)
      if (id !== seq.current) return
      if (!res.ok) {
        setError(res.error)
        if (!more) setResults(null)
        return
      }
      setSearched(q)
      setResults((cur) => (more && cur ? [...cur, ...res.page.servers] : res.page.servers))
      setCursor(res.page.nextCursor)
      if (!more) setReviewing(null)
    } catch {
      if (id === seq.current) setError('Could not reach the MCP Registry. Check your connection and try again.')
    } finally {
      if (id === seq.current) setBusy(false)
    }
  }

  return (
    <div className="mcp-registry">
      <form
        role="search"
        className="mcp-registry__search"
        onSubmit={(e) => {
          e.preventDefault()
          void run(query.trim())
        }}
      >
        <input
          ref={inputRef}
          type="search"
          aria-label="Search the MCP Registry"
          placeholder="Search by name (at least 3 characters), or leave empty to list all"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn btn--sm" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      <p className="field__hint">
        Entries come from the public MCP Registry and are written by their publishers. Houston pins each package to its listed
        version and adds it switched off.
      </p>
      {error && (
        <p className="mcp-review__error" role="alert">
          {error}
        </p>
      )}
      {results && results.length === 0 && (
        <p className="field__hint" role="status">
          No servers match {searched ? `“${searched}”` : 'that search'}.
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="mcp-catalog" aria-label="MCP Registry results">
          {results.map((server) => {
            const options = registryInstallOptions(server)
            const open = options.find((o) => 'draft' in o && o.draft.key === reviewing)
            return (
              <li key={server.name} className="mcp-catalog__item">
                <div className="mcp-catalog__head">
                  <span className="mcp-catalog__name">{server.title || server.name}</span>
                  {server.version && <span className="pill">v{server.version}</span>}
                  {server.status && server.status !== 'active' && <span className="pill">{server.status}</span>}
                </div>
                {server.title && <code className="mcp-catalog__cmd">{server.name}</code>}
                {server.description && <span className="mcp-catalog__desc">{server.description}</span>}
                <code className="mcp-catalog__cmd">{registryDelivery(server)}</code>
                {server.repositoryUrl && (
                  <a className="mcp-registry__link" href={server.repositoryUrl} target="_blank" rel="noreferrer noopener">
                    {server.repositoryUrl}
                  </a>
                )}
                {!open && (
                  <div className="mcp-review__actions">
                    {options.map((o) =>
                      'draft' in o ? (
                        <button
                          key={o.draft.key}
                          type="button"
                          className="btn btn--sm"
                          aria-label={`Review ${o.label}`}
                          onClick={() => setReviewing(o.draft.key)}
                        >
                          Review {o.kind === 'remote' ? 'remote' : o.label.split(' ')[0]}
                        </button>
                      ) : (
                        <span key={o.label} className="settings-dim mcp-registry__unsupported">
                          {o.label}: {o.unsupported}
                        </span>
                      )
                    )}
                    {options.length === 0 && <span className="settings-dim">No package or remote address listed.</span>}
                  </div>
                )}
                {open && 'draft' in open && (
                  <ReviewForm
                    key={open.draft.key}
                    draft={open.draft}
                    taken={taken}
                    onCancel={() => setReviewing(null)}
                    onAdd={(added) => {
                      setReviewing(null)
                      onAdd([added], addedMessage(added))
                    }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {results && cursor && (
        <div className="mcp-review__actions">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(searched, cursor)}>
            {busy ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  )
}

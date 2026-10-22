import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LspServerConfig, ModelOption } from '@shared/types'
import { parseHeaderLines } from '@shared/mcp'
import type { FetchSummary } from '@shared/model-listing'
import { useSectionMeta } from './SectionFrame'

function modelsToText(models: ModelOption[]): string {
  return models.map((m) => m.id).join('\n')
}

function textToModels(text: string, prev: ModelOption[]): ModelOption[] {
  // Keep everything known about an id that survives the edit (label, listed capabilities,
  // when it was added), so editing the list doesn't strip the picker's metadata.
  const byId = new Map(prev.map((m) => [m.id, m]))
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => byId.get(id) ?? { id })
}

/** Up to `max` ids, then "and N more", so a large fetch stays one readable line. */
function idList(ids: string[], max = 5): string {
  const shown = ids.slice(0, max).join(', ')
  return ids.length > max ? `${shown} and ${ids.length - max} more` : shown
}

/** What the last "fetch from provider" changed, shown under the models list. */
function FetchSummaryNote({ summary }: { summary: FetchSummary }): JSX.Element {
  const { total, added, removed, unrecognised } = summary
  const counted = `Fetched ${total} model${total === 1 ? '' : 's'}`
  if (added.length === 0 && removed.length === 0) {
    return (
      <p className="field__hint" role="status">
        {counted}. No changes.
      </p>
    )
  }
  return (
    <div className="field__hint" role="status">
      <p>
        {counted}: {added.length} new, {removed.length} no longer listed.
      </p>
      {added.length > 0 && <p>New: {idList(added)}.</p>}
      {removed.length > 0 && <p>Removed (no longer listed): {idList(removed)}.</p>}
      {unrecognised.length > 0 && (
        <p>
          This version of Houston doesn&apos;t fully recognize {idList(unrecognised)}. They work, but may
          show no price or sort as an unknown family until an update adds them.
        </p>
      )}
    </div>
  )
}

/**
 * "One model id per line" editor. Holds raw text in local state while the field
 * is focused so Enter, spaces, and blank lines behave normally, and only
 * normalizes (trim + drop empty lines) on blur. A controlled textarea that
 * re-parsed on every keystroke would strip the trailing newline as it was typed,
 * making it impossible to open a new line for the next id.
 */
export function ModelsField({
  models,
  busy,
  summary,
  onFetch,
  onChange
}: {
  models: ModelOption[]
  busy: boolean
  /** What the last fetch changed; cleared once the list is edited by hand. */
  summary?: FetchSummary
  onFetch: () => void
  onChange: (models: ModelOption[]) => void
}): JSX.Element {
  const [text, setText] = useState(() => modelsToText(models))
  // Re-sync from props when the list changes externally (e.g. "fetch from
  // provider"), but never while focused — that would clobber an in-progress edit.
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(modelsToText(models))
  }, [models])

  return (
    <label className="field">
      <span>
        Models{' '}
        <button className="link" onClick={onFetch} disabled={busy}>
          fetch from provider
        </button>
      </span>
      <textarea
        rows={3}
        value={text}
        placeholder="one model id per line"
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          const normalized = textToModels(text, models)
          onChange(normalized)
          setText(modelsToText(normalized))
        }}
      />
      {summary && <FetchSummaryNote summary={summary} />}
    </label>
  )
}

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/**
 * "One `Key: Value` per line" header editor. Like ModelsField, it holds raw text
 * in local state while focused and only parses on blur. Parsing every keystroke
 * would drop a line the instant you typed its key (before the colon) and strip
 * trailing newlines — making it impossible to start a new header line.
 */
export function HeadersField({
  headers,
  onChange,
  className,
  rows = 2,
  placeholder
}: {
  headers: Record<string, string> | undefined
  onChange: (headers: Record<string, string>) => void
  className?: string
  rows?: number
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState(() => headersToText(headers))
  // Re-sync when the value changes from outside, but never while focused.
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(headersToText(headers))
  }, [headers])

  return (
    <textarea
      className={className}
      rows={rows}
      placeholder={placeholder}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false
        const parsed = parseHeaderLines(text)
        onChange(parsed)
        setText(headersToText(parsed))
      }}
    />
  )
}

/**
 * JSON editor for extra language servers. Same local-text-while-focused pattern as
 * the fields above; parsed on blur, and kept as typed (with an error shown) when it
 * isn't a JSON array of server entries, so a half-finished edit is never lost.
 */
export function LspServersField({
  servers,
  onChange
}: {
  servers: LspServerConfig[] | undefined
  onChange: (servers: LspServerConfig[]) => void
}): JSX.Element {
  const toText = (list: LspServerConfig[] | undefined): string =>
    list && list.length ? JSON.stringify(list, null, 2) : ''
  const [text, setText] = useState(() => toText(servers))
  const [error, setError] = useState<string | null>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(toText(servers))
  }, [servers])

  return (
    <label className="field">
      <span>Extra language servers (JSON)</span>
      <textarea
        rows={4}
        value={text}
        spellCheck={false}
        placeholder='[{ "id": "lua", "command": "lua-language-server", "extensions": ["lua"] }]'
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          if (!text.trim()) {
            setError(null)
            onChange([])
            return
          }
          try {
            const parsed: unknown = JSON.parse(text)
            const valid =
              Array.isArray(parsed) &&
              parsed.every(
                (e) =>
                  e &&
                  typeof e === 'object' &&
                  typeof (e as LspServerConfig).id === 'string' &&
                  typeof (e as LspServerConfig).command === 'string' &&
                  Array.isArray((e as LspServerConfig).extensions)
              )
            if (!valid) {
              setError('Expected a list of entries, each with "id", "command", and "extensions".')
              return
            }
            setError(null)
            onChange(parsed as LspServerConfig[])
          } catch {
            setError('That is not valid JSON.')
          }
        }}
      />
      {error && (
        <span className="field__hint field__hint--warn" role="alert">
          {error}
        </span>
      )}
    </label>
  )
}

/**
 * "One domain per line" editor for the sandbox-egress allow/deny lists. Same
 * local-text-while-focused pattern as ModelsField: parsing on every keystroke
 * would strip the newline being typed. Entries are free-form here — the egress
 * matcher (@shared/egress parseEgressEntry) tolerates pasted URLs, `*.` prefixes,
 * and ports, so the editor only trims and drops blank lines.
 */
export function DomainListField({
  label,
  domains,
  placeholder,
  onChange
}: {
  label: string
  domains: string[]
  placeholder: string
  onChange: (domains: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(() => domains.join('\n'))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(domains.join('\n'))
  }, [domains])

  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={3}
        value={text}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          const parsed = text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          onChange(parsed)
          setText(parsed.join('\n'))
        }}
      />
    </label>
  )
}

/**
 * One settings subsection: a restyled <h3> title (kept as a real heading with
 * its exact text — tests query it), an optional one-line description, and a
 * body. Flat by design — separation comes from a top hairline + rhythm, not a
 * box. Purely presentational; adds no class any test depends on.
 */
export function SettingsSection({
  title,
  desc,
  children
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
}): JSX.Element {
  const meta = useSectionMeta()
  return (
    <section className="set-section">
      <div className="set-section__head">
        <h3>{title}</h3>
        {meta?.modified && (
          <>
            <span className="set-section__modified" title="Changed from the default">
              Modified
            </span>
            <button className="link set-section__reset" onClick={meta.onReset} aria-label={`Reset ${title} to defaults`}>
              Reset
            </button>
          </>
        )}
      </div>
      {desc != null && <p className="set-section__desc">{desc}</p>}
      <div className="set-section__body">{children}</div>
    </section>
  )
}

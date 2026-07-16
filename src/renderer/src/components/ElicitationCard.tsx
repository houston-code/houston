import { useState } from 'react'
import type { ElicitationField, ElicitationResult } from '@shared/agent'
import { buildElicitationContent } from '@shared/mcp'
import type { ElicitationItem } from '../lib/items'
import { Markdown } from './Markdown'

/**
 * Renders an MCP server's mid-call request for input (MCP elicitation): the
 * server's message plus one input per requested field, with Submit and Decline.
 * The card names the server the values go to — this is an EXTERNAL destination,
 * unlike ask_user, so the user must see who is asking. Once resolved it collapses
 * to a read-only record, mirroring QuestionCard.
 */
export function ElicitationCard({
  item,
  onResolve
}: {
  item: ElicitationItem
  onResolve: (elicitId: string, result: ElicitationResult) => void
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const resolved = item.outcome !== undefined

  const setValue = (name: string, v: string): void => {
    setValues((s) => ({ ...s, [name]: v }))
    setError(null)
  }

  const submit = (): void => {
    if (resolved) return
    const built = buildElicitationContent(item.fields, values)
    if ('error' in built) {
      setError(built.error)
      return
    }
    onResolve(item.id, { action: 'accept', content: built.content })
  }

  if (resolved) {
    const label =
      item.outcome === 'accepted' ? 'Provided' : item.outcome === 'declined' ? 'Declined' : 'Cancelled'
    return (
      <div className="question question--answered elicitation">
        <div className="elicitation__source">MCP server “{item.serverId}” asked for input</div>
        <div className="question__text">
          <Markdown text={item.message} />
        </div>
        <div className="question__answer">
          <span className="question__answer-label">{label}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="question elicitation">
      <div className="question__prompt-label">
        MCP server “{item.serverId}” requests input (your answer goes to that server)
      </div>
      <div className="question__text">
        <Markdown text={item.message} />
      </div>
      <form
        className="elicitation__form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {item.fields.map((f) => (
          <label key={f.name} className="elicitation__field">
            <span className="elicitation__field-label">
              {f.title ?? f.name}
              {f.required ? ' *' : ''}
            </span>
            {f.description && <span className="elicitation__field-desc">{f.description}</span>}
            <FieldInput field={f} value={values[f.name] ?? ''} onChange={(v) => setValue(f.name, v)} />
          </label>
        ))}
        {error && <div className="elicitation__error">{error}</div>}
        <div className="elicitation__actions">
          <button className="btn btn--sm btn--accent" type="submit">
            Submit
          </button>
          <button
            className="btn btn--sm"
            type="button"
            onClick={() => onResolve(item.id, { action: 'decline' })}
          >
            Decline
          </button>
        </div>
      </form>
    </div>
  )
}

/** One typed input: select for enums, checkbox-ish select for booleans, else text/number. */
function FieldInput({
  field,
  value,
  onChange
}: {
  field: ElicitationField
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  if (field.kind === 'enum') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? 'Choose…' : '(none)'}</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (field.kind === 'boolean') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? 'Choose…' : '(none)'}</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    )
  }
  return (
    <input
      type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
      step={field.kind === 'integer' ? 1 : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.format}
    />
  )
}

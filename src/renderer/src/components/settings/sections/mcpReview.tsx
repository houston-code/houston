import { useEffect, useRef, useState } from 'react'
import type { McpServerConfig } from '@shared/types'
import { sanitizeServerId } from '@shared/mcp'
import { applyDraftInputs, draftInputKey, freeServerId, serverProblem, type McpDraft, type McpDraftInput } from '@shared/mcpCatalog'
import { HeadersField } from '../fields'
import { useEscapeWithin } from '../../../lib/useFocusTrap'

/** One field per variable or header a registry entry asks for. */
function InputField({
  input,
  value,
  onChange
}: {
  input: McpDraftInput
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  const hint = [
    input.description,
    input.format ? `Format: ${input.format}` : '',
    !input.required && input.default ? `Leave empty to use ${input.default}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <label className="mcp-review__field">
      <span>
        <code>{input.name}</code> {input.kind === 'env' ? 'variable' : 'header'}
        {input.required ? ' (required)' : ' (optional)'}
      </span>
      <input
        type={input.secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

/** Review a server before adding it: every field editable, nothing saved until Add. */
export function ReviewForm({
  draft,
  taken,
  onAdd,
  onCancel
}: {
  draft: McpDraft
  taken: string[]
  onAdd: (server: McpServerConfig) => void
  onCancel: () => void
}): JSX.Element {
  const inputs = draft.inputs ?? []
  const [server, setServer] = useState<McpServerConfig>(() => ({ ...draft.server, id: freeServerId(draft.server.id, taken) }))
  const [values, setValues] = useState<Record<string, string>>({})
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
  const candidate: McpServerConfig = applyDraftInputs(
    // The id is tidied when its field loses focus (tidying every keystroke would eat the
    // `-` of `my-server`); Add reads the tidied form either way.
    { ...server, id: sanitizeServerId(server.id), args: remote ? [] : argsText.split('\n').map((a) => a.trim()).filter(Boolean) },
    inputs,
    values
  )
  const problem = serverProblem(candidate, taken)
  const patch = (p: Partial<McpServerConfig>): void => setServer((s) => ({ ...s, ...p }))

  return (
    <form
      ref={formRef}
      className="mcp-review"
      aria-label={`Review ${draft.name}`}
      onSubmit={(e) => {
        e.preventDefault()
        setTried(true)
        if (!problem) onAdd({ ...candidate, enabled: switchOn })
      }}
    >
      <p className="mcp-review__title">
        {draft.name} <span className="settings-dim">from {draft.publisher}</span>
      </p>
      {draft.note && <p className="field__hint">{draft.note}</p>}
      {draft.needs && <p className="field__hint">Needs {draft.needs} installed.</p>}
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
          {inputs.length === 0 && (
            <label className="mcp-review__field">
              <span>Headers, one per line (values are stored encrypted)</span>
              <HeadersField headers={server.headers} onChange={(headers) => patch({ headers })} />
            </label>
          )}
          {draft.headerHints && (
            <p className="field__hint">
              {Object.entries(draft.headerHints).map(([k, v]) => (
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
      {inputs.length > 0 && <p className="field__hint">Values are stored encrypted.</p>}
      {inputs.map((input) => (
        <InputField
          key={draftInputKey(input)}
          input={input}
          value={values[draftInputKey(input)] ?? ''}
          onChange={(v) => setValues((cur) => ({ ...cur, [draftInputKey(input)]: v }))}
        />
      ))}
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

/** Wording for the status line once a reviewed server is added. */
export function addedMessage(server: McpServerConfig): string {
  return server.enabled
    ? `Added ${server.id}. It starts the next time the agent runs.`
    : `Added ${server.id}, switched off. Tick its box in the list to switch it on.`
}

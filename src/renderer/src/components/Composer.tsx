import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { applyMention, mentionBeforeCursor, type MentionToken } from '../lib/mentions'

export function Composer({
  disabled,
  running,
  workspace,
  onSend,
  onCancel
}: {
  disabled: boolean
  running: boolean
  workspace: string | null
  onSend: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<MentionToken | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Query workspace files for the active @-mention (debounced).
  useEffect(() => {
    if (!mention || !workspace) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.listWorkspaceFiles(workspace, mention.query).then((files) => {
        if (!cancelled) {
          setSuggestions(files)
          setActiveIndex(0)
        }
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [mention, workspace])

  const showMenu = mention !== null && suggestions.length > 0

  const sync = (value: string, cursor: number): void => {
    setText(value)
    setMention(mentionBeforeCursor(value.slice(0, cursor)))
  }

  const choose = (path: string): void => {
    if (!mention) return
    const { text: next, caret } = applyMention(text, mention, path)
    setText(next)
    setMention(null)
    setSuggestions([])
    // Restore focus and place the cursor right after the inserted mention.
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(caret, caret)
      }
    })
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled || running) return
    onSend(trimmed)
    setText('')
    setMention(null)
    setSuggestions([])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(suggestions[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        setSuggestions([])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      <div className="composer__field">
        {showMenu && (
          <ul className="mention-menu">
            {suggestions.map((path, i) => (
              <li
                key={path}
                className={`mention-item ${i === activeIndex ? 'mention-item--active' : ''}`}
                // onMouseDown (not onClick) so it fires before the textarea blurs.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(path)
                }}
              >
                {path}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          className="composer__input"
          placeholder={
            disabled
              ? 'Pick a model and project folder to start…'
              : 'Ask Houston to build or change something…  (@ to mention a file)'
          }
          value={text}
          disabled={disabled}
          rows={1}
          onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
        />
      </div>
      {running ? (
        <button className="btn btn--danger composer__btn" onClick={onCancel}>
          Stop
        </button>
      ) : (
        <button className="btn btn--accent composer__btn" onClick={submit} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  )
}

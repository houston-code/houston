import { useState, type KeyboardEvent } from 'react'

export function Composer({
  disabled,
  running,
  onSend,
  onCancel
}: {
  disabled: boolean
  running: boolean
  onSend: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled || running) return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      <textarea
        className="composer__input"
        placeholder={disabled ? 'Pick a model and project folder to start…' : 'Ask Coder Pro to build or change something…'}
        value={text}
        disabled={disabled}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
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

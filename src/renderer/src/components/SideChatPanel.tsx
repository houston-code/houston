import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

interface SideTurn {
  id: string
  question: string
  answer?: string
  error?: string
}

/** The text "Send to main" queues into the main chat for one side-chat exchange. */
export function sideTurnHandoff(question: string, answer: string): string {
  return `From a side chat:\n\nQuestion: ${question}\n\nAnswer: ${answer}`
}

/**
 * The side chat: a docked panel for quick questions about the open chat, answered
 * by a read-only aside that sees the chat so far but never writes into it. It works
 * while the main chat's turn is still running. "Send to main" queues an exchange
 * into the main chat as a message; "Continue in new chat" forks the chat with the
 * exchange as a draft.
 *
 * Mounted per conversation (keyed by its id), so switching chats starts a new side
 * chat; the main process forgets this one when the panel unmounts.
 */
export function SideChatPanel({
  conversationId,
  providerId,
  model,
  onClose,
  onSendToMain,
  onContinueInNewChat,
  onResizeMouseDown
}: {
  conversationId: string
  /** The model answering; absent until one is picked (asking then says so). */
  providerId?: string
  model?: string
  onClose: () => void
  onSendToMain: (text: string) => void
  onContinueInNewChat: (text: string) => void
  onResizeMouseDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const [sideId] = useState(() => crypto.randomUUID())
  const [turns, setTurns] = useState<SideTurn[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      void window.api.closeSideChat(sideId)
    }
  }, [sideId])

  useEffect(
    () =>
      window.api.onSideChatProgress((p) => {
        if (p.sideId === sideId) setProgress(p.message)
      }),
    [sideId]
  )

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, progress])

  const ask = (): void => {
    const question = draft.trim()
    if (!question) {
      setInputError('Type a question first.')
      inputRef.current?.focus()
      return
    }
    if (pending) return
    if (!providerId || !model) {
      setInputError('Pick a model first.')
      return
    }
    const id = crypto.randomUUID()
    setTurns((prev) => [...prev, { id, question }])
    setDraft('')
    setInputError(null)
    setPending(true)
    setProgress('')
    window.api
      .askSideChat(sideId, conversationId, question, providerId, model)
      .then((answer) => setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, answer } : t))))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, error: message } : t)))
      })
      .finally(() => {
        setPending(false)
        setProgress('')
      })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      ask()
    }
  }

  return (
    <aside className="side-chat" aria-label="Side chat">
      <div
        className="plan-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side chat"
        onMouseDown={onResizeMouseDown}
      />
      <header className="plan-panel__head">
        <span className="plan-panel__badge" aria-hidden="true">
          <Icon name="sideChat" size={15} />
        </span>
        <span className="plan-panel__heading">Side chat</span>
        <span className="plan-panel__head-spacer" />
        <button
          type="button"
          className="plan-panel__iconbtn"
          onClick={onClose}
          aria-label="Close side chat"
          title="Close side chat"
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="side-chat__hint">
        Sees this chat so far and can read the project. It can't change anything, and nothing here goes into
        the main chat unless you send it.
      </p>
      <div className="side-chat__list" ref={listRef} aria-live="polite">
        {turns.length === 0 && <p className="side-chat__empty">Ask anything about this chat or the code.</p>}
        {turns.map((t, i) => {
          const last = i === turns.length - 1
          return (
            <div key={t.id} className="side-chat__turn">
              <div className="side-chat__q">{t.question}</div>
              {t.answer !== undefined && (
                <div className="side-chat__a">
                  <Markdown text={t.answer} />
                  <div className="side-chat__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={sent.has(t.id)}
                      onClick={() => {
                        onSendToMain(sideTurnHandoff(t.question, t.answer ?? ''))
                        setSent((prev) => new Set(prev).add(t.id))
                      }}
                    >
                      {sent.has(t.id) ? 'Sent to main' : 'Send to main'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onContinueInNewChat(sideTurnHandoff(t.question, t.answer ?? ''))}
                    >
                      Continue in new chat
                    </button>
                  </div>
                </div>
              )}
              {t.error && (
                <p className="side-chat__error" role="alert">
                  {t.error}
                </p>
              )}
              {last && pending && t.answer === undefined && !t.error && (
                <p className="side-chat__progress">{progress || 'Thinking…'}</p>
              )}
            </div>
          )
        })}
      </div>
      <form
        className="side-chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          ask()
        }}
      >
        <textarea
          ref={inputRef}
          className="side-chat__input"
          rows={2}
          placeholder="Why did it pick this approach?"
          aria-label="Side chat question"
          aria-invalid={inputError ? true : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (inputError) setInputError(null)
          }}
          onKeyDown={onKeyDown}
        />
        {inputError && <p className="side-chat__input-error">{inputError}</p>}
        <div className="side-chat__composer-row">
          {pending ? (
            <button type="button" className="btn btn--sm" onClick={() => void window.api.cancelSideChat(sideId)}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn--sm btn--accent">
              Ask
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SideChatView } from '@shared/agent'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const EMPTY: SideChatView = { turns: [] }

/** The message an IPC rejection carries, without Electron's "Error invoking remote method" prefix. */
function ipcMessage(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}

/**
 * The side chat: a docked panel for quick questions about the open chat, answered
 * by a read-only aside that sees the chat so far but never writes into it. It works
 * while the main chat's turn is still running. "Send to main" queues an exchange
 * into the main chat as a message; "Continue in new chat" forks the chat with the
 * exchange as a draft.
 *
 * The side chat itself is stored with its chat in the main process; this panel only
 * shows it. So closing the panel, switching chats, a plan review taking the column
 * (`hidden`), or a restart never loses an exchange, and an answer in flight keeps
 * going and lands when it's done. The panel refetches whenever the main process
 * says this chat's side chat changed.
 */
export function SideChatPanel({
  conversationId,
  providerId,
  model,
  hidden = false,
  onClose,
  onSendToMain,
  onContinueInNewChat,
  onResizeMouseDown
}: {
  conversationId: string
  /** The model answering; absent until one is picked (asking then says so). */
  providerId?: string
  model?: string
  /** Kept mounted but not shown (a plan review has the column), so the draft survives. */
  hidden?: boolean
  onClose: () => void
  /** Hand one exchange to the main chat (the app builds the turn and queues it if busy). */
  onSendToMain: (question: string, answer: string) => void
  onContinueInNewChat: (question: string, answer: string) => void
  onResizeMouseDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const [view, setView] = useState<SideChatView>(EMPTY)
  const [draft, setDraft] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    void window.api
      .getSideChat(conversationId)
      .then(setView)
      .catch(() => setView(EMPTY))
  }, [conversationId])

  useEffect(() => {
    refresh()
    return window.api.onSideChatChanged((p) => {
      if (p.conversationId === conversationId) refresh()
    })
  }, [conversationId, refresh])

  useEffect(() => {
    if (!hidden) inputRef.current?.focus()
  }, [hidden])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [view])

  const pending = view.pending

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
    setDraft('')
    setInputError(null)
    // Show the question straight away; the main process confirms it with a change
    // event, and the stored exchange (answer or error) replaces it when it lands.
    setView((v) => ({ ...v, pending: { id: 'local', question } }))
    window.api.askSideChat(conversationId, question, providerId, model).catch((e: unknown) => {
      // Only a question that was never asked rejects: put it back to edit.
      setDraft(question)
      setInputError(ipcMessage(e))
      refresh()
    })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      ask()
    }
  }

  return (
    <aside className="side-chat" aria-label="Side chat" hidden={hidden}>
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
        {(view.turns.length > 0 || pending) && (
          <button
            type="button"
            className="plan-panel__iconbtn"
            onClick={() => {
              setSent(new Set())
              void window.api.clearSideChat(conversationId)
            }}
            aria-label="New side chat"
            title="New side chat (clears this one)"
          >
            <Icon name="plus" />
          </button>
        )}
        <button
          type="button"
          className="plan-panel__iconbtn"
          onClick={onClose}
          aria-label="Close side chat"
          title="Close side chat (it's kept for this chat)"
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="side-chat__hint">
        Sees this chat so far and can read the project. It can't change anything, and nothing here goes into
        the main chat unless you send it. It's kept with this chat.
      </p>
      <div className="side-chat__list" ref={listRef} aria-live="polite">
        {view.turns.length === 0 && !pending && (
          <p className="side-chat__empty">Ask anything about this chat or the code.</p>
        )}
        {view.turns.map((t) => (
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
                      onSendToMain(t.question, t.answer ?? '')
                      setSent((prev) => new Set(prev).add(t.id))
                    }}
                  >
                    {sent.has(t.id) ? 'Sent to main' : 'Send to main'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => onContinueInNewChat(t.question, t.answer ?? '')}
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
          </div>
        ))}
        {pending && (
          <div className="side-chat__turn">
            <div className="side-chat__q">{pending.question}</div>
            <p className="side-chat__progress">{pending.progress || 'Thinking…'}</p>
          </div>
        )}
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
            <button type="button" className="btn btn--sm" onClick={() => void window.api.cancelSideChat(conversationId)}>
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

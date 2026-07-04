import { useState } from 'react'
import type { QuestionItem } from '../lib/items'
import { Markdown } from './Markdown'

/**
 * Renders an `ask_user` question: the agent's question plus suggested options and
 * a free-text fallback. Single-select submits on click; multi-select collects
 * choices behind a Submit button. Once answered it collapses to a read-only record
 * so the decision stays visible in the transcript.
 */
export function QuestionCard({
  item,
  onAnswer
}: {
  item: QuestionItem
  onAnswer: (callId: string, answer: string) => void
}): JSX.Element {
  const answered = item.answer !== undefined
  const multi = item.multiSelect === true
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')

  const submit = (answer: string): void => {
    const a = answer.trim()
    if (!a || answered) return
    onAnswer(item.id, a)
  }

  const choose = (label: string): void => {
    if (answered) return
    if (multi) {
      setSelected((s) => (s.includes(label) ? s.filter((l) => l !== label) : [...s, label]))
    } else {
      submit(label)
    }
  }

  if (answered) {
    return (
      <div className="question question--answered">
        <div className="question__text">
          <Markdown text={item.question} />
        </div>
        <div className="question__answer">
          <span className="question__answer-label">Answered</span>
          <span className="question__answer-text">{item.answer}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="question">
      <div className="question__prompt-label">The agent is asking</div>
      <div className="question__text">
        <Markdown text={item.question} />
      </div>
      {item.options.length > 0 && (
        <div className="question__options">
          {item.options.map((opt) => {
            const on = selected.includes(opt.label)
            return (
              <button
                key={opt.label}
                className={`question__option${on ? ' question__option--on' : ''}`}
                // Multi-select options are toggles; single-select are one-shot actions.
                aria-pressed={multi ? on : undefined}
                onClick={() => choose(opt.label)}
              >
                {multi && <span className="question__check">{on ? '☑' : '☐'}</span>}
                <span className="question__option-label">{opt.label}</span>
                {opt.description && <span className="question__option-desc">{opt.description}</span>}
              </button>
            )
          })}
        </div>
      )}
      {multi && (
        <button
          className="btn btn--sm btn--accent"
          disabled={selected.length === 0}
          onClick={() => submit(selected.join(', '))}
        >
          Submit{selected.length ? ` (${selected.length})` : ''}
        </button>
      )}
      <form
        className="question__custom"
        onSubmit={(e) => {
          e.preventDefault()
          submit(custom)
        }}
      >
        <input
          className="question__custom-input"
          type="text"
          placeholder="Or type your own answer…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          aria-label="Type a custom answer"
        />
        <button className="btn btn--sm" type="submit" disabled={!custom.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

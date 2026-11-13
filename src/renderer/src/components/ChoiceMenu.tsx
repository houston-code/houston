import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Popover } from './Popover'

/** One pickable value: its name, and a line saying what choosing it does. */
export interface Choice<T extends string> {
  value: T
  label: string
  hint: string
}

/**
 * A single-choice picker whose options each carry a one-line explanation, for
 * controls where the names alone don't say what will happen (approval mode,
 * reasoning effort). The trigger shows the current choice; the menu lists every
 * option with its hint. Keyboard: Enter, Space or ArrowDown opens; arrows move;
 * Enter or Space picks; Escape closes.
 */
export function ChoiceMenu<T extends string>({
  value,
  choices,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  tourId
}: {
  value: T
  choices: readonly Choice<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  title?: string
  disabled?: boolean
  /** `data-tour` anchor for the onboarding tips. */
  tourId?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const current = choices.find((c) => c.value === value)

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="control control--select control--choice"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        data-tour={tourId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="control__text">{current?.label ?? value}</span>
      </button>

      {open && (
        <Popover anchorRef={btnRef} onClose={() => setOpen(false)} align="left" className="menu choice-menu">
          <div id={listId} role="listbox" aria-label={ariaLabel} className="choice-menu__list">
            {choices.map((c) => (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={c.value === value}
                // Open on the current choice, so the arrows move from where the user is.
                {...(c.value === value ? { 'data-autofocus': '' } : {})}
                className={`menu__item choice-menu__item${c.value === value ? ' is-selected' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (c.value !== value) onChange(c.value)
                }}
              >
                <span className="choice-menu__check" aria-hidden="true">
                  {c.value === value ? '✓' : ''}
                </span>
                <span className="choice-menu__text">
                  <span className="choice-menu__label">{c.label}</span>
                  <span className="choice-menu__hint">{c.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'

/**
 * Where short-lived notes ("Marked unread", a saved permission rule, a folder that
 * would not open) show: stacked one above another just over the message box, never
 * on top of each other or of its controls. The stack is one live region that is
 * always in the page, so a screen reader announces each note as it arrives (a region
 * inserted together with its text often goes unannounced).
 */
export function ToastStack({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="toast-anchor">
      <div className="toast-stack" role="status" aria-live="polite">
        {children}
      </div>
    </div>
  )
}

/**
 * One note in the {@link ToastStack}. It leaves after `ms`, but the clock stops while
 * the pointer is over it or focus is in it, so its buttons (Undo, Permissions) can be
 * reached from the keyboard or read before it goes. A new `resetKey` (a new note in
 * the same place) starts the clock again.
 */
export function Toast({
  ms,
  onDone,
  resetKey,
  className = '',
  children
}: {
  ms: number
  onDone: () => void
  resetKey?: unknown
  className?: string
  children: ReactNode
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const remaining = useRef(ms)

  useEffect(() => {
    remaining.current = ms
  }, [ms, resetKey])

  useEffect(() => {
    if (paused) return
    const start = Date.now()
    const t = setTimeout(() => onDoneRef.current(), Math.max(0, remaining.current))
    return () => {
      clearTimeout(t)
      remaining.current -= Date.now() - start
    }
  }, [paused, ms, resetKey])

  return (
    <div
      className={`undo-toast${className ? ` ${className}` : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      {children}
    </div>
  )
}

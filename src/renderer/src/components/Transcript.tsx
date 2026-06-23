import { useEffect, useRef } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import type { DisplayItem } from '../lib/items'
import { isNearBottom } from '../lib/scroll'
import { ToolCard } from './ToolCard'

function Bubble({
  role,
  text,
  streaming,
  reasoning
}: {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  reasoning?: string
}): JSX.Element {
  return (
    <div className={`bubble bubble--${role}`}>
      <div className="bubble__role">{role === 'user' ? 'You' : 'Houston'}</div>
      {reasoning && (
        <details className="reasoning" open={streaming && !text}>
          <summary className="reasoning__summary">💭 Reasoning</summary>
          <div className="reasoning__text">{reasoning}</div>
        </details>
      )}
      {(text || !reasoning) && (
        <div className="bubble__text">
          {text}
          {streaming && <span className="cursor">▋</span>}
        </div>
      )}
    </div>
  )
}

export function Transcript({
  items,
  onApprove
}: {
  items: DisplayItem[]
  onApprove: (callId: string, decision: ToolApprovalDecision) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Whether the view is currently stuck to the bottom. Starts pinned so the
  // first messages scroll into view, then follows the user: scrolling up
  // unpins, scrolling back to the bottom re-pins.
  const pinnedRef = useRef(true)

  function handleScroll(): void {
    const el = containerRef.current
    if (el) pinnedRef.current = isNearBottom(el)
  }

  // Keep the latest output in view only while pinned. Using an instant jump
  // (not smooth) avoids restarting an animation on every streaming delta, which
  // is what made the view flicker and fight the user's own scrolling.
  useEffect(() => {
    const el = containerRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items])

  return (
    <div className="transcript" ref={containerRef} onScroll={handleScroll}>
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return <Bubble key={item.id} role="user" text={item.text} />
          case 'assistant':
            return (
              <Bubble
                key={item.id}
                role="assistant"
                text={item.text}
                streaming={item.streaming}
                reasoning={item.reasoning}
              />
            )
          case 'tool':
            return <ToolCard key={item.id} item={item} onApprove={onApprove} />
          case 'notice':
            return (
              <div key={item.id} className={`notice notice--${item.tone}`}>
                {item.text}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}

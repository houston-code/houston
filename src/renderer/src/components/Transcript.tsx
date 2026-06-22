import { useEffect, useRef } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import type { DisplayItem } from '../lib/items'
import { ToolCard } from './ToolCard'

function Bubble({ role, text, streaming }: { role: 'user' | 'assistant'; text: string; streaming?: boolean }): JSX.Element {
  return (
    <div className={`bubble bubble--${role}`}>
      <div className="bubble__role">{role === 'user' ? 'You' : 'Coder Pro'}</div>
      <div className="bubble__text">
        {text}
        {streaming && <span className="cursor">▋</span>}
      </div>
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
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items])

  return (
    <div className="transcript">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return <Bubble key={item.id} role="user" text={item.text} />
          case 'assistant':
            return <Bubble key={item.id} role="assistant" text={item.text} streaming={item.streaming} />
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
      <div ref={endRef} />
    </div>
  )
}

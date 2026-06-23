import { useEffect, useRef, useState } from 'react'
import type { ToolApprovalDecision } from '@shared/agent'
import type { DisplayItem } from '../lib/items'
import { groupItems } from '../lib/toolDisplay'
import { copyText } from '../lib/clipboard'
import { isNearBottom } from '../lib/scroll'
import { ToolGroup } from './ToolGroup'
import { Markdown } from './Markdown'

function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="msg msg--user">
      <div className="msg__body">{text}</div>
    </div>
  )
}

function AssistantMessage({
  text,
  streaming,
  reasoning
}: {
  text: string
  streaming?: boolean
  reasoning?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="msg msg--assistant">
      {reasoning && (
        <details className="reasoning" open={streaming && !text}>
          <summary className="reasoning__summary">💭 Reasoning</summary>
          <div className="reasoning__text">{reasoning}</div>
        </details>
      )}
      {(text || !reasoning) && (
        <div className="msg__body">
          <Markdown text={text} />
          {streaming && <span className="md-cursor" />}
        </div>
      )}
      {!streaming && text.trim() !== '' && (
        <button className="msg__copy" onClick={copy} title="Copy message">
          {copied ? '✓' : '⧉'}
        </button>
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
  const [showJump, setShowJump] = useState(false)

  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    pinnedRef.current = isNearBottom(el)
    setShowJump(!pinnedRef.current)
  }

  // Keep the latest output in view only while pinned. Using an instant jump
  // (not smooth) avoids restarting an animation on every streaming delta, which
  // is what made the view flicker and fight the user's own scrolling.
  useEffect(() => {
    const el = containerRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items])

  function jumpToBottom(): void {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinnedRef.current = true
    setShowJump(false)
  }

  const nodes = groupItems(items)

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={containerRef} onScroll={handleScroll}>
        <div className="transcript__inner">
          {nodes.map((node) => {
            switch (node.kind) {
              case 'user':
                return <UserBubble key={node.id} text={node.item.text} />
              case 'assistant':
                return (
                  <AssistantMessage
                    key={node.id}
                    text={node.item.text}
                    streaming={node.item.streaming}
                    reasoning={node.item.reasoning}
                  />
                )
              case 'toolgroup':
                return <ToolGroup key={node.id} items={node.items} onApprove={onApprove} />
              case 'notice':
                return (
                  <div key={node.id} className={`notice notice--${node.item.tone}`}>
                    {node.item.text}
                  </div>
                )
              default:
                return null
            }
          })}
        </div>
      </div>
      {showJump && (
        <button className="jump-bottom" onClick={jumpToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}
    </div>
  )
}

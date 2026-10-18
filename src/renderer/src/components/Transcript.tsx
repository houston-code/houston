import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  COMPACTION_SUMMARY_PREFIX,
  type ElicitationResult,
  type ToolApprovalDecision
} from '@shared/agent'
import { imageDataUrl, type ImageAttachment } from '@shared/images'
import type { PromptInvocation, PromptInvocationKind } from '@shared/promptInvocation'
import type { DisplayItem } from '../lib/items'
import { groupItems } from '../lib/toolDisplay'
import { copyText } from '../lib/clipboard'
import { isNearBottom } from '../lib/scroll'
import { ToolGroup } from './ToolGroup'
import { QuestionCard } from './QuestionCard'
import { ElicitationCard } from './ElicitationCard'
import { Markdown } from './Markdown'
import { Icon, type IconName } from './Icon'

/**
 * Subtle, hover-revealed copy affordance shared by user and assistant turns. The
 * `className` lets each turn place it (the assistant pins it to the top-right; the
 * user turn tucks it to the left of the right-aligned bubble — see global.css).
 */
/** Visually hidden, but read by screen readers (for the live status region). */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap'
}

function CopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      className={className ? `msg__copy ${className}` : 'msg__copy'}
      onClick={copy}
      title="Copy message"
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  )
}

const INVOCATION_ICON: Record<PromptInvocationKind, IconName> = {
  command: 'terminal',
  action: 'gitBranch',
  spawned: 'link'
}

/**
 * A turn whose text Houston wrote (`/review`, a ship button, `/agent`, a handoff
 * brief). The chip says what the user did; the prompt the agent actually received
 * stays one click away, so nothing it was told is hidden, just out of the way.
 */
function InvokedBubble({ text, invokedAs }: { text: string; invokedAs: PromptInvocation }): JSX.Element {
  const mono = invokedAs.kind === 'command'
  return (
    <div className="msg msg--user msg--invoked">
      <CopyButton text={text} className="msg__copy--user" />
      <div className="msg__invoked">
        <div className="msg__body msg__chip">
          <Icon name={INVOCATION_ICON[invokedAs.kind]} className="msg__chip-icon" />
          <span className={mono ? 'msg__chip-label msg__chip-label--mono' : 'msg__chip-label'}>
            {invokedAs.label}
          </span>
          {invokedAs.detail && <span className="msg__chip-detail">{invokedAs.detail}</span>}
        </div>
        <details className="msg__prompt">
          <summary className="msg__prompt-toggle">Instructions sent to the agent</summary>
          <div className="msg__prompt-text">{text}</div>
        </details>
      </div>
    </div>
  )
}

function UserBubble({
  text,
  images,
  isSummary,
  invokedAs
}: {
  text: string
  images?: ImageAttachment[]
  isSummary?: boolean
  invokedAs?: PromptInvocation
}): JSX.Element {
  // The compaction summary is model-authored markdown, not user input. Render it as
  // a labeled, full-width block with its body parsed as markdown rather than the
  // right-aligned plain-text bubble used for the user's own turns.
  if (isSummary) {
    const body = text.slice(COMPACTION_SUMMARY_PREFIX.length).trimStart()
    return (
      <div className="msg msg--summary">
        <div className="msg__summary-label">🗜 Summary of earlier conversation</div>
        <div className="msg__body">
          <Markdown text={body} />
        </div>
      </div>
    )
  }
  if (invokedAs && !images?.length) return <InvokedBubble text={text} invokedAs={invokedAs} />
  return (
    <div className="msg msg--user">
      {text.trim() !== '' && <CopyButton text={text} className="msg__copy--user" />}
      <div className="msg__body">
        {images && images.length > 0 && (
          <div className="bubble__images">
            {images.map((img, i) => (
              <img key={i} className="bubble__image" src={imageDataUrl(img)} alt="attachment" />
            ))}
          </div>
        )}
        {text}
      </div>
    </div>
  )
}

/**
 * The compact "Plan ready" marker for a plan the agent presented. While pending it's
 * a button that re-opens the review panel; once resolved it shows the outcome. The
 * plan's full content lives in the docked panel, not here.
 */
function PlanMarker({
  title,
  status,
  onOpen
}: {
  title: string
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  onOpen?: () => void
}): JSX.Element {
  const label =
    status === 'accepted'
      ? 'Accepted'
      : status === 'rejected'
        ? 'Rejected'
        : status === 'superseded'
          ? 'Revised'
          : 'Review →'
  const body = (
    <>
      <span className="plan-marker__icon" aria-hidden="true">
        <Icon name="clipboard" />
      </span>
      <span className="plan-marker__text">
        <span className="plan-marker__label">Plan ready</span>
        <span className="plan-marker__title">{title}</span>
      </span>
      <span className={`plan-marker__status plan-marker__status--${status}`}>{label}</span>
    </>
  )
  if (status === 'pending' && onOpen) {
    return (
      <button type="button" className="plan-marker plan-marker--open" onClick={onOpen}>
        {body}
      </button>
    )
  }
  return <div className={`plan-marker plan-marker--${status}`}>{body}</div>
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
      {!streaming && text.trim() !== '' && <CopyButton text={text} />}
    </div>
  )
}

/**
 * A missing-runtime notice with its fix: one click runs the install command in a
 * new integrated-terminal tab (the user's own shell, outside the sandbox, so the
 * install can actually work and they can see and answer any prompt), plus the
 * official download page as the fallback.
 */
function RuntimeNotice({
  text,
  runtime,
  onRunInTerminal
}: {
  text: string
  runtime: { label: string; installCommand?: string; url: string }
  onRunInTerminal?: (command: string) => void
}): JSX.Element {
  const [started, setStarted] = useState(false)
  const command = runtime.installCommand
  return (
    <div className="notice notice--error notice--runtime" role="status">
      <span>{text}</span>
      <span className="notice__actions">
        {command && onRunInTerminal && (
          <button
            type="button"
            className="btn btn--sm btn--accent"
            disabled={started}
            title={`Runs \`${command}\` in a new terminal tab`}
            onClick={() => {
              setStarted(true)
              onRunInTerminal(command)
            }}
          >
            {started ? 'Installing in terminal…' : `Install ${runtime.label}`}
          </button>
        )}
        <a className="btn btn--sm" href={runtime.url} target="_blank" rel="noreferrer">
          Download page
        </a>
      </span>
      {command && <code className="notice__command">{command}</code>}
      {started && (
        <span className="notice__next">
          When the install finishes in the terminal, ask me to continue.
        </span>
      )}
    </div>
  )
}

export function Transcript({
  items,
  onApprove,
  onAnswer,
  onElicit,
  onOpenPlan,
  onRunInTerminal
}: {
  items: DisplayItem[]
  onApprove: (callId: string, decision: ToolApprovalDecision) => void
  onAnswer: (callId: string, answer: string) => void
  /** Resolve an MCP server's mid-call input request (accept/decline). */
  onElicit: (elicitId: string, result: ElicitationResult) => void
  /** Re-open the review panel for a pending plan marker (clicked in the transcript). */
  onOpenPlan?: (callId: string) => void
  /** Run a command in a new integrated-terminal tab (a missing runtime's install). */
  onRunInTerminal?: (command: string) => void
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

  // Memoized so it isn't rebuilt when the Transcript re-renders for a non-content
  // reason (e.g. the scroll-to-bottom button toggling).
  const nodes = useMemo(() => groupItems(items), [items])

  // A coarse, polite status for screen readers — the streaming transcript is
  // otherwise silent to assistive tech. Announces on change only (not on mount).
  const liveStatus = useMemo(() => {
    const last = nodes[nodes.length - 1]
    if (!last) return ''
    if (last.kind === 'toolgroup' && last.items.some((i) => i.status === 'awaiting-approval'))
      return 'The agent is waiting for your approval.'
    if (last.kind === 'question') return 'The agent is asking a question.'
    if (last.kind === 'elicitation' && !last.item.outcome)
      return 'An MCP server is requesting input.'
    if (last.kind === 'assistant') return last.item.streaming ? 'The agent is responding…' : 'Response ready.'
    return ''
  }, [nodes])

  return (
    <div className="transcript-wrap">
      <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>
        {liveStatus}
      </div>
      <div className="transcript" ref={containerRef} onScroll={handleScroll}>
        <div className="transcript__inner">
          {nodes.map((node) => {
            switch (node.kind) {
              case 'user':
                return (
                  <UserBubble
                    key={node.id}
                    text={node.item.text}
                    images={node.item.images}
                    isSummary={node.item.isSummary}
                    invokedAs={node.item.invokedAs}
                  />
                )
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
              case 'question':
                return <QuestionCard key={node.id} item={node.item} onAnswer={onAnswer} />
              case 'elicitation':
                return <ElicitationCard key={node.id} item={node.item} onResolve={onElicit} />
              case 'plan':
                return (
                  <PlanMarker
                    key={node.id}
                    title={node.item.plan.title}
                    status={node.item.status}
                    onOpen={onOpenPlan ? () => onOpenPlan(node.item.id) : undefined}
                  />
                )
              case 'notice':
                return node.item.runtime ? (
                  <RuntimeNotice
                    key={node.id}
                    text={node.item.text}
                    runtime={node.item.runtime}
                    onRunInTerminal={onRunInTerminal}
                  />
                ) : (
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

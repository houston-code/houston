import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  COMPACTION_SUMMARY_PREFIX,
  type ElicitationResult,
  type ToolApprovalDecision
} from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { cachedImageDataUrl } from '../lib/imageUrl'
import type { PromptInvocation, PromptInvocationKind } from '@shared/promptInvocation'
import { rewindTargets, turnStatsByReply, type DisplayItem, type RewindItemTarget } from '../lib/items'
import { fullTime, parseAt, relativeTime, turnStatsParts, useNow, type TurnStats } from '../lib/messageMeta'
import type { RewindMode } from '@shared/rewind'
import { Popover } from './Popover'
import { groupItems, type RenderNode } from '../lib/toolDisplay'
import { ItemBoundary } from './ItemBoundary'
import { countsAsReply } from '@shared/chatStatus'
import { copyText } from '../lib/clipboard'
import { isNearBottom } from '../lib/scroll'
import { scrollBehavior } from '../lib/motion'
import { useTransientFlag } from '../hooks/useTransientFlag'
import { useStableCallback } from '../hooks/useStableCallback'
import { ToolGroup } from './ToolGroup'
import { QuestionCard } from './QuestionCard'
import { ProposalCard, type ProposalHandlers } from './ProposalCard'
import { ElicitationCard } from './ElicitationCard'
import { Receipt } from './Receipt'
import { Markdown } from './Markdown'
import { Icon, type IconName } from './Icon'
import { TranscriptPrefsContext, useTranscriptPrefs, type TranscriptPrefs } from './transcriptPrefs'
import { ContextMenu, selectionWithin, useContextMenu, type ContextMenuItem } from './ContextMenu'

/** Visually hidden, but read by screen readers (for the live status region). */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap'
}

/**
 * How long after the user opens or closes a row the chat's growth counts as theirs
 * (kept in place) rather than new output (followed to the bottom).
 */
const DISCLOSURE_HOLD_MS = 500

/**
 * Subtle, hover-revealed copy affordance shared by user and assistant turns. The
 * `className` lets each turn place it (the assistant pins it to the top-right; the
 * user turn tucks it to the left of the right-aligned bubble — see global.css).
 */
function CopyButton({ text, className }: { text: string; className?: string }): JSX.Element {
  const [copied, showCopied] = useTransientFlag(1200)
  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (ok) showCopied()
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

/**
 * A message's right-click menu: the selected text (when there is some), the whole
 * message, then that message's own actions. Built when the menu opens, so the
 * selection it offers is the one the user right-clicked on.
 */
function useMessageMenu(
  text: string,
  actions: () => ContextMenuItem[]
): {
  ref: RefObject<HTMLDivElement | null>
  onContextMenu: (e: ReactMouseEvent) => void
  menu: JSX.Element | null
} {
  const cm = useContextMenu<HTMLDivElement>()
  const [selection, setSelection] = useState('')
  const items: ContextMenuItem[] = []
  if (cm.at) {
    if (selection.trim()) items.push({ label: 'Copy selection', onSelect: () => void copyText(selection) })
    if (text.trim()) items.push({ label: 'Copy message', onSelect: () => void copyText(text) })
    const own = actions()
    if (own.length && items.length) own[0] = { ...own[0], separator: true }
    items.push(...own)
  }
  return {
    ref: cm.ref,
    onContextMenu: (e) => {
      setSelection(selectionWithin(cm.ref.current))
      cm.onContextMenu(e)
    },
    menu:
      cm.at && items.length ? (
        <ContextMenu anchorRef={cm.ref} at={cm.at} label="Message actions" items={items} onClose={cm.close} />
      ) : null
  }
}

/** The rewind menu's choices, shared by the hover menu and the right-click menu. */
function rewindItems(target: RewindItemTarget, handlers: RewindHandlers): ContextMenuItem[] {
  const disabled = handlers.disabled
  return [
    { label: 'Edit and resend', onSelect: () => handlers.onEdit(target), disabled },
    { label: 'Rewind conversation and code', onSelect: () => handlers.onRewind(target, 'both'), disabled },
    { label: 'Rewind conversation only', onSelect: () => handlers.onRewind(target, 'conversation'), disabled },
    { label: 'Rewind code only', onSelect: () => handlers.onRewind(target, 'code'), disabled },
    ...(handlers.onFork
      ? [{ label: 'Fork from here', onSelect: () => handlers.onFork?.(target), separator: true }]
      : [])
  ]
}

/** When a message was sent, relative, with the full date and time on hover. */
function SentAt({ at }: { at: number }): JSX.Element {
  const now = useNow()
  return (
    <time className="msg__time" dateTime={new Date(at).toISOString()} title={fullTime(at)}>
      {relativeTime(at, now)}
    </time>
  )
}

/**
 * The quiet line under a message: when it was sent and, under a turn's last reply,
 * the models that answered and what the turn spent. Renders nothing when none of it
 * is known (messages saved before it was recorded).
 */
function MessageMeta({ at, turn, align }: { at?: string; turn?: TurnStats; align: 'user' | 'assistant' }): JSX.Element | null {
  const when = parseAt(at)
  const parts = turn ? turnStatsParts(turn) : []
  if (when === undefined && parts.length === 0) return null
  return (
    <div className={`msg__meta msg__meta--${align}`}>
      {when !== undefined && <SentAt at={when} />}
      {parts.map((p, i) => (
        <span key={i} className="msg__meta-part">
          {p}
        </span>
      ))}
    </div>
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
function InvokedBubble({
  text,
  invokedAs,
  actions,
  menu,
  at
}: {
  text: string
  invokedAs: PromptInvocation
  actions?: ReactNode
  menu: ReturnType<typeof useMessageMenu>
  at?: string
}): JSX.Element {
  const mono = invokedAs.kind === 'command'
  return (
    <div className="msg msg--user msg--invoked" ref={menu.ref} onContextMenu={menu.onContextMenu}>
      {menu.menu}
      <CopyButton text={text} className="msg__copy--user" />
      {actions}
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
      <MessageMeta at={at} align="user" />
    </div>
  )
}

interface UserBubbleProps {
  text: string
  images?: ImageAttachment[]
  isSummary?: boolean
  invokedAs?: PromptInvocation
  /** When it was sent (ISO 8601), if known. */
  at?: string
  /** This message's rewind point; with `rewind`, shows the rewind menu beside the copy button. */
  rewindTarget?: RewindItemTarget
  rewind?: RewindHandlers
}

/**
 * Rewind targets are rebuilt as new objects whenever the item list changes, so a
 * bubble compares the target by what it says rather than by identity.
 */
function sameUserBubble(a: UserBubbleProps, b: UserBubbleProps): boolean {
  const ta = a.rewindTarget
  const tb = b.rewindTarget
  return (
    a.text === b.text &&
    a.images === b.images &&
    a.isSummary === b.isSummary &&
    a.invokedAs === b.invokedAs &&
    a.at === b.at &&
    a.rewind === b.rewind &&
    (ta === tb ||
      (ta !== undefined &&
        tb !== undefined &&
        ta.id === tb.id &&
        ta.turn === tb.turn &&
        ta.text === tb.text &&
        ta.label === tb.label &&
        ta.images === tb.images))
  )
}

const UserBubble = memo(function UserBubble({
  text,
  images,
  isSummary,
  invokedAs,
  at,
  rewindTarget,
  rewind
}: UserBubbleProps): JSX.Element {
  const actions = rewindTarget && rewind ? <RewindMenu target={rewindTarget} handlers={rewind} /> : undefined
  const menu = useMessageMenu(text, () =>
    rewindTarget && rewind && !isSummary ? rewindItems(rewindTarget, rewind) : []
  )
  // The compaction summary is model-authored markdown, not user input. Render it as
  // a labeled, full-width block with its body parsed as markdown rather than the
  // right-aligned plain-text bubble used for the user's own turns.
  if (isSummary) {
    const body = text.slice(COMPACTION_SUMMARY_PREFIX.length).trimStart()
    return (
      <div className="msg msg--summary" ref={menu.ref} onContextMenu={menu.onContextMenu}>
        {menu.menu}
        <div className="msg__summary-label">🗜 Summary of earlier conversation</div>
        <div className="msg__body">
          <Markdown text={body} />
        </div>
      </div>
    )
  }
  if (invokedAs && !images?.length)
    return <InvokedBubble text={text} invokedAs={invokedAs} actions={actions} menu={menu} at={at} />
  return (
    // A message steered into a running turn reads like any other: where it lands in
    // the transcript already shows it arrived mid-run.
    <div className="msg msg--user" ref={menu.ref} onContextMenu={menu.onContextMenu}>
      {menu.menu}
      {text.trim() !== '' && <CopyButton text={text} className="msg__copy--user" />}
      {actions}
      <div className="msg__body">
        {images && images.length > 0 && (
          <div className="bubble__images">
            {images.map((img, i) => (
              <img key={i} className="bubble__image" src={cachedImageDataUrl(img)} alt="attachment" />
            ))}
          </div>
        )}
        {text}
      </div>
      <MessageMeta at={at} align="user" />
    </div>
  )
}, sameUserBubble)

/** The transcript's rewind hooks; absent hides the menu (a new chat, a read-only view). */
export interface RewindHandlers {
  /** A turn is running: rewinding now would fight it, so the menu is disabled. */
  disabled: boolean
  onRewind: (target: RewindItemTarget, mode: RewindMode) => void
  onEdit: (target: RewindItemTarget) => void
  /** Start a new chat from the conversation before this message; absent hides it. */
  onFork?: (target: RewindItemTarget) => void
}

/**
 * The hover "Rewind" button on one of the user's messages and its menu: edit the
 * message and resend it, or rewind to just before it (conversation and code, the
 * conversation only, or the code only). Every choice but Edit goes through the
 * confirmation dialog, which shows what will change.
 */
function RewindMenu({ target, handlers }: { target: RewindItemTarget; handlers: RewindHandlers }): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const pick = (fn: () => void): void => {
    setOpen(false)
    fn()
  }
  return (
    <>
      <button
        ref={anchor}
        className="msg__copy msg__copy--user msg__rewind"
        onClick={() => setOpen((o) => !o)}
        disabled={handlers.disabled}
        title={handlers.disabled ? 'Rewind is available once the turn finishes' : 'Rewind to this message'}
        aria-label="Rewind to this message"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="rewind" />
      </button>
      {open && (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)} role="menu" ariaLabel="Rewind" align="right">
          {rewindItems(target, handlers).map((item) => (
            <Fragment key={item.label}>
              {item.separator && <div className="menu__sep" role="separator" />}
              <button role="menuitem" className="menu__item" onClick={() => pick(item.onSelect)}>
                {item.label}
              </button>
            </Fragment>
          ))}
        </Popover>
      )}
    </>
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
        {/* "ready" only while it awaits a decision; a decided plan reads "Plan · Rejected". */}
        <span className="plan-marker__label">{status === 'pending' ? 'Plan ready' : 'Plan'}</span>
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

const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming,
  reasoning,
  replyNumber,
  onMarkUnreadFrom,
  onForkFrom,
  onRetry,
  at,
  turn
}: {
  text: string
  streaming?: boolean
  reasoning?: string
  /** When the reply was written (ISO 8601), if known. */
  at?: string
  /** On a turn's last reply: what the turn cost, if known. */
  turn?: TurnStats
  /** This reply's position among the replies. */
  replyNumber?: number
  /** Mark the chat unread from a reply, by that position; absent hides the button. */
  onMarkUnreadFrom?: (replyNumber: number) => void
  /** Start a new chat from the conversation through a reply, by its position; absent hides it. */
  onForkFrom?: (replyNumber: number) => void
  /** On the chat's last reply once the run is over: run its user message again. */
  onRetry?: () => void
}): JSX.Element {
  const onMarkUnread =
    onMarkUnreadFrom && replyNumber !== undefined ? (): void => onMarkUnreadFrom(replyNumber) : undefined
  const onFork = onForkFrom && replyNumber !== undefined ? (): void => onForkFrom(replyNumber) : undefined
  const { showReasoning } = useTranscriptPrefs()
  const menu = useMessageMenu(text, () => [
    ...(!streaming && onMarkUnread ? [{ label: 'Mark unread from here', onSelect: onMarkUnread }] : []),
    ...(!streaming && onFork ? [{ label: 'Fork from here', onSelect: onFork }] : []),
    ...(!streaming && onRetry ? [{ label: 'Retry', onSelect: onRetry }] : [])
  ])
  return (
    <div className="msg msg--assistant" ref={menu.ref} onContextMenu={menu.onContextMenu}>
      {menu.menu}
      {reasoning && (
        <details className="reasoning" open={showReasoning || (streaming && !text)}>
          <summary className="reasoning__summary">💭 Reasoning</summary>
          <div className="reasoning__text">{reasoning}</div>
        </details>
      )}
      {(text || !reasoning) && (
        <div className="msg__body">
          <Markdown text={text} visuals />
          {streaming && <span className="md-cursor" />}
        </div>
      )}
      {!streaming && <MessageMeta at={at} turn={turn} align="assistant" />}
      {!streaming && text.trim() !== '' && <CopyButton text={text} />}
      {!streaming && onMarkUnread && (
        <button
          className="msg__copy msg__mark-unread"
          onClick={onMarkUnread}
          title="Mark unread from here"
          aria-label="Mark unread from here"
        >
          <Icon name="mail" />
        </button>
      )}
      {!streaming && onFork && (
        <button
          className="msg__copy msg__fork"
          onClick={onFork}
          title="Fork from here: a new chat with the conversation up to this reply"
          aria-label="Fork from here"
        >
          <Icon name="split" />
        </button>
      )}
      {!streaming && onRetry && (
        <button
          className="msg__copy msg__retry"
          onClick={onRetry}
          title="Send your last message again for a new reply"
          aria-label="Retry"
        >
          <Icon name="refresh" />
        </button>
      )}
    </div>
  )
})

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
  onRunInTerminal,
  proposals,
  onOpenConversation,
  rewind,
  onMarkUnreadFrom,
  onForkFrom,
  onRetryLast,
  newFromId,
  toolsExpanded = false,
  showReasoning = false
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
  /** Drives the propose_session cards; without it they show read-only. */
  proposals?: ProposalHandlers
  /** Open another chat (the handoff banner's link back to the chat that spawned this one). */
  onOpenConversation?: (id: string) => void
  /** Rewind to (or edit and resend) one of the user's messages; absent hides the menu. */
  rewind?: RewindHandlers
  /**
   * Mark the chat unread from a reply, named by its position among the replies
   * (0-based). Absent hides the button.
   */
  onMarkUnreadFrom?: (replyNumber: number) => void
  /**
   * Start a new chat holding the conversation through a reply, named by its position
   * among the replies (0-based). Absent hides the action.
   */
  onForkFrom?: (replyNumber: number) => void
  /**
   * Send the chat's last user message again for a new reply, offered on the last
   * reply. Absent (while a run is going, or with nothing to retry) hides it.
   */
  onRetryLast?: () => void
  /**
   * The reply where unseen output starts: a "New" divider goes above it, and the
   * view opens scrolled to it instead of to the bottom.
   */
  newFromId?: string
  /** Tool rows open with their output in view (the "Show tool output expanded" setting). */
  toolsExpanded?: boolean
  /** Reasoning stays open under each reply (the "Always show reasoning" setting). */
  showReasoning?: boolean
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Whether the view is currently stuck to the bottom. Starts pinned so the
  // first messages scroll into view, then follows the user: scrolling up
  // unpins, scrolling back to the bottom re-pins.
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  // The "New" divider, and whether it has scrolled out of view above (offer a jump).
  const newRef = useRef<HTMLDivElement>(null)
  const [newAbove, setNewAbove] = useState(false)
  // Where the last scroll event left the view, to tell which way the next one moved.
  const lastTopRef = useRef(0)
  // When the user last opened or closed something in the chat (a tool row, reasoning,
  // a receipt). The growth that follows is theirs, not new output to follow.
  const disclosedAtRef = useRef(Number.NEGATIVE_INFINITY)

  // Keep the latest output in view only while pinned. Using an instant jump
  // (not smooth) avoids restarting an animation on every streaming delta, which
  // is what made the view flicker and fight the user's own scrolling. Reading
  // scrollHeight forces a layout, so a burst of deltas folds into one jump per
  // frame instead of one per update.
  const pinFrame = useRef<number | null>(null)
  function followBottom(): void {
    if (!pinnedRef.current || pinFrame.current !== null) return
    pinFrame.current = requestAnimationFrame(() => {
      pinFrame.current = null
      const el = containerRef.current
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
    })
  }

  function handleScroll(): void {
    const el = containerRef.current
    if (!el) return
    const movedUp = el.scrollTop < lastTopRef.current
    lastTopRef.current = el.scrollTop
    if (isNearBottom(el)) pinnedRef.current = true
    // The reader can only leave the bottom by scrolling up. A view that moved down while
    // pinned, or stayed put while the chat grew beneath it (a row laid out at its
    // placeholder height settling to its real one a frame later), was moved by layout:
    // stay pinned and catch up.
    else if (movedUp || !pinnedRef.current) pinnedRef.current = false
    else followBottom()
    setShowJump(!pinnedRef.current)
    const divider = newRef.current
    setNewAbove(!!divider && divider.getBoundingClientRect().bottom < el.getBoundingClientRect().top)
  }

  // Scroll anchoring would hold a row below the one the user opened still and push the
  // opened row up out of view instead; hold it off while their toggle lays out.
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function noteDisclosure(target: EventTarget | null): void {
    if (!(target instanceof Element && target.closest('[aria-expanded], summary'))) return
    disclosedAtRef.current = performance.now()
    const el = containerRef.current
    if (!el) return
    el.style.overflowAnchor = 'none'
    if (anchorTimer.current !== null) clearTimeout(anchorTimer.current)
    anchorTimer.current = setTimeout(() => {
      anchorTimer.current = null
      el.style.overflowAnchor = ''
    }, DISCLOSURE_HOLD_MS)
  }
  useEffect(
    () => () => {
      if (anchorTimer.current !== null) clearTimeout(anchorTimer.current)
    },
    []
  )

  // Open on unseen output: start at the "New" divider rather than the bottom, and
  // stop following the bottom so the next render doesn't scroll past it.
  useEffect(() => {
    const el = containerRef.current
    const divider = newRef.current
    if (!el || !divider) return
    pinnedRef.current = false
    el.scrollTop = Math.max(0, divider.offsetTop - 12)
    setShowJump(!isNearBottom(el))
  }, [newFromId])

  // The user's latest message. When a new one lands (they sent or steered it), follow
  // it to the bottom even if they had scrolled up to read: their message and the reply
  // to it are what they are looking for next.
  const lastUserId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].id
    return undefined
  }, [items])
  const lastUserRef = useRef(lastUserId)

  useEffect(() => {
    if (lastUserId !== lastUserRef.current) {
      lastUserRef.current = lastUserId
      if (lastUserId !== undefined) {
        pinnedRef.current = true
        setShowJump(false)
      }
    }
    followBottom()
  }, [items, lastUserId])
  useEffect(
    () => () => {
      if (pinFrame.current !== null) cancelAnimationFrame(pinFrame.current)
    },
    []
  )

  // The view shrinks when a bar opens under it (the turn's file changes, a failed
  // turn's Retry, the queue, a banner) and grows when one closes. Stay at the bottom
  // through either while pinned; otherwise the last row ends up behind the new bar.
  // The rows themselves also grow after they mount: an off-screen row is laid out at a
  // placeholder height until it nears the viewport, and a card fills in its diff or
  // options a frame later. Follow that too, or a new approval or question lands with
  // its buttons below the fold while the run waits on them. A row the user just opened
  // is the exception: keep it where they clicked it.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      if (performance.now() - disclosedAtRef.current < DISCLOSURE_HOLD_MS) {
        pinnedRef.current = isNearBottom(el)
        setShowJump(!pinnedRef.current)
        return
      }
      el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [])

  function jumpToNew(): void {
    const el = containerRef.current
    const divider = newRef.current
    if (!el || !divider) return
    el.scrollTo({ top: Math.max(0, divider.offsetTop - 12), behavior: scrollBehavior() })
    setNewAbove(false)
  }

  function jumpToBottom(): void {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() })
    pinnedRef.current = true
    setShowJump(false)
  }

  // Rows are memoized, so the handlers they get must keep their identity across
  // renders: the parent re-creates several of them on every render (and re-renders on
  // every streamed update), which would otherwise re-render every row each time.
  const approve = useStableCallback(onApprove)
  const markUnreadFrom = useStableCallback(onMarkUnreadFrom)
  const retryLast = useStableCallback(onRetryLast)
  // The reply that offers Retry: the chat's last one.
  const lastReplyId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'assistant') return items[i].id
    return undefined
  }, [items])
  const rewindTo = useStableCallback(rewind?.onRewind)
  const rewindEdit = useStableCallback(rewind?.onEdit)
  const rewindFork = useStableCallback(rewind?.onFork)
  const forkFrom = useStableCallback(onForkFrom)
  const rewindDisabled = rewind?.disabled
  const stableRewind = useMemo<RewindHandlers | undefined>(
    () =>
      rewindTo && rewindEdit && rewindDisabled !== undefined
        ? {
            disabled: rewindDisabled,
            onRewind: rewindTo,
            onEdit: rewindEdit,
            ...(rewindFork ? { onFork: rewindFork } : {})
          }
        : undefined,
    [rewindTo, rewindEdit, rewindFork, rewindDisabled]
  )

  // Memoized so it isn't rebuilt when the Transcript re-renders for a non-content
  // reason (e.g. the scroll-to-bottom button toggling).
  const nodes = useMemo(() => groupItems(items), [items])

  // Expand / collapse every tool row at once. Each press is a new numbered command, so
  // pressing it again reaches rows the user has toggled since.
  const [expandAll, setExpandAll] = useState<TranscriptPrefs['expandAll']>(null)
  const allOpen = expandAll ? expandAll.open : toolsExpanded
  const hasTools = useMemo(() => nodes.some((n) => n.kind === 'toolgroup'), [nodes])
  const prefs = useMemo<TranscriptPrefs>(
    () => ({ toolsExpanded, showReasoning, expandAll }),
    [toolsExpanded, showReasoning, expandAll]
  )
  // Each user message's rewind point, by item id.
  const targets = useMemo(() => new Map(rewindTargets(items).map((t) => [t.id, t])), [items])
  // Each turn's details, keyed by its last reply.
  const turnStats = useMemo(() => turnStatsByReply(items), [items])
  // Each reply's position among the replies, by item id ("Mark unread from here").
  const replyNumbers = useMemo(() => {
    const out = new Map<string, number>()
    // Counted by the same rule main numbers saved replies with (forkCut, the unread
    // anchor), so "the Nth reply" names one message on both sides.
    for (const it of items)
      if (it.kind === 'assistant' && countsAsReply(it.text, !!it.reasoning)) out.set(it.id, out.size)
    return out
  }, [items])

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

  const renderNode = (node: RenderNode): ReactNode => {
    switch (node.kind) {
      case 'user': {
        const target = stableRewind ? targets.get(node.item.id) : undefined
        return (
          <UserBubble
            key={node.id}
            text={node.item.text}
            images={node.item.images}
            isSummary={node.item.isSummary}
            invokedAs={node.item.invokedAs}
            at={node.item.at}
            rewindTarget={target}
            rewind={stableRewind}
          />
        )
      }
      case 'assistant': {
        const n = replyNumbers.get(node.item.id)
        const reply = (
          <AssistantMessage
            key={node.id}
            text={node.item.text}
            streaming={node.item.streaming}
            reasoning={node.item.reasoning}
            replyNumber={n}
            onMarkUnreadFrom={markUnreadFrom}
            onForkFrom={forkFrom}
            onRetry={node.item.id === lastReplyId ? retryLast : undefined}
            at={node.item.at}
            turn={turnStats.get(node.item.id)}
          />
        )
        if (node.item.id !== newFromId) return reply
        return (
          <Fragment key={node.id}>
            <div ref={newRef} className="transcript__new" role="separator" aria-label="New since you last looked">
              New
            </div>
            {reply}
          </Fragment>
        )
      }
      case 'toolgroup':
        return <ToolGroup key={node.id} items={node.items} onApprove={approve} />
      case 'question':
        return <QuestionCard key={node.id} item={node.item} onAnswer={onAnswer} />
      case 'proposal':
        return <ProposalCard key={node.id} item={node.item} handlers={proposals} />
      case 'elicitation':
        return <ElicitationCard key={node.id} item={node.item} onResolve={onElicit} />
      case 'receipt':
        return <Receipt key={node.id} receipt={node.item.receipt} />
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
            {node.item.openConversationId && onOpenConversation && (
              <button
                type="button"
                className="notice__link"
                onClick={() => onOpenConversation(node.item.openConversationId as string)}
              >
                Open that chat
              </button>
            )}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <TranscriptPrefsContext.Provider value={prefs}>
    <div className="transcript-wrap">
      {hasTools && (
        <button
          type="button"
          className="transcript__tools-toggle"
          onClick={() => {
            disclosedAtRef.current = performance.now()
            setExpandAll((prev) => ({ open: !allOpen, seq: (prev?.seq ?? 0) + 1 }))
          }}
          title={allOpen ? 'Collapse every tool row' : 'Expand every tool row'}
          aria-label={allOpen ? 'Collapse tools' : 'Expand tools'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d={allOpen ? 'M4.5 2.5 8 6l3.5-3.5M4.5 13.5 8 10l3.5 3.5' : 'M4.5 6 8 2.5 11.5 6M4.5 10 8 13.5l3.5-3.5'}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>
        {liveStatus}
      </div>
      <div
        className="transcript"
        ref={containerRef}
        onScroll={handleScroll}
        onClickCapture={(e) => noteDisclosure(e.target)}
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' || e.key === ' ') noteDisclosure(e.target)
        }}
      >
        <div className="transcript__inner">
          {nodes.map((node) => (
            // A row that fails to render shows a notice in its place; the rest of
            // the chat (and the app) keeps working. Retried when its item changes.
            <ItemBoundary key={node.id} resetKey={node.kind === 'toolgroup' ? node.items : node.item}>
              {renderNode(node)}
            </ItemBoundary>
          ))}
        </div>
      </div>
      {newAbove && (
        <button className="jump-new" onClick={jumpToNew}>
          ↑ Jump to first unread
        </button>
      )}
      {showJump && (
        <button className="jump-bottom" onClick={jumpToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}
    </div>
    </TranscriptPrefsContext.Provider>
  )
}

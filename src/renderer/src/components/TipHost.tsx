import { useEffect, useMemo, useState } from 'react'
import { pickTip, TIP_IDS, type TipId } from '@shared/onboarding'
import { Coachmark, tipAnchor } from './Coachmark'
import { useDelayedFlag } from '../hooks/useDelayedFlag'

/**
 * Chooses and shows the next coachmark: the first relevant, unseen tip whose anchor
 * control is actually on screen. Anchors mount and unmount as the app re-renders (the
 * worktree toggle appears once repo info loads), so while any tip is relevant the
 * host watches the DOM and re-checks.
 */
export function TipHost({
  relevant,
  seen,
  suppressed,
  touring,
  delayMs = 0,
  onSeen,
  onTourEnd
}: {
  relevant: TipId[]
  seen: readonly string[] | undefined
  /** A modal or panel is open: hold tips until it closes. */
  suppressed: boolean
  touring: boolean
  /**
   * Wait this long after tips become relevant before showing them, so they arrive as
   * a follow-up rather than in the same instant (focus stays where it is meanwhile).
   * A requested tour is never delayed.
   */
  delayMs?: number
  onSeen: (ids: readonly TipId[]) => void
  onTourEnd: () => void
}): JSX.Element | null {
  const [tick, setTick] = useState(0)
  const [stepped, setStepped] = useState<TipId[]>([])
  const relevantKey = relevant.join(',')
  // Only watch the DOM while some relevant tip is still unseen; once onboarding is
  // done, an empty new chat (where tips are "relevant") costs nothing.
  const seenSet = new Set(seen ?? [])
  const settled = useDelayedFlag(relevant.length > 0, delayMs)
  const active =
    !suppressed && (touring || delayMs === 0 || settled) && relevant.some((id) => !seenSet.has(id))

  // A new set of relevant tips starts a new run (and a fresh "1 of N" counter).
  useEffect(() => setStepped([]), [relevantKey])

  useEffect(() => {
    if (!active || typeof MutationObserver === 'undefined') return
    let frame = 0
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTick((t) => t + 1))
    })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      obs.disconnect()
    }
  }, [active])

  const picked = useMemo(
    () => (active ? pickTip(relevant, seen, (id) => tipAnchor(id) !== null, stepped) : null),
    // `tick` re-runs the anchor lookup after DOM changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, relevantKey, seen, stepped, tick]
  )

  // A requested tour ends once it has nothing left to show on screen. Tips whose
  // controls weren't rendered stay unseen and appear later, in context.
  useEffect(() => {
    if (touring && !suppressed && !picked) onTourEnd()
  }, [touring, suppressed, picked, onTourEnd])

  if (!picked) return null
  return (
    <Coachmark
      key={picked.id}
      id={picked.id}
      index={picked.index}
      total={picked.total}
      hasNext={picked.hasNext}
      autoFocus={touring}
      onDone={() => {
        setStepped((s) => [...s, picked.id])
        onSeen([picked.id])
      }}
      onSkipAll={() => {
        onSeen(TIP_IDS)
        onTourEnd()
      }}
    />
  )
}

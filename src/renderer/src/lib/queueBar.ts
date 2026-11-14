import type { QueuedInputMeta } from '@shared/queue'

/**
 * The queue bar's summary line. Steers (waiting for the running turn's next step)
 * and queued follow-ups (waiting for the run to end) are counted apart, because they
 * land at different times and the bar is where a steer is visible until it lands.
 */
export function queueBarLabel(items: QueuedInputMeta[], running: boolean): string {
  const steers = items.filter((q) => q.steer).length
  const queued = items.length - steers
  if (!running) {
    const them = items.length === 1 ? 'it' : 'them'
    return `${items.length} queued · the run stopped: send ${them} now or clear ${them}`
  }
  if (!steers) return `${queued} queued · sent when this run finishes`
  if (!queued) return `${steers} steering · the agent reads ${steers === 1 ? 'it' : 'them'} before its next step`
  const steerPart = steers === 1 ? 'the steer lands' : 'steers land'
  const queuedPart = queued === 1 ? 'the queued one' : 'the rest'
  return `${steers} steering, ${queued} queued · ${steerPart} before the next step, ${queuedPart} after this run`
}

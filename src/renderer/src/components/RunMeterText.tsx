import { useTick } from '../hooks/useTick'
import { meterText, type RunMeter } from '../lib/runMeter'

/**
 * The status bar's live meter for a running turn: elapsed time and output tokens so
 * far. Its own component so the once-a-second tick re-renders only this text.
 */
export function RunMeterText({ meter }: { meter: RunMeter | null }): JSX.Element | null {
  const now = useTick(meter !== null)
  if (!meter) return null
  return (
    <span
      className="statusbar__meter"
      title="How long this turn has been running, and the output tokens it has produced so far (estimated while a reply streams)"
    >
      {meterText(meter, now || Date.now())}
    </span>
  )
}

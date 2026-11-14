import { useEffect, useRef, useState } from 'react'
import { EARLIER_MODELS_LABEL, formatTokens, formatUsd, unattributedUsage, type SessionUsage } from '@shared/usage'
import type { SubagentSpend } from '@shared/subagents'
import { ContextBreakdown } from './ContextBreakdown'

/** Subagent rows shown in the breakdown before the rest are summed into one. */
const MAX_AGENT_ROWS = 8

/**
 * The context/usage chip in the control bar: how full the context is (a small bar
 * and "used / maximum"), what the chat has cost so far, and a click-to-open
 * breakdown by model.
 *
 * The aggregate meter answered "how full is the context, and what has this cost",
 * but not *which model* spent it (a subagent or compaction pass often runs on a
 * cheaper one) or how much of the input was served from cache (most of a long
 * session's input, billing far below the base rate). Both were computed and then
 * dropped at the event seam; this surfaces them, matching the terminal's `/cost`.
 */
export function CostBreakdown({
  usage,
  contextWindow,
  priceTierAbove = null,
  compactionNote = null,
  meterPct,
  meterClass,
  agents = [],
  openSignal = 0
}: {
  usage: SessionUsage
  /** What each subagent in the chat spent (already counted in the model rows). */
  agents?: SubagentSpend[]
  contextWindow: number | null
  /** Prompt size past which the model bills at its long-context rate, when it has one. */
  priceTierAbove?: number | null
  /** Where automatic compaction kicks in, for the context breakdown. */
  compactionNote?: string | null
  /** Context-fill percent for the inline meter, or null when the window is unknown. */
  meterPct: number | null
  /** Extra class for the meter fill at warn/danger fill levels. */
  meterClass: string
  /** Bumped to open the panel from elsewhere (the `/context` command). */
  openSignal?: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openSignal > 0) setOpen(true)
  }, [openSignal])

  // One row per model, plus one for whatever the per-model tallies don't cover (usage
  // recorded before Houston kept them), so the rows add up to the total printed under them.
  const earlier = unattributedUsage(usage)
  const rows = [...(usage.perModel ?? []), ...(earlier ? [earlier] : [])]
  const agentRows = agents.slice(0, MAX_AGENT_ROWS)
  const agentRest = agents.slice(MAX_AGENT_ROWS)

  // Close on an outside click or Esc, the way every other transient panel does.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Consumed here: the app's own Esc handler would otherwise also stop the run.
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Context as "used/maximum", then what the chat cost. A model with no known price
  // (a local one) costs nothing to show, so the chip says how much it wrote instead.
  const contextText =
    meterPct !== null
      ? `${formatTokens(usage.context)}/${formatTokens(contextWindow!)}`
      : `${formatTokens(usage.context)} ctx`
  const spendText = usage.cost > 0 ? formatUsd(usage.cost) : `${formatTokens(usage.output)} out`

  const meter =
    meterPct !== null ? (
      <span className="usage__meter">
        <span className={`usage__fill${meterClass}`} style={{ width: `${meterPct}%` }} />
      </span>
    ) : null

  const tooltip =
    (contextWindow
      ? `Context: ${usage.context.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${meterPct}%)`
      : `Context: ${usage.context.toLocaleString()} tokens`) +
    `\nOutput this conversation: ${usage.output.toLocaleString()} tokens` +
    (usage.cost > 0 ? `\nEstimated cost: ${formatUsd(usage.cost)} (approximate)` : '') +
    '\nClick for what fills the context and the per-model breakdown'

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        type="button"
        className="usage usage--button"
        title={tooltip}
        aria-expanded={open}
        aria-label={`Usage: context ${contextText}${meterPct !== null ? ` (${meterPct}%)` : ''}, ${
          usage.cost > 0 ? `cost ${spendText}` : spendText
        }. Show breakdown`}
        onClick={() => setOpen((v) => !v)}
      >
        {meter}
        <span className="usage__text">{contextText}</span>
        <span className="usage__cost">{spendText}</span>
      </button>
      {open && (
        <div className="usage-panel" role="dialog" aria-label="Cost breakdown">
          <ContextBreakdown
            parts={usage.contextParts}
            measured={usage.context}
            contextWindow={contextWindow}
            priceTierAbove={priceTierAbove}
            compactionNote={compactionNote}
          />
          <div className="usage-panel__head">
            <span>Model</span>
            <span>In</span>
            <span>Out</span>
            <span>Cached</span>
            <span>Cost</span>
          </div>
          {rows.map((m) => (
            <div key={m === earlier ? 'earlier-models' : m.model} className="usage-panel__row">
              <span
                className="usage-panel__model"
                title={
                  m === earlier
                    ? `${EARLIER_MODELS_LABEL}: usage this conversation recorded before Houston kept a per-model breakdown`
                    : m.model
                }
              >
                {m.model}
              </span>
              <span>{m === earlier ? '–' : formatTokens(m.inputTokens)}</span>
              <span>{formatTokens(m.outputTokens)}</span>
              <span>{m.cacheReadTokens > 0 ? formatTokens(m.cacheReadTokens) : '–'}</span>
              <span>{m.cost > 0 ? formatUsd(m.cost) : '–'}</span>
            </div>
          ))}
          <div className="usage-panel__row usage-panel__row--total">
            <span>Total</span>
            <span />
            <span>{formatTokens(usage.output)}</span>
            <span>{(usage.cacheRead ?? 0) > 0 ? formatTokens(usage.cacheRead!) : '–'}</span>
            <span>{usage.cost > 0 ? formatUsd(usage.cost) : '–'}</span>
          </div>
          {agentRows.length > 0 && (
            <>
              <div className="usage-panel__head usage-panel__head--sub">
                <span>Subagents (included above)</span>
                <span>In</span>
                <span>Out</span>
                <span />
                <span>Cost</span>
              </div>
              {agentRows.map((a) => (
                <div key={a.id} className="usage-panel__row">
                  <span className="usage-panel__model" title={`${a.label} (${a.model})`}>
                    {a.label}
                  </span>
                  <span>{formatTokens(a.input)}</span>
                  <span>{formatTokens(a.output)}</span>
                  <span />
                  <span>{a.costUsd > 0 ? formatUsd(a.costUsd) : '–'}</span>
                </div>
              ))}
              {agentRest.length > 0 && (
                <div className="usage-panel__row">
                  <span className="usage-panel__model">
                    {agentRest.length} more subagent{agentRest.length === 1 ? '' : 's'}
                  </span>
                  <span>{formatTokens(agentRest.reduce((n, a) => n + a.input, 0))}</span>
                  <span>{formatTokens(agentRest.reduce((n, a) => n + a.output, 0))}</span>
                  <span />
                  <span>{formatUsd(agentRest.reduce((n, a) => n + a.costUsd, 0))}</span>
                </div>
              )}
            </>
          )}
          <p className="usage-panel__note">
            Cached input bills far below the base rate, so a long conversation costs
            less than its token count suggests. Costs are approximate.
          </p>
        </div>
      )}
    </div>
  )
}

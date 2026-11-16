import { useCallback, useEffect, useRef, useState } from 'react'
import { FAILURE_SIGNAL_INFO, signalParts } from '@shared/failureSignals'
import {
  groupKeyId,
  NO_REPLY_PROMPT_ID,
  runEndParts,
  type ModelScorecard,
  type Scorecard as ScorecardData,
  type ScorecardGroupBy
} from '@shared/scorecard'
import { formatTokens, formatUsd } from '@shared/usage'
import { useFocusTrap } from '../lib/useFocusTrap'
import { Icon } from './Icon'

/**
 * A slide-over panel showing a LOCAL-ONLY per-model "loop scorecard": how each
 * model has actually behaved across every persisted chat — run count, average
 * steps/tool-calls per run, cumulative + average cost and output tokens, how often
 * a run ended cleanly, how the others stopped short, its failure signals, and which
 * tools it leaned on. Optionally split by prompt version (each reply's promptId).
 *
 * PRIVACY: every number here is aggregated on-device from the user's own local
 * conversation files (the main process does the scan and hands back only the
 * summary). Nothing is transmitted. The failure signals come from reading the chats'
 * text and tool results, so the copy says that plainly; the panel only ever receives
 * counts. Steps and outcomes are reconstructed from the message log, so the copy
 * says "approximate" where that matters.
 */
export function Scorecard({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<ScorecardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [groupBy, setGroupBy] = useState<ScorecardGroupBy>('model')
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, onClose)

  const reload = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const s = await window.api.getScorecard(groupBy)
      setData(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [groupBy])

  useEffect(() => {
    void reload()
  }, [reload])

  const isEmpty = !!data && data.models.length === 0
  const byPrompt = data?.groupBy === 'model-prompt'

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        className="drawer scorecard"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Loop scorecard"
        tabIndex={-1}
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title">Loop scorecard</h2>
            <p className="changes-panel__scope">
              How each model has behaved across your chats, worked out on this computer and never
              sent anywhere. The failure signals come from reading your saved chats, including their
              text; only the counts are shown. Figures are approximate.
            </p>
          </div>
          {data && data.totalRuns > 0 && (
            <div className="changes-panel__total scorecard__total" aria-label="Totals">
              <span className="scorecard__total-runs">
                {data.totalRuns} run{data.totalRuns === 1 ? '' : 's'}
              </span>
              {data.totalCost > 0 && (
                <span className="scorecard__total-cost">≈{formatUsd(data.totalCost)}</span>
              )}
            </div>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void reload()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
          >
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close" data-autofocus>
            ✕
          </button>
        </header>

        <div className="changes-panel__body scorecard__body">
          <label className="scorecard__split">
            <input
              type="checkbox"
              checked={groupBy === 'model-prompt'}
              onChange={(e) => setGroupBy(e.target.checked ? 'model-prompt' : 'model')}
            />
            Split each model by prompt version
          </label>
          {error ? (
            <p className="changes-panel__empty">Couldn’t build the scorecard: {error}</p>
          ) : !data ? (
            <p className="changes-panel__empty">Loading…</p>
          ) : isEmpty ? (
            <p className="changes-panel__empty">
              No runs yet. Once you’ve chatted with a model, its stats show up here.
            </p>
          ) : (
            data.models.map((m) => <ModelCard key={groupKeyId(m)} row={m} byPrompt={byPrompt} />)
          )}
        </div>
      </aside>
    </div>
  )
}

/** What a row's prompt version reads as, when the scorecard is split by one. */
function promptLabel(row: ModelScorecard): string {
  if (row.promptId === NO_REPLY_PROMPT_ID) return 'no reply yet'
  return row.promptId ? `prompt ${row.promptId}` : 'before prompt ids'
}

/** The tooltip on a row's prompt version. */
function promptHint(row: ModelScorecard): string {
  if (row.promptId === NO_REPLY_PROMPT_ID) {
    return 'Chats whose runs all ended before the model replied, so no reply names a version'
  }
  return row.promptId
    ? 'The version of Houston’s own instructions these replies were written under'
    : 'Replies saved before Houston recorded which instructions wrote them'
}

/** One model's card: headline stats up top, how runs stopped short, signals, and tool usage. */
function ModelCard({ row, byPrompt }: { row: ModelScorecard; byPrompt: boolean }): JSX.Element {
  const completionPct = Math.round(row.completionRate * 100)
  const ended = row.completedRuns + row.limitedRuns
  // A row no chat's latest run was on (a model switched away from mid-chat, an older
  // prompt version) has nothing to rate, which isn't a 0% finish rate.
  const finish =
    ended > 0
      ? {
          value: `${completionPct}%`,
          hint: `${row.completedRuns} of ${ended} chats ended their latest run cleanly (the rest failed, were stopped, hit a limit, or were cut off)`
        }
      : { value: '–', hint: 'No chat’s latest run was on this row, so there is no finish to rate' }
  // The busiest tool sets the bar scale so the histogram fills the row nicely.
  const maxTool = row.tools.reduce((mx, t) => Math.max(mx, t.count), 0)
  const ends = runEndParts(row.runEnds)
  const signals = row.signals ? signalParts(row.signals) : null
  const name = byPrompt ? `${row.model} (${promptLabel(row)})` : row.model
  return (
    <section className="scorecard-card" aria-label={`Stats for ${name}`}>
      <header className="scorecard-card__head">
        <h3 className="scorecard-card__model" title={row.model}>
          {row.model}
        </h3>
        {byPrompt && (
          <span className="scorecard-card__prompt" title={promptHint(row)}>
            {promptLabel(row)}
          </span>
        )}
        <span className="scorecard-card__runs">
          {row.runs} run{row.runs === 1 ? '' : 's'}
        </span>
      </header>

      <dl className="scorecard-card__stats">
        <Stat label="Avg steps" value={String(row.avgSteps)} hint="Assistant turns per run" />
        <Stat
          label="Avg tools"
          value={String(row.avgToolCalls)}
          hint="Tool calls executed per run"
        />
        <Stat label="Clean finish" value={finish.value} hint={finish.hint} />
        <Stat
          label="Total cost"
          value={row.totalCost > 0 ? `≈${formatUsd(row.totalCost)}` : '–'}
          hint={
            row.totalCost > 0
              ? `Approximate; ≈${formatUsd(row.avgCost)} per run`
              : 'No price known for this model'
          }
        />
        <Stat
          label="Output"
          value={formatTokens(row.totalOutputTokens)}
          hint="Cumulative output tokens across all runs"
        />
      </dl>

      {ends.length > 0 && (
        <div className="scorecard-card__section">
          <span className="scorecard-card__tools-label">Stopped short</span>
          <ul className="scorecard-chips" aria-label="Runs that stopped short">
            {ends.map((p) => (
              <li key={p.label} className="scorecard-chip">
                {p.label} <span className="scorecard-chip__count">{p.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {signals && (
        <div className="scorecard-card__section">
          <span className="scorecard-card__tools-label">Failure signals</span>
          {signals.length > 0 ? (
            <ul className="scorecard-chips" aria-label="Failure signals">
              {signals.map((p) => (
                <li key={p.signal} className="scorecard-chip" title={FAILURE_SIGNAL_INFO[p.signal].hint}>
                  {p.label} <span className="scorecard-chip__count">{p.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="scorecard-card__none">None found</p>
          )}
        </div>
      )}

      {row.tools.length > 0 && (
        <div className="scorecard-card__tools">
          <span className="scorecard-card__tools-label">Tool usage</span>
          <ul className="scorecard-tools">
            {row.tools.map((t) => (
              <li key={t.name} className="scorecard-tool">
                <span className="scorecard-tool__name" title={t.name}>
                  {t.name}
                </span>
                <span className="scorecard-tool__bar" aria-hidden="true">
                  <span
                    className="scorecard-tool__fill"
                    style={{ width: `${maxTool ? (t.count / maxTool) * 100 : 0}%` }}
                  />
                </span>
                <span className="scorecard-tool__count">{t.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** A single labeled stat cell with an optional tooltip explaining how it's derived. */
function Stat({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="scorecard-stat" title={hint}>
      <dt className="scorecard-stat__label">{label}</dt>
      <dd className="scorecard-stat__value">{value}</dd>
    </div>
  )
}

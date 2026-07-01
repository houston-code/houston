import { useCallback, useEffect, useState } from 'react'
import type { ModelScorecard, Scorecard as ScorecardData } from '@shared/scorecard'
import { formatTokens, formatUsd } from '@shared/usage'

/**
 * A slide-over panel showing a LOCAL-ONLY per-model "loop scorecard": how each
 * model has actually behaved across every persisted chat — run count, average
 * steps/tool-calls per run, cumulative + average cost and output tokens, how often
 * a run ended cleanly, and which tools it leaned on.
 *
 * PRIVACY: every number here is aggregated on-device from the user's own local
 * conversation files (the main process does the scan and hands back only the
 * summary). Nothing is transmitted, and no message content is read — only counts.
 * The metrics are honest approximations of loop behavior derived from the message
 * log, not exact telemetry (Houston doesn't persist per-run stop reasons), so the
 * copy says "approximate" where that matters.
 */
export function Scorecard({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<ScorecardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const s = await window.api.getScorecard()
      setData(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const isEmpty = !!data && data.models.length === 0

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className="drawer scorecard"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Loop scorecard"
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title">Loop scorecard</h2>
            <p className="changes-panel__scope">
              How each model has behaved across your chats — aggregated on-device from local
              data only, never sent anywhere. Figures are approximate.
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
          >
            ⟳
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="changes-panel__body scorecard__body">
          {error ? (
            <p className="changes-panel__empty">Couldn’t build the scorecard: {error}</p>
          ) : !data ? (
            <p className="changes-panel__empty">Loading…</p>
          ) : isEmpty ? (
            <p className="changes-panel__empty">
              No runs yet. Once you’ve chatted with a model, its stats show up here.
            </p>
          ) : (
            data.models.map((m) => <ModelCard key={m.model} row={m} />)
          )}
        </div>
      </aside>
    </div>
  )
}

/** One model's card: headline stats up top, a small tool-usage histogram below. */
function ModelCard({ row }: { row: ModelScorecard }): JSX.Element {
  const completionPct = Math.round(row.completionRate * 100)
  // The busiest tool sets the bar scale so the histogram fills the row nicely.
  const maxTool = row.tools.reduce((mx, t) => Math.max(mx, t.count), 0)
  return (
    <section className="scorecard-card" aria-label={`Stats for ${row.model}`}>
      <header className="scorecard-card__head">
        <h3 className="scorecard-card__model" title={row.model}>
          {row.model}
        </h3>
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
        <Stat
          label="Clean finish"
          value={`${completionPct}%`}
          hint={`${row.completedRuns} of ${row.runs} runs ended cleanly (rest hit an error or were cut off)`}
        />
        <Stat
          label="Total cost"
          value={row.totalCost > 0 ? `≈${formatUsd(row.totalCost)}` : '—'}
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

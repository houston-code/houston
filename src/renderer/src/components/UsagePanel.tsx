import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageDay, UsageReport } from '@shared/usageReport'
import { formatTokens, formatUsd } from '@shared/usage'
import { useFocusTrap } from '../lib/useFocusTrap'
import { Icon } from './Icon'

/** "Nov 13" for a YYYY-MM-DD local date. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A money figure, or a dash when nothing was priced. */
const money = (n: number): string => (n > 0 ? formatUsd(n) : '–')

/**
 * The usage view: spend and tokens per day (last 30 days) and per project, from the
 * chats saved on this computer, plus the per-turn cost reminder. Everything is read
 * and summed locally by the main process; nothing is sent anywhere.
 */
export function UsagePanel({
  costCeilingUsd,
  onChangeCostCeiling,
  onClose
}: {
  /** The cost reminder setting (0 = off). */
  costCeilingUsd: number
  onChangeCostCeiling: (usd: number) => void
  onClose: () => void
}): JSX.Element {
  const [data, setData] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [ceiling, setCeiling] = useState(String(costCeilingUsd || 0))
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, onClose)

  const reload = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      setData(await window.api.getUsageReport())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const commitCeiling = (): void => {
    const v = Math.max(0, Number(ceiling) || 0)
    setCeiling(String(v))
    if (v !== (costCeilingUsd || 0)) onChangeCostCeiling(v)
  }

  const usedDays = data ? [...data.days].reverse().filter((d) => d.replies > 0 || d.cost > 0) : []
  const priced = (data?.allTime.cost ?? 0) > 0
  // Bars scale to the busiest day (or project) by cost, or by output for unpriced models.
  const dayScale = (d: UsageDay): number => (priced ? d.cost : d.outputTokens)
  const maxDay = usedDays.reduce((m, d) => Math.max(m, dayScale(d)), 0)
  const maxProject = (data?.projects ?? []).reduce((m, p) => Math.max(m, priced ? p.cost : p.outputTokens), 0)

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        className="drawer usage-view"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-view-title"
        tabIndex={-1}
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title" id="usage-view-title">
              Usage
            </h2>
            <p className="changes-panel__scope">
              Spend and tokens from the chats saved on this computer. Nothing is sent anywhere.
              Costs are estimates from each model&apos;s list price.
            </p>
          </div>
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

        <div className="changes-panel__body usage-view__body">
          {error ? (
            <p className="changes-panel__empty">Couldn’t read your usage: {error}</p>
          ) : !data ? (
            <p className="changes-panel__empty">Loading…</p>
          ) : (
            <>
              <dl className="usage-view__stats">
                <div className="scorecard-stat">
                  <dt className="scorecard-stat__label">Last 30 days</dt>
                  <dd className="scorecard-stat__value">{money(data.recent.cost)}</dd>
                </div>
                <div className="scorecard-stat">
                  <dt className="scorecard-stat__label">Output, 30 days</dt>
                  <dd className="scorecard-stat__value">{formatTokens(data.recent.outputTokens)}</dd>
                </div>
                <div className="scorecard-stat">
                  <dt className="scorecard-stat__label">All time</dt>
                  <dd className="scorecard-stat__value">{money(data.allTime.cost)}</dd>
                </div>
                <div className="scorecard-stat">
                  <dt className="scorecard-stat__label">Chats</dt>
                  <dd className="scorecard-stat__value">{data.allTime.chats}</dd>
                </div>
              </dl>

              <section className="usage-view__section" aria-labelledby="usage-days">
                <h3 className="usage-view__heading" id="usage-days">
                  Per day
                </h3>
                {usedDays.length === 0 ? (
                  <p className="usage-view__empty">No replies in the last 30 days.</p>
                ) : (
                  <table className="usage-view__table">
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col" aria-label="Share" />
                        <th scope="col">Replies</th>
                        <th scope="col">In</th>
                        <th scope="col">Out</th>
                        <th scope="col">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usedDays.map((d) => (
                        <tr key={d.date}>
                          <th scope="row">{dayLabel(d.date)}</th>
                          <td className="usage-view__barcell" aria-hidden="true">
                            <span className="usage-view__bar">
                              <span
                                className="usage-view__fill"
                                style={{ width: `${maxDay ? (dayScale(d) / maxDay) * 100 : 0}%` }}
                              />
                            </span>
                          </td>
                          <td>{d.replies}</td>
                          <td>{formatTokens(d.inputTokens)}</td>
                          <td>{formatTokens(d.outputTokens)}</td>
                          <td>{money(d.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="usage-view__section" aria-labelledby="usage-projects">
                <h3 className="usage-view__heading" id="usage-projects">
                  Per project, all time
                </h3>
                {data.projects.length === 0 ? (
                  <p className="usage-view__empty">No usage yet.</p>
                ) : (
                  <table className="usage-view__table">
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col" aria-label="Share" />
                        <th scope="col">Chats</th>
                        <th scope="col">In</th>
                        <th scope="col">Out</th>
                        <th scope="col">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((p) => (
                        <tr key={p.path}>
                          <th scope="row" title={p.path} className="usage-view__project">
                            <span className="usage-view__project-name">{p.name}</span>
                          </th>
                          <td className="usage-view__barcell" aria-hidden="true">
                            <span className="usage-view__bar">
                              <span
                                className="usage-view__fill"
                                style={{
                                  width: `${maxProject ? ((priced ? p.cost : p.outputTokens) / maxProject) * 100 : 0}%`
                                }}
                              />
                            </span>
                          </td>
                          <td>{p.chats}</td>
                          <td>{formatTokens(p.inputTokens)}</td>
                          <td>{formatTokens(p.outputTokens)}</td>
                          <td>{money(p.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(data.undated.cost > 0 || data.undated.outputTokens > 0) && (
                  <p className="usage-view__note">
                    {data.undated.cost > 0 ? `${formatUsd(data.undated.cost)} and ` : ''}
                    {formatTokens(data.undated.outputTokens)} output tokens came from subagents, reviews, or chats saved before replies recorded their own
                    usage. They count toward projects and all time, but not toward a day.
                  </p>
                )}
              </section>
            </>
          )}

          <section className="usage-view__section" aria-labelledby="usage-limit">
            <h3 className="usage-view__heading" id="usage-limit">
              Cost reminder
            </h3>
            <label className="usage-view__limit">
              <span>
                When one turn has cost more than this many US dollars, Houston tells the agent to
                wrap up and summarize. It is a reminder, not a hard stop: the agent finishes the
                step it is on. 0 turns it off.
              </span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={ceiling}
                aria-label="Cost reminder, US dollars per turn"
                onChange={(e) => setCeiling(e.target.value)}
                onBlur={commitCeiling}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCeiling()
                }}
              />
            </label>
          </section>
        </div>
      </aside>
    </div>
  )
}

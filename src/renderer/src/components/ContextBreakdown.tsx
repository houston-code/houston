import type { ContextParts } from '@shared/agent'
import { CONTEXT_APPROX_NOTE, contextEstimate, contextRows, contextShare, priceTierNote } from '@shared/contextBreakdown'
import { formatTokens } from '@shared/usage'

/**
 * What fills the context window now, part by part: Houston's instructions, the tool
 * definitions, project instructions, memories, the conversation, and tool results.
 * Shown at the top of the usage chip's panel, which `/context` also opens.
 */
export function ContextBreakdown({
  parts,
  measured,
  contextWindow,
  priceTierAbove = null
}: {
  /** The estimated parts of the most recent request; null before one was recorded. */
  parts: ContextParts | null | undefined
  /** The provider's measured context size (the chip's figure). */
  measured: number
  contextWindow: number | null
  /** Prompt size past which the model bills at its long-context rate, when it has one. */
  priceTierAbove?: number | null
}): JSX.Element {
  const pct = contextWindow && measured > 0 ? Math.min(100, Math.round((measured / contextWindow) * 100)) : null
  const tier = priceTierNote(measured, priceTierAbove)
  const head = (
    <>
      <p className="usage-panel__context">
        Context: {measured.toLocaleString()}
        {contextWindow ? ` of ${contextWindow.toLocaleString()} tokens (${pct}%)` : ' tokens'}
      </p>
      {tier && <p className="usage-panel__note">{tier}</p>}
    </>
  )
  if (!parts) {
    return (
      <section className="ctx-breakdown" aria-label="What fills the context">
        {head}
        <p className="usage-panel__note">The breakdown appears after the next reply in this chat.</p>
      </section>
    )
  }
  const rows = contextRows(parts)
  const estimate = contextEstimate(parts)
  return (
    <section className="ctx-breakdown" aria-label="What fills the context">
      {head}
      <ul className="ctx-breakdown__rows">
        {rows.map((r) => {
          const share = contextShare(r.tokens, estimate)
          return (
            <li key={r.key} className="ctx-breakdown__row" title={r.hint}>
              <span className="ctx-breakdown__label">{r.label}</span>
              <span className="ctx-breakdown__bar" aria-hidden="true">
                <span className="ctx-breakdown__fill" style={{ width: `${share}%` }} />
              </span>
              <span className="ctx-breakdown__tokens">~{formatTokens(r.tokens)}</span>
              <span className="ctx-breakdown__share">{share}%</span>
            </li>
          )
        })}
      </ul>
      <p className="usage-panel__note">{CONTEXT_APPROX_NOTE}</p>
    </section>
  )
}

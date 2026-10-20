import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, LegacyRulesChoice } from '@shared/types'
import { Icon } from './Icon'

/**
 * One-time notice that global rules now live in `~/.houston/AGENTS.md`, shown
 * while a `~/.claude/CLAUDE.md` exists that the new file doesn't import (main
 * decides; see globalRules.ts). Houston used to load that file implicitly, so
 * without this anyone relying on it would lose those rules without a word.
 *
 * "Import it" adds the single `@~/.claude/CLAUDE.md` line; "Keep separate" changes
 * nothing. Either answer is persisted and the notice never returns. A failed import
 * write is shown inline and NOT persisted, so the user can try again.
 */
export function GlobalRulesNotice({
  onDecided
}: {
  /** Fresh settings after an answer, so the caller's copy can't later overwrite it. */
  onDecided?: (settings: AppSettings) => void
}): JSX.Element | null {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.api.getLegacyRulesNotice())
      .then((s) => {
        if (live) setShow(s === true)
      })
      .catch(() => {
        // Non-fatal: leave it hidden rather than nag on bad data.
      })
    return () => {
      live = false
    }
  }, [])

  const decide = useCallback(
    async (choice: LegacyRulesChoice): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const res = await window.api.decideLegacyRulesNotice(choice)
        if (res.error) {
          setError(`Couldn't update ~/.houston/AGENTS.md: ${res.error}`)
          return
        }
        onDecided?.(res.settings)
        setShow(false)
      } catch {
        setError("Couldn't save your choice. Try again.")
      } finally {
        setBusy(false)
      }
    },
    [onDecided]
  )

  if (!show) return null

  return (
    <section className="rules-notice" role="region" aria-labelledby="rules-notice-title">
      <span className="rules-notice__icon" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <div className="rules-notice__body">
        <p className="rules-notice__title" id="rules-notice-title">
          Your global rules now live in <code>~/.houston/AGENTS.md</code>
        </p>
        <p className="rules-notice__text">
          Houston no longer loads <code>~/.claude/CLAUDE.md</code> on its own. Import it to keep
          those rules in every project, or keep Houston’s global rules separate.
        </p>
        {error && (
          <p className="rules-notice__error" role="alert">
            {error}
          </p>
        )}
        <div className="rules-notice__actions">
          <button
            type="button"
            className="btn btn--sm btn--accent"
            onClick={() => void decide('import')}
            disabled={busy}
          >
            Import it
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void decide('keep')}
            disabled={busy}
          >
            Keep separate
          </button>
          <span className="rules-notice__hint">
            Import adds one line: <code>@~/.claude/CLAUDE.md</code>
          </span>
        </div>
      </div>
    </section>
  )
}

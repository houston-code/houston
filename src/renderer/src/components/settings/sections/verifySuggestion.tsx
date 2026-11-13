import { useEffect, useState } from 'react'
import type { VerifySuggestion as Suggestion } from '@shared/types'

/**
 * Under the verification command field: the command the open project suggests (from
 * its package.json scripts, Cargo, Go or pytest setup) with a one-click fill. Filling
 * it only sets the command; whether verification runs stays the checkbox above.
 */
export function VerifySuggestion({
  workspace,
  current,
  onUse
}: {
  workspace: string | null
  current: string
  onUse: (command: string) => void
}): JSX.Element | null {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  useEffect(() => {
    let live = true
    setSuggestion(null)
    if (!workspace) return
    void window.api
      .inferVerifyCommand(workspace)
      .then((s) => {
        if (live) setSuggestion(s)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [workspace])
  if (!suggestion) return null
  const same = current.trim() === suggestion.command
  return (
    <p className="field__hint verify-suggestion">
      For this project: <code>{suggestion.command}</code> (from {suggestion.source}).{' '}
      {same ? (
        <span>In use.</span>
      ) : (
        <button type="button" className="link" onClick={() => onUse(suggestion.command)}>
          Use this command
        </button>
      )}
    </p>
  )
}

import type { DiffLine } from '@shared/diff'

/** Cap how many diff lines render at once so a huge change can't lock the UI. */
export const MAX_DIFF_LINES = 300

/**
 * Render a line diff as a red/green `<pre>`. Shared by the tool-call cards
 * (edit_file / write_file) and the Changes panel (per-hunk).
 */
export function DiffView({ diff }: { diff: DiffLine[] }): JSX.Element {
  return (
    <pre className="diff">
      {diff.slice(0, MAX_DIFF_LINES).map((l, i) => (
        <div key={i} className={`diff__line diff__line--${l.type}`}>
          <span className="diff__sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          <span className="diff__text">{l.text || ' '}</span>
        </div>
      ))}
      {diff.length > MAX_DIFF_LINES && (
        <div className="diff__more">… {diff.length - MAX_DIFF_LINES} more lines</div>
      )}
    </pre>
  )
}

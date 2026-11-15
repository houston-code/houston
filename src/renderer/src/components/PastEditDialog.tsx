import { useRef } from 'react'
import type { FileDiffPreview } from '@shared/diff'
import type { DisplayItem, ToolItem } from '../lib/items'
import { useFocusTrap } from '../lib/useFocusTrap'
import { DiffView } from './DiffView'
import { previewsFor } from './ToolGroup'

/** One finished file edit in the open chat, with the diff its row shows. */
export interface PastEdit {
  item: ToolItem
  previews: FileDiffPreview[]
}

/**
 * The open chat's finished file edits, oldest first: every write that completed and
 * has a diff to show (the same diff its row in the transcript shows). `/changes last
 * [n]` counts back from the newest.
 */
export function pastEdits(items: DisplayItem[]): PastEdit[] {
  const out: PastEdit[] = []
  for (const it of items) {
    if (it.kind !== 'tool' || it.toolKind !== 'write' || it.status !== 'done') continue
    const previews = previewsFor(it)
    if (previews && previews.some((p) => p.diff.length > 0)) out.push({ item: it, previews })
  }
  return out
}

/** `/changes last [n]` in the desktop app: the diff of one of the chat's past edits. */
export function PastEditDialog({
  edit,
  back,
  onClose
}: {
  edit: PastEdit
  /** How many edits back it is (1 = the latest). */
  back: number
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  const files = edit.previews.filter((p) => p.diff.length > 0)
  const title = back === 1 ? 'Latest edit' : `Edit ${back} back`
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="modal past-edit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="past-edit-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="past-edit-title">{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close" data-autofocus>
            ✕
          </button>
        </div>
        <div className="modal__body">
          {files.map((p, i) => (
            <div key={`${p.path}:${i}`} className="tool-row__diff-file">
              <div className="tool-row__diff-head">
                <span className="tool-row__diff-path" title={p.path}>
                  {p.path}
                </span>
                {p.created && <span className="tool-row__diff-tag">new file</span>}
                {p.deleted && <span className="tool-row__diff-tag tool-row__diff-tag--del">deleted</span>}
                {p.renamedFrom && (
                  <span className="tool-row__diff-tag" title={p.renamedFrom}>
                    renamed from {p.renamedFrom}
                  </span>
                )}
              </div>
              <DiffView diff={p.diff} path={p.path} />
              {p.truncated && (
                <div className="tool-row__diff-more">Diff shortened; the change continues past this point.</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

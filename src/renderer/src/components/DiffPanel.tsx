import { useCallback, useEffect, useState } from 'react'
import type { FileDiff, WorkingTreeChanges } from '@shared/workingTree'
import { chooseShipAction, type ShipAction } from '@shared/shipAction'
import { useInitGitRepo } from '../hooks/useInitGitRepo'
import { DiffView } from './DiffView'

/** Below this many files the list starts fully expanded; above it, collapsed. */
const AUTO_EXPAND_LIMIT = 8

function FileSection({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="changes-file">
      <button
        type="button"
        className="changes-file__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-row__chevron">{open ? '▾' : '▸'}</span>
        <span className="changes-file__path" title={file.path}>
          {file.oldPath && file.oldPath !== file.path && (
            <span className="changes-file__old">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        <span className="tool-row__spacer" />
        {(file.added > 0 || file.removed > 0) && (
          <span className="diff-stat">
            <span className="diff-stat__add">+{file.added}</span>
            <span className="diff-stat__del">−{file.removed}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="changes-file__body">
          {file.note ? (
            <p className="changes-file__note">{file.note}</p>
          ) : (
            file.hunks.map((h, i) => (
              <div key={i} className="changes-hunk">
                <div className="changes-hunk__header">{h.header}</div>
                <DiffView diff={h.lines} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A slide-over panel listing every uncommitted change in the workspace's working
 * tree (tracked diff vs HEAD + untracked files). Working-tree scoped — it shows
 * all uncommitted changes, not only what the current chat touched.
 *
 * `onShip`, when provided, renders a ship action that hands the work off to the
 * agent (commit → push → open PR via its existing tools) rather than the renderer
 * driving git directly. The action follows the repo's state: "Create PR" needs
 * commits and a GitHub remote, so a fresh repo gets "Publish to GitHub" instead
 * (see chooseShipAction). `creating` disables it while a run is busy.
 */
export function DiffPanel({
  workspace,
  onClose,
  onShip,
  creating = false
}: {
  workspace: string | null
  onClose: () => void
  onShip?: (action: ShipAction) => void
  creating?: boolean
}): JSX.Element {
  const [data, setData] = useState<WorkingTreeChanges | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { initializing, initError, initRepo } = useInitGitRepo(workspace)

  const load = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setData({ isRepo: false, branch: null, files: [], added: 0, removed: 0 })
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await window.api.getWorkingTreeChanges(workspace))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    void load()
  }, [load])

  const files = data?.files ?? []
  const shipAction = data?.isRepo ? chooseShipAction(data.ship) : null
  const defaultOpen = files.length <= AUTO_EXPAND_LIMIT

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className="drawer changes-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Working-tree changes"
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title">Changes</h2>
            <p className="changes-panel__scope">
              All uncommitted changes in the working tree{data?.branch ? ` on ${data.branch}` : ''} —
              not limited to this chat.
            </p>
          </div>
          {data?.isRepo && (data.added > 0 || data.removed > 0) && (
            <span className="diff-stat changes-panel__total">
              <span className="diff-stat__add">+{data.added}</span>
              <span className="diff-stat__del">−{data.removed}</span>
            </span>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void load()}
            disabled={loading}
            title="Refresh"
          >
            ⟳
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="changes-panel__body">
          {error ? (
            <p className="changes-panel__empty">Couldn’t read changes: {error}</p>
          ) : loading && !data ? (
            <p className="changes-panel__empty">Loading…</p>
          ) : !workspace ? (
            <p className="changes-panel__empty">Open a chat in a project to see its changes.</p>
          ) : data && !data.isRepo ? (
            <div className="changes-panel__empty changes-panel__init">
              <p>
                This workspace isn’t a git repository, so its changes can’t be tracked or
                reviewed here.
              </p>
              <button
                type="button"
                className="btn btn--sm btn--accent"
                onClick={() => void initRepo(load)}
                disabled={initializing}
                title="Run git init in this workspace so its files show up as reviewable changes"
              >
                {initializing ? 'Initializing…' : 'Initialize git repository'}
              </button>
              {initError && <p className="changes-panel__init-error">{initError}</p>}
            </div>
          ) : files.length === 0 ? (
            <p className="changes-panel__empty">No uncommitted changes.</p>
          ) : (
            <>
              {files.map((f) => (
                <FileSection key={`${f.status}:${f.path}`} file={f} defaultOpen={defaultOpen} />
              ))}
              {data?.truncated && (
                <p className="changes-panel__empty">Some untracked files were omitted.</p>
              )}
            </>
          )}
        </div>

        {onShip && shipAction && data?.isRepo && files.length > 0 && (
          <footer className="changes-panel__foot">
            <span className="changes-panel__foot-hint">{shipAction.hint}</span>
            <button
              type="button"
              className="btn btn--sm btn--accent"
              onClick={() => onShip(shipAction)}
              disabled={creating}
              title={creating ? 'Wait for the current run to finish' : shipAction.title}
            >
              {shipAction.label}
            </button>
          </footer>
        )}
      </aside>
    </div>
  )
}

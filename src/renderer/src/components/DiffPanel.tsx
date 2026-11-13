import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiffHunk, FileDiff, WorkingTreeChanges } from '@shared/workingTree'
import {
  canRevertHunks,
  fileDiffSignature,
  hunkStart,
  type ChangesScope,
  type ChatChanges
} from '@shared/changes'
import { chooseShipAction, type ShipAction } from '@shared/shipAction'
import { useInitGitRepo } from '../hooks/useInitGitRepo'
import { DiffView, type DiffLayout } from './DiffView'
import { Icon } from './Icon'
import { CommitForm } from './CommitForm'

/** Below this many files the list starts fully expanded; above it, collapsed. */
const AUTO_EXPAND_LIMIT = 8

const SCOPE_LABEL: Record<ChangesScope, string> = {
  turn: 'This turn',
  chat: 'This chat',
  tree: 'Working tree'
}

const STORE_SCOPE = 'houston.changes.scope'
const STORE_LAYOUT = 'houston.changes.layout'

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

/** What a revert would do, in words, for the confirmation. */
export function revertQuestion(file: FileDiff, scope: ChangesScope, hunk?: number): string {
  if (hunk !== undefined) return `Undo this change in ${file.path}?`
  if (scope === 'tree') {
    if (file.status === 'untracked' || file.status === 'added') return `Delete ${file.path}? It is not committed.`
    return `Discard all uncommitted changes to ${file.path}?`
  }
  if (file.status === 'added') return `Delete ${file.path}? The chat created it.`
  return `Put ${file.path} back as it was before ${scope === 'turn' ? 'this turn' : 'this chat'}?`
}

/** An inline "are you sure" for a revert, with Cancel focused so Enter doesn't discard. */
function ConfirmBar({
  question,
  busy,
  onConfirm,
  onCancel
}: {
  question: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  return (
    <div className="changes-confirm" role="alertdialog" aria-label="Confirm revert">
      <span className="changes-confirm__text">{question} This can't be undone here.</span>
      <button type="button" className="btn btn--sm btn--danger" onClick={onConfirm} disabled={busy}>
        {busy ? 'Reverting…' : 'Revert'}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        ref={cancelRef}
        onClick={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        Cancel
      </button>
    </div>
  )
}

function FileSection({
  file,
  scope,
  defaultOpen,
  layout,
  canRevert,
  onRevert,
  onOpen
}: {
  file: FileDiff
  scope: ChangesScope
  defaultOpen: boolean
  layout: DiffLayout
  /** Reverts are offered (not while the chat's run is going). */
  canRevert: boolean
  onRevert: (file: FileDiff, hunk?: number) => Promise<void>
  onOpen?: (file: FileDiff) => void
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  // Which revert is waiting for confirmation: the whole file (-1) or a hunk index.
  const [confirm, setConfirm] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const hunkReverts = canRevert && canRevertHunks(file)
  const run = async (hunk?: number): Promise<void> => {
    setBusy(true)
    try {
      await onRevert(file, hunk)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const confirmBar = (hunk?: number): JSX.Element => (
    <ConfirmBar
      question={revertQuestion(file, scope, hunk)}
      busy={busy}
      onConfirm={() => void run(hunk)}
      onCancel={() => setConfirm(null)}
    />
  )
  return (
    <div className="changes-file">
      <div className="changes-file__row">
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
        {onOpen && file.status !== 'deleted' && (
          <button
            type="button"
            className="changes-file__action"
            title="Open in its default app"
            aria-label={`Open ${file.path}`}
            onClick={() => onOpen(file)}
          >
            <Icon name="external" />
          </button>
        )}
        {canRevert && (
          <button
            type="button"
            className="changes-file__action"
            title="Revert this file"
            aria-label={`Revert ${file.path}`}
            onClick={() => setConfirm(-1)}
          >
            <Icon name="rewind" />
          </button>
        )}
      </div>
      {confirm === -1 && confirmBar()}
      {open && (
        <div className="changes-file__body">
          {file.note ? (
            <p className="changes-file__note">{file.note}</p>
          ) : (
            file.hunks.map((h: DiffHunk, i) => (
              <div key={i} className="changes-hunk">
                <div className="changes-hunk__header">
                  <span className="changes-hunk__range">{h.header}</span>
                  {hunkReverts && (
                    <button
                      type="button"
                      className="changes-hunk__revert"
                      title="Undo just this change"
                      aria-label={`Revert change ${i + 1} in ${file.path}`}
                      onClick={() => setConfirm(i)}
                    >
                      Revert
                    </button>
                  )}
                </div>
                {confirm === i && confirmBar(i)}
                <DiffView diff={h.lines} path={file.path} start={hunkStart(h)} layout={layout} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Either scope's data, normalized for the list. */
type Loaded =
  | { scope: 'tree'; tree: WorkingTreeChanges }
  | { scope: 'turn' | 'chat'; chat: ChatChanges }

/**
 * The Changes view, a tab of the right-hand dock. Three scopes: what this chat's
 * latest turn changed and what the whole chat changed (from the file checkpoints
 * taken before each turn's writes), and every uncommitted change in the working
 * tree (from git). Files and single changes can be reverted after a confirmation;
 * the main process re-checks that the file still holds the diff shown before it
 * writes anything.
 *
 * `onShip`, when provided, renders a ship action that hands the work off to the
 * agent (commit, push, open PR through its own tools) rather than the renderer
 * driving git directly. The action follows the repo's state (see chooseShipAction).
 * `creating` disables it while a run is busy.
 */
export function DiffPanel({
  workspace,
  conversationId = null,
  running = false,
  onShip,
  creating = false,
  commitForm = false
}: {
  workspace: string | null
  /** The open chat, for the turn and chat scopes; null in a new chat. */
  conversationId?: string | null
  /** The chat's run is going: reverts wait, and the list refreshes when it ends. */
  running?: boolean
  onShip?: (action: ShipAction) => void
  creating?: boolean
  /**
   * Show the commit form (commit, push) above the ship action. It commits every
   * uncommitted change, so it shows on the working-tree scope only.
   */
  commitForm?: boolean
}): JSX.Element {
  const [storedScope, setStoredScope] = useState<ChangesScope>(() =>
    readPref(STORE_SCOPE, ['turn', 'chat', 'tree'] as const, 'tree')
  )
  const scope: ChangesScope = conversationId ? storedScope : 'tree'
  const [layout, setLayout] = useState<DiffLayout>(() => readPref(STORE_LAYOUT, ['unified', 'split'] as const, 'unified'))
  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { initializing, initError, initRepo } = useInitGitRepo(workspace)

  const load = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setData({ scope: 'tree', tree: { isRepo: false, branch: null, files: [], added: 0, removed: 0 } })
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (scope === 'tree') setData({ scope, tree: await window.api.getWorkingTreeChanges(workspace) })
      else if (conversationId) setData({ scope, chat: await window.api.getChatChanges(conversationId, scope) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [workspace, scope, conversationId])

  useEffect(() => {
    void load()
  }, [load])

  // A finished turn changes what every scope shows.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) void load()
    wasRunning.current = running
  }, [running, load])

  const pickScope = (s: ChangesScope): void => {
    setStoredScope(s)
    writePref(STORE_SCOPE, s)
    setNotice(null)
  }
  const pickLayout = (l: DiffLayout): void => {
    setLayout(l)
    writePref(STORE_LAYOUT, l)
  }

  const onRevert = useCallback(
    async (file: FileDiff, hunk?: number): Promise<void> => {
      if (!workspace) return
      setNotice(null)
      const res = await window.api.revertChange({
        scope,
        workspace,
        ...(conversationId ? { conversationId } : {}),
        path: file.path,
        signature: fileDiffSignature(file),
        ...(hunk !== undefined ? { hunk } : {})
      })
      if (!res.ok) setNotice(res.error)
      await load()
    },
    [scope, workspace, conversationId, load]
  )

  const onOpen = useCallback(
    (file: FileDiff) => {
      if (!workspace) return
      void window.api.openWorkspacePath(workspace, file.path).then((r) => {
        if (!r.ok) setNotice(r.error ?? 'Could not open that file.')
      })
    },
    [workspace]
  )

  const tree = data?.scope === 'tree' ? data.tree : null
  const chat = data && data.scope !== 'tree' ? data.chat : null
  const files = (data?.scope === scope ? (tree?.files ?? chat?.files) : null) ?? []
  const totals = tree ?? chat
  const shipAction = tree?.isRepo ? chooseShipAction(tree.ship) : null
  const defaultOpen = files.length <= AUTO_EXPAND_LIMIT
  const scopeText =
    scope === 'tree'
      ? `All uncommitted changes in the working tree${tree?.branch ? ` on ${tree.branch}` : ''}, not limited to this chat.`
      : scope === 'turn'
        ? "What this chat's latest turn changed, compared with the files before it."
        : 'What this chat changed across all its turns, compared with the files before it.'
  const empty =
    scope === 'tree' ? 'No uncommitted changes.' : scope === 'turn' ? 'The latest turn changed no files.' : 'This chat has changed no files.'

  return (
    <section className="changes-view" aria-label="Changes">
      <header className="changes-panel__head changes-view__head">
        <div className="changes-panel__titles">
          <div className="changes-view__scopes" role="radiogroup" aria-label="Show changes from">
            {(['turn', 'chat', 'tree'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                className={`changes-view__scope${scope === s ? ' changes-view__scope--on' : ''}`}
                disabled={s !== 'tree' && !conversationId}
                title={s !== 'tree' && !conversationId ? 'Start the chat first' : undefined}
                onClick={() => pickScope(s)}
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
          <p className="changes-panel__scope">{scopeText}</p>
        </div>
        {totals && (totals.added > 0 || totals.removed > 0) && (
          <span className="diff-stat changes-panel__total">
            <span className="diff-stat__add">+{totals.added}</span>
            <span className="diff-stat__del">−{totals.removed}</span>
          </span>
        )}
        <button
          type="button"
          className="btn btn--sm"
          aria-pressed={layout === 'split'}
          title={layout === 'split' ? 'Show diffs in one column' : 'Show old and new side by side'}
          onClick={() => pickLayout(layout === 'split' ? 'unified' : 'split')}
        >
          Side by side
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
        >
          <Icon name="refresh" />
        </button>
      </header>

      {notice && (
        <p className="changes-view__notice" role="status">
          {notice}
        </p>
      )}

      <div className="changes-panel__body">
        {error ? (
          <p className="changes-panel__empty">Couldn’t read changes: {error}</p>
        ) : loading && !data ? (
          <p className="changes-panel__empty">Loading…</p>
        ) : !workspace ? (
          <p className="changes-panel__empty">Open a chat in a project to see its changes.</p>
        ) : tree && !tree.isRepo ? (
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
          <p className="changes-panel__empty">{data ? empty : 'Loading…'}</p>
        ) : (
          <>
            {files.map((f) => (
              <FileSection
                key={`${scope}:${f.status}:${f.path}`}
                file={f}
                scope={scope}
                defaultOpen={defaultOpen}
                layout={layout}
                canRevert={!running && !f.binary}
                onRevert={onRevert}
                onOpen={onOpen}
              />
            ))}
            {tree?.truncated && <p className="changes-panel__empty">Some untracked files were omitted.</p>}
          </>
        )}
        {chat && chat.unavailable > 0 && (
          <p className="changes-panel__empty">
            Older turns’ snapshots were cleared, so changes from {chat.unavailable} turn
            {chat.unavailable === 1 ? '' : 's'} are not shown.
          </p>
        )}
      </div>

      {commitForm && workspace && scope === 'tree' && tree?.isRepo && (
        <CommitForm
          workspace={workspace}
          conversationId={conversationId}
          hasChanges={files.length > 0}
          busy={creating}
          onChanged={() => void load()}
        />
      )}

      {onShip && shipAction && tree?.isRepo && files.length > 0 && (
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
    </section>
  )
}

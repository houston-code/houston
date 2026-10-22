import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/files'
import { Icon } from './Icon'
import { FilePreview } from './FilePreview'
import { baseName } from '../lib/paths'
import { useFocusTrap } from '../lib/useFocusTrap'

/** Debounce before a filter query hits the fuzzy file search (keeps typing smooth). */
const FILTER_DEBOUNCE_MS = 160

/** Indentation (px) added per tree depth, plus the row's base left padding. */
const INDENT_PX = 14
const BASE_PAD_PX = 10

interface TreeRowProps {
  entry: FileEntry
  depth: number
  expanded: Set<string>
  selected: string | null
  childrenByDir: Record<string, FileEntry[]>
  onToggle: (entry: FileEntry) => void
  onSelect: (entry: FileEntry) => void
}

/**
 * One row in the tree. A folder toggles open/closed (and its children render as
 * indented sibling rows once loaded); a file selects itself for preview. The
 * children list is owned by the panel and looked up by path, so expansion state
 * survives re-renders and folders only fetch their contents once.
 */
function TreeRow({
  entry,
  depth,
  expanded,
  selected,
  childrenByDir,
  onToggle,
  onSelect
}: TreeRowProps): JSX.Element {
  const isOpen = entry.isDirectory && expanded.has(entry.path)
  const kids = childrenByDir[entry.path]
  const pad = BASE_PAD_PX + depth * INDENT_PX
  const isSelected = !entry.isDirectory && entry.path === selected
  return (
    <>
      <div
        className="files-row"
        role="treeitem"
        aria-expanded={entry.isDirectory ? isOpen : undefined}
        aria-selected={entry.isDirectory ? undefined : isSelected}
        style={{ paddingLeft: pad }}
      >
        <button
          type="button"
          className={`files-row__btn${isSelected ? ' files-row__btn--selected' : ''}`}
          onClick={() => (entry.isDirectory ? onToggle(entry) : onSelect(entry))}
          title={entry.path}
        >
          <span className="files-row__chevron">
            {entry.isDirectory ? (isOpen ? '▾' : '▸') : ''}
          </span>
          <Icon name={entry.isDirectory ? 'folder' : 'file'} className="files-row__icon" />
          <span className="files-row__name">{entry.name}</span>
        </button>
      </div>
      {isOpen &&
        kids &&
        (kids.length > 0 ? (
          kids.map((c) => (
            <TreeRow
              key={c.path}
              entry={c}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              childrenByDir={childrenByDir}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        ) : (
          <div className="files-row files-row--empty" style={{ paddingLeft: pad + INDENT_PX }}>
            empty
          </div>
        ))}
    </>
  )
}

/**
 * A slide-over panel that browses the workspace's files like Finder: a lazily
 * expanded folder tree (each level fetched on first open, so huge repos stay
 * snappy) on the left, an in-app preview of the selected file on the right, and a
 * filter box that switches to a flat fuzzy search.
 */
/** A path as the tree keys it: forward slashes, no leading "./" or "/". */
export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function FilesPanel({
  workspace,
  onClose,
  initialPath
}: {
  workspace: string | null
  onClose: () => void
  /** A workspace-relative file to reveal on open: its folders expanded, the file selected and previewed. */
  initialPath?: string
}): JSX.Element {
  // Children keyed by directory path ('' is the workspace root). Presence of a key
  // means "loaded" — undefined is still-loading, [] is a genuinely empty folder.
  const [childrenByDir, setChildrenByDir] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loadingRoot, setLoadingRoot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Filter mode: a non-empty query shows flat fuzzy-search results instead of the tree.
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  // A modal drawer: focus starts in the filter field (type to find a file), Tab stays
  // inside, Esc closes, and focus returns to whatever opened it.
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, onClose)

  const reload = useCallback(async () => {
    if (!workspace) {
      setChildrenByDir({})
      return
    }
    setError(null)
    setLoadingRoot(true)
    try {
      const kids = await window.api.listWorkspaceDir(workspace, '')
      const loaded: Record<string, FileEntry[]> = { '': kids }
      const open = new Set<string>()
      // Reveal a requested file: load and expand each folder above it, then select it.
      const target = initialPath ? normalizeRelPath(initialPath) : ''
      if (target) {
        const parts = target.split('/')
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/')
          try {
            loaded[dir] = await window.api.listWorkspaceDir(workspace, dir)
            open.add(dir)
          } catch {
            break
          }
        }
        setSelected(target)
      }
      setChildrenByDir(loaded)
      setExpanded(open)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingRoot(false)
    }
  }, [workspace, initialPath])

  useEffect(() => {
    void reload()
  }, [reload])

  // Fetch a folder's children once, on first expand.
  const loadDir = useCallback(
    async (relPath: string) => {
      if (!workspace) return
      try {
        const kids = await window.api.listWorkspaceDir(workspace, relPath)
        setChildrenByDir((prev) => ({ ...prev, [relPath]: kids }))
      } catch {
        // A single folder failing to list shouldn't blow away the whole tree.
        setChildrenByDir((prev) => ({ ...prev, [relPath]: [] }))
      }
    },
    [workspace]
  )

  const onToggle = useCallback(
    (entry: FileEntry) => {
      const willOpen = !expanded.has(entry.path)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      // Side effect outside the updater so StrictMode's double-invoke can't double-fetch.
      if (willOpen && !(entry.path in childrenByDir)) void loadDir(entry.path)
    },
    [expanded, childrenByDir, loadDir]
  )

  const onSelect = useCallback((entry: FileEntry) => setSelected(entry.path), [])

  const onOpen = useCallback(
    (path: string) => {
      if (workspace) void window.api.openWorkspacePath(workspace, path)
    },
    [workspace]
  )

  // Debounced fuzzy search while filtering; an empty box drops back to the tree.
  useEffect(() => {
    const q = filter.trim()
    if (!q || !workspace) {
      setResults(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.listWorkspaceFiles(workspace, q).then((files) => {
        if (!cancelled) setResults(files)
      })
    }, FILTER_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [filter, workspace])

  const root = childrenByDir['']

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        className="drawer files-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Files"
        tabIndex={-1}
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title">Files</h2>
            <p className="changes-panel__scope">
              {workspace
                ? `Every file in ${baseName(workspace)}. Click a folder to expand it, or a file to preview it.`
                : 'Files in this project.'}
            </p>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void reload()}
            disabled={loadingRoot || !workspace}
            title="Refresh"
            aria-label="Refresh"
          >
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="files-panel__split">
          <div className="files-panel__tree">
            {workspace && (
              <div className="files-panel__filter">
                <Icon name="filter" className="files-panel__filter-icon" />
                <input
                  type="text"
                  className="files-panel__filter-input"
                  placeholder="Filter files…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filter files"
                  data-autofocus
                />
                {filter && (
                  <button
                    type="button"
                    className="files-panel__filter-clear"
                    onClick={() => setFilter('')}
                    aria-label="Clear filter"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            <div className="files-panel__tree-body" role="tree" aria-label="Project files">
              {error ? (
                <p className="changes-panel__empty">Couldn’t read files: {error}</p>
              ) : !workspace ? (
                <p className="changes-panel__empty">Open a chat in a project to browse its files.</p>
              ) : results ? (
                results.length === 0 ? (
                  <p className="changes-panel__empty">No files match “{filter.trim()}”.</p>
                ) : (
                  results.map((p) => (
                    <div
                      key={p}
                      className="files-row"
                      role="treeitem"
                      aria-selected={p === selected}
                    >
                      <button
                        type="button"
                        className={`files-row__btn${p === selected ? ' files-row__btn--selected' : ''}`}
                        onClick={() => setSelected(p)}
                        title={p}
                      >
                        <span className="files-row__chevron" />
                        <Icon name="file" className="files-row__icon" />
                        <span className="files-row__name files-row__name--path">{p}</span>
                      </button>
                    </div>
                  ))
                )
              ) : !root ? (
                <p className="changes-panel__empty">Loading…</p>
              ) : root.length === 0 ? (
                <p className="changes-panel__empty">This folder is empty.</p>
              ) : (
                root.map((e) => (
                  <TreeRow
                    key={e.path}
                    entry={e}
                    depth={0}
                    expanded={expanded}
                    selected={selected}
                    childrenByDir={childrenByDir}
                    onToggle={onToggle}
                    onSelect={onSelect}
                  />
                ))
              )}
            </div>
          </div>

          <div className="files-panel__preview">
            <FilePreview workspace={workspace ?? ''} path={selected} onOpen={onOpen} />
          </div>
        </div>
      </aside>
    </div>
  )
}

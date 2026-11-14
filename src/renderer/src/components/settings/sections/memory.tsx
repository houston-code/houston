import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscapeWithin } from '../../../lib/useFocusTrap'
import {
  MAX_MEMORY_BODY,
  MAX_MEMORY_DESCRIPTION,
  MAX_MEMORY_NAME,
  MEMORY_TYPES,
  type MemoryOverview,
  type MemoryRecord,
  type MemoryRequest,
  type MemoryResponse,
  type MemoryType
} from '@shared/memoryTypes'
import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** What each memory type means, in the words the page shows. */
const TYPE_LABELS: Record<MemoryType, string> = {
  feedback: 'Feedback',
  user: 'About you',
  project: 'Project',
  reference: 'Reference'
}

/** The on/off switch for memory, and the way to the folder it lives in. */
export function MemorySettingsSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings, setFormError } = ctx
  const reveal = async (): Promise<void> => {
    try {
      await window.api.revealMemoryFolder()
    } catch {
      setFormError("Couldn't open the memory folder.")
    }
  }
  return (
    <SettingsSection
      title="Memory"
      desc={
        <>
          Facts the agent keeps between conversations: your preferences and corrections, and
          things about a project the code doesn&apos;t show. They live on this computer in{' '}
          <code>~/.houston/memory</code>, never in the project.
        </>
      }
    >
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={settings.memoryEnabled !== false}
          onChange={(e) => {
            const on = e.target.checked
            setSettings((s) => ({ ...s, memoryEnabled: on }))
          }}
        />
        <span>
          Use memories. The agent sees a one-line list of what it saved, reads the ones it needs,
          and saves new ones as it learns. Once a chat has read web, GitHub, or MCP content, every
          save asks you first. Turning this off keeps what was saved.
        </span>
      </label>
      <button className="btn btn--sm" onClick={() => void reveal()}>
        Open memory folder
      </button>
    </SettingsSection>
  )
}

type Draft = Pick<MemoryRecord, 'type' | 'name' | 'description' | 'body'>

const draftOf = (m: MemoryRecord): Draft => ({ type: m.type, name: m.name, description: m.description, body: m.body })

/** The saved memories: read, edit, pin, delete (with undo), and other repositories' folders. */
export function MemoriesSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const workspace = ctx.workspace ?? ''
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  // `conflict`: the memory changed on disk while it was being edited.
  const [editing, setEditing] = useState<{ memory: MemoryRecord; draft: Draft; conflict?: boolean } | null>(null)
  const [deleted, setDeleted] = useState<MemoryRecord | null>(null)
  const [confirmRepo, setConfirmRepo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = useCallback(async (req: MemoryRequest): Promise<MemoryResponse | null> => {
    setBusy(true)
    try {
      const res = await window.api.memoryRequest(req)
      setOverview(res.overview)
      setStatus(res.ok ? (res.note ? { text: res.note } : null) : { text: res.error, error: true })
      return res
    } catch {
      setStatus({ text: "Couldn't reach the memory folder. Try again.", error: true })
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void send({ op: 'list', workspace })
  }, [send, workspace])

  const remove = async (m: MemoryRecord): Promise<void> => {
    const res = await send({ op: 'remove', workspace, scope: m.scope, id: m.id })
    if (res?.ok) setDeleted(m)
  }
  const undo = async (): Promise<void> => {
    if (!deleted) return
    const res = await send({ op: 'restore', workspace, scope: deleted.scope, id: deleted.id })
    if (res?.ok) setDeleted(null)
  }
  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const { memory, draft } = editing
    const res = await send({
      op: 'update',
      workspace,
      scope: memory.scope,
      id: memory.id,
      ...draft,
      expectedUpdated: memory.updated
    })
    if (!res) return
    if (res.ok) {
      setEditing(null)
      return
    }
    // Refused because the memory changed on disk since the editor opened (the agent
    // saved it meanwhile): take the new version, so saving again replaces it with
    // this draft rather than failing the same way forever.
    const fresh = [...res.overview.repoMemories, ...res.overview.globalMemories].find(
      (m) => m.scope === memory.scope && m.id === memory.id
    )
    if (fresh && fresh.updated !== memory.updated) {
      setEditing({ memory: fresh, draft, conflict: true })
      setStatus({
        text: 'This memory changed while you were editing it. Save again to replace it with your edit, or use the saved version.',
        error: true
      })
    }
  }

  const renderList = (memories: MemoryRecord[], empty: string): JSX.Element =>
    memories.length === 0 ? (
      <p className="settings-empty">{empty}</p>
    ) : (
      <ul className="memory-list">
        {memories.map((m) =>
          editing?.memory.id === m.id ? (
            <li key={m.id} className="memory-item memory-item--editing">
              <MemoryEditor
                draft={editing.draft}
                onChange={(draft) => setEditing({ ...editing, draft })}
                onSave={() => void saveEdit()}
                onCancel={() => {
                  setEditing(null)
                  if (editing.conflict) setStatus(null)
                }}
                onUseSaved={
                  editing.conflict
                    ? () => {
                        setEditing({ memory: m, draft: draftOf(m) })
                        setStatus(null)
                      }
                    : undefined
                }
                busy={busy}
              />
            </li>
          ) : (
            <li key={m.id} className="memory-item">
              <div className="memory-item__head">
                <span className="pill">{TYPE_LABELS[m.type]}</span>
                <code className="memory-item__name">{m.name}</code>
                {m.pinned && <span className="pill pill--accent">Pinned</span>}
                <span className="settings-dim memory-item__date">
                  {new Date(m.updated).toLocaleDateString()}
                </span>
                <span className="memory-item__actions">
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => setEditing({ memory: m, draft: draftOf(m) })}
                    aria-label={`Edit memory ${m.name}`}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void send({ op: 'pin', workspace, scope: m.scope, id: m.id, pinned: !m.pinned })}
                    aria-label={`${m.pinned ? 'Unpin' : 'Pin'} memory ${m.name}`}
                  >
                    {m.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    className="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => void remove(m)}
                    aria-label={`Delete memory ${m.name}`}
                  >
                    Delete
                  </button>
                </span>
              </div>
              <details className="memory-item__details">
                <summary>{m.description}</summary>
                <p className="memory-item__body">{m.body}</p>
              </details>
            </li>
          )
        )}
      </ul>
    )

  return (
    <SettingsSection
      title="Saved memories"
      desc="Pinned memories stay at the top of the list the agent sees. Deleted ones can be restored for 30 days."
    >
      {status && (
        <p className={status.error ? 'memory-status memory-status--error' : 'memory-status'} role="status">
          {status.text}
        </p>
      )}
      {deleted && (
        <p className="memory-status" role="status">
          Deleted <code>{deleted.name}</code>.{' '}
          <button className="link" disabled={busy} onClick={() => void undo()}>
            Undo
          </button>
        </p>
      )}
      {overview === null ? (
        <p className="settings-empty">Loading…</p>
      ) : (
        <>
          <h4 className="memory-group">
            {overview.repo ? `This repository (${overview.repo.label})` : 'This repository'}
          </h4>
          {overview.repo
            ? renderList(overview.repoMemories, 'Nothing saved for this repository yet.')
            : <p className="settings-empty">Open a project to see its memories.</p>}
          <h4 className="memory-group">All projects</h4>
          {renderList(overview.globalMemories, 'Nothing saved for every project yet.')}
          {overview.otherRepos.length > 0 && (
            <>
              <h4 className="memory-group">Other repositories</h4>
              <p className="settings-dim">
                Memories of repositories that aren&apos;t open. A repository that moved or was
                cloned again shows here under its old location; move its memories into the open one.
              </p>
              <ul className="memory-list">
                {overview.otherRepos.map((r) => (
                  <li key={r.key} className="memory-item">
                    <div className="memory-item__head">
                      <code className="memory-item__name">{r.label}</code>
                      <span className="settings-dim memory-item__root" title={r.root}>
                        {r.root}
                      </span>
                      <span className="settings-dim">
                        {r.count} {r.count === 1 ? 'memory' : 'memories'}
                      </span>
                      <span className="memory-item__actions">
                        {overview.repo && (
                          <button
                            className="btn btn--sm"
                            disabled={busy}
                            onClick={() => void send({ op: 'adoptRepo', workspace, key: r.key })}
                          >
                            Move here
                          </button>
                        )}
                        {confirmRepo === r.key ? (
                          <>
                            <button
                              className="btn btn--sm btn--danger"
                              disabled={busy}
                              onClick={() => {
                                setConfirmRepo(null)
                                void send({ op: 'removeRepo', workspace, key: r.key })
                              }}
                            >
                              Delete {r.count}
                            </button>
                            <button className="btn btn--sm" onClick={() => setConfirmRepo(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn--sm btn--danger"
                            disabled={busy}
                            onClick={() => setConfirmRepo(r.key)}
                            aria-label={`Delete the memories of ${r.label}`}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </SettingsSection>
  )
}

function MemoryEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  onUseSaved,
  busy
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
  /** Offered after an edit conflict: drop the draft for the version now on disk. */
  onUseSaved?: () => void
  busy: boolean
}): JSX.Element {
  // Escape cancels this edit rather than closing Settings.
  const formRef = useRef<HTMLFormElement>(null)
  useEscapeWithin(formRef, onCancel)
  return (
    <form
      ref={formRef}
      className="memory-editor"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <label className="field">
        <span>Type</span>
        <select value={draft.type} onChange={(e) => onChange({ ...draft, type: e.target.value as MemoryType })}>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          maxLength={MAX_MEMORY_NAME}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Description</span>
        <input
          value={draft.description}
          maxLength={MAX_MEMORY_DESCRIPTION}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Memory</span>
        <textarea
          className="full-textarea"
          rows={5}
          value={draft.body}
          maxLength={MAX_MEMORY_BODY}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </label>
      <div className="memory-editor__actions">
        <button type="submit" className="btn btn--sm btn--accent" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
        {onUseSaved && (
          <button type="button" className="btn btn--sm" onClick={onUseSaved}>
            Use the saved version
          </button>
        )}
      </div>
    </form>
  )
}

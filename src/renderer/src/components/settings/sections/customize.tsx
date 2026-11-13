import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isCustomName,
  type CustomItem,
  type CustomKind,
  type CustomScope,
  type CustomizeOverview,
  type InstructionFile
} from '@shared/customize'
import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

const KINDS: Array<{ kind: CustomKind; title: string; noun: string; hint: string }> = [
  {
    kind: 'skill',
    title: 'Skills',
    noun: 'skill',
    hint: 'Instructions the agent loads when a task matches, from .houston/skills/<name>/SKILL.md.'
  },
  {
    kind: 'command',
    title: 'Custom commands',
    noun: 'command',
    hint: 'Your own slash commands, from .houston/commands/<name>.md.'
  },
  {
    kind: 'agent',
    title: 'Custom agents',
    noun: 'agent',
    hint: 'Specialized helpers the agent can hand work to, from .houston/agents/<name>.md.'
  }
]

const SCOPE_LABEL: Record<CustomScope, string> = { project: 'This project', user: 'All projects' }

/** The overview for this project, reloaded on demand. */
function useOverview(workspace: string | null): {
  overview: CustomizeOverview | null
  reload: () => Promise<void>
  error: string | null
} {
  const [overview, setOverview] = useState<CustomizeOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async (): Promise<void> => {
    try {
      setOverview(await window.api.customizeList(workspace))
      setError(null)
    } catch (e) {
      setOverview({ items: [], instructions: [] })
      setError(`Couldn't read them: ${(e as Error).message}`)
    }
  }, [workspace])
  useEffect(() => {
    void reload()
  }, [reload])
  return { overview, reload, error }
}

function ItemRow({
  item,
  workspace,
  onChanged,
  onError
}: {
  item: CustomItem
  workspace: string | null
  onChanged: () => Promise<void>
  onError: (msg: string | null) => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // Shown at once on a click; the reload that follows confirms it (or puts it back).
  const [on, setOn] = useState(item.enabled)
  useEffect(() => setOn(item.enabled), [item.enabled])
  const confirmRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, reload = true): Promise<void> => {
    setBusy(true)
    onError(null)
    try {
      const res = await fn()
      if (!res.ok) onError(res.error ?? 'Something went wrong.')
      if (reload) await onChanged()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const label = item.kind === 'command' ? `/${item.name}` : item.name
  return (
    <li className={`custom-item${on ? '' : ' custom-item--off'}`}>
      <div className="custom-item__head">
        <label className="custom-item__toggle" title={on ? 'On' : 'Off'}>
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            aria-label={`${label} (${SCOPE_LABEL[item.scope]}) on`}
            onChange={(e) => {
              const enabled = e.target.checked
              setOn(enabled)
              void act(() => window.api.customizeSetEnabled(workspace, item.id, enabled))
            }}
          />
        </label>
        <span className="custom-item__name">{label}</span>
        <span className="pill">{SCOPE_LABEL[item.scope]}</span>
        {!on && <span className="settings-dim">Off</span>}
        <span className="custom-item__actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            aria-label={`Open ${label} (${SCOPE_LABEL[item.scope]})`}
            onClick={() => void act(() => window.api.customizeOpen(workspace, item.id), false)}
          >
            Open
          </button>
          {!confirming && (
            <button
              ref={deleteRef}
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy}
              aria-label={`Delete ${label} (${SCOPE_LABEL[item.scope]})`}
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          )}
        </span>
      </div>
      <span className="custom-item__desc">{item.description}</span>
      <code className="custom-item__file">{item.file}</code>
      {item.shadowed && (
        <span className="custom-item__note">This project has one with the same name, which is used instead.</span>
      )}
      {confirming && (
        <div className="custom-item__confirm" role="group" aria-label={`Delete ${label}`}>
          <span>
            Move {item.kind === 'skill' ? 'this skill folder' : 'this file'} to the trash?
          </span>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            onClick={() => void act(() => window.api.customizeDelete(workspace, item.id))}
          >
            Move to trash
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              requestAnimationFrame(() => deleteRef.current?.focus())
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

function CreateForm({
  kind,
  noun,
  workspace,
  onCreated,
  onError
}: {
  kind: CustomKind
  noun: string
  workspace: string | null
  onCreated: () => Promise<void>
  onError: (msg: string | null) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<CustomScope>(workspace ? 'project' : 'user')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!workspace) setScope('user')
  }, [workspace])
  const valid = isCustomName(name.trim())
  const create = async (): Promise<void> => {
    if (!valid) return
    setBusy(true)
    onError(null)
    try {
      const res = await window.api.customizeCreate(workspace, kind, scope, name.trim())
      if (!res.ok) onError(res.error ?? 'Something went wrong.')
      else setName('')
      await onCreated()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="custom-create"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <input
        className="custom-create__name"
        value={name}
        placeholder={`new ${noun} name`}
        aria-label={`New ${noun} name`}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={name.trim() !== '' && !valid}
      />
      <select aria-label={`Where the new ${noun} goes`} value={scope} onChange={(e) => setScope(e.target.value as CustomScope)}>
        <option value="project" disabled={!workspace}>
          This project
        </option>
        <option value="user">All projects</option>
      </select>
      <button type="submit" className="btn btn--sm" disabled={busy || !valid}>
        Create {noun}
      </button>
      {name.trim() !== '' && !valid && (
        <span className="field__hint">Use letters, digits, - or _.</span>
      )}
    </form>
  )
}

/**
 * Settings > Customize: the project's and the user's skills, custom commands and
 * custom agents, each switchable, openable and deletable (to the trash), with a
 * create-from-template form per kind.
 */
export function CustomizeSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { workspace } = ctx
  const { overview, reload, error: loadError } = useOverview(workspace)
  const [error, setError] = useState<string | null>(null)
  return (
    <SettingsSection
      title="Skills, commands and agents"
      desc={
        <>
          From this project&apos;s <code>.houston/</code> folder and your own <code>~/.houston/</code>{' '}
          (available in every project). When both have one with the same name, the project&apos;s is
          used. Switching one off keeps its file and adds <code>disabled: true</code> to it; Delete
          moves it to the trash.
        </>
      }
    >
      {overview === null ? (
        <p className="settings-empty" role="status">
          Loading…
        </p>
      ) : (
        KINDS.map(({ kind, title, noun, hint }) => {
          const items = overview.items.filter((i) => i.kind === kind)
          return (
            <div key={kind} className="custom-group">
              <h4 className="custom-group__title">{title}</h4>
              <p className="field__hint">{hint}</p>
              {items.length === 0 ? (
                <p className="settings-empty">None yet.</p>
              ) : (
                <ul className="custom-list">
                  {items.map((item) => (
                    <ItemRow key={item.id} item={item} workspace={workspace} onChanged={reload} onError={setError} />
                  ))}
                </ul>
              )}
              <CreateForm kind={kind} noun={noun} workspace={workspace} onCreated={reload} onError={setError} />
            </div>
          )
        })
      )}
      {(error ?? loadError) && (
        <p className="custom-error" role="alert">
          {error ?? loadError}
        </p>
      )}
    </SettingsSection>
  )
}

const SCOPE_NAMES: Record<InstructionFile['scope'], string> = {
  global: 'Every project',
  project: 'Project root',
  nested: 'Subfolder'
}

/** The instruction files Houston loads into each run for this project, in load order. */
export function InstructionFilesSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { workspace } = ctx
  const { overview, error: loadError } = useOverview(workspace)
  const [error, setError] = useState<string | null>(null)
  const files = overview?.instructions ?? null
  return (
    <SettingsSection
      title="Instruction files"
      desc={
        <>
          The rules files Houston reads at the start of each run{workspace ? ' in this project' : ''}, in
          the order they load: later, more specific files win where they disagree.
        </>
      }
    >
      {files === null ? (
        <p className="settings-empty" role="status">
          Loading…
        </p>
      ) : files.length === 0 ? (
        <p className="settings-empty">
          None are loaded. Add rules to <code>~/.houston/AGENTS.md</code>
          {workspace ? <> or this project&apos;s <code>AGENTS.md</code></> : null}.
        </p>
      ) : (
        <ul className="custom-list">
          {files.map((f) => (
            <li key={f.label} className="custom-item">
              <div className="custom-item__head">
                <code className="custom-item__name">{f.label}</code>
                <span className="pill">{SCOPE_NAMES[f.scope]}</span>
                {f.truncated && <span className="pill pill--warn">Shortened to fit</span>}
                <span className="custom-item__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    aria-label={`Open ${f.label}`}
                    onClick={() => {
                      setError(null)
                      void window.api
                        .customizeOpenInstruction(workspace, f.label)
                        .then((r) => {
                          if (!r.ok) setError(r.error ?? "Couldn't open it.")
                        })
                        .catch((e: Error) => setError(e.message))
                    }}
                  >
                    Open
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(error ?? loadError) && (
        <p className="custom-error" role="alert">
          {error ?? loadError}
        </p>
      )}
    </SettingsSection>
  )
}

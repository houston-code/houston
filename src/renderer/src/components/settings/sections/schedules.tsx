import { useCallback, useEffect, useRef, useState } from 'react'
import { APPROVAL_POLICIES, APPROVAL_POLICY_LABEL, type ApprovalPolicy, type ProviderConfig } from '@shared/types'
import {
  scheduleLastRunFailed,
  scheduleLastRunText,
  type SchedulePreview,
  type ScheduleView
} from '@shared/schedules'
import { SettingsSection } from '../fields'
import type { SettingsCtx } from '../context'

/** "Tue, Nov 17, 9:30 AM" in the user's locale. */
export function formatRunTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** How often the list re-reads while a scheduled run is in flight. */
export const RUNNING_POLL_MS = 5000

/** The last path segment, for a compact folder label. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Providers a run can use now: a key stored (or none needed) and at least one model. */
export function usableModels(providers: ProviderConfig[]): Array<{ providerId: string; model: string; label: string }> {
  return providers
    .filter((p) => (!p.requiresKey || p.hasKey) && p.models.length > 0)
    .flatMap((p) => p.models.map((m) => ({ providerId: p.id, model: m.id, label: `${p.label}: ${m.label ?? m.id}` })))
}

function ScheduleRow({
  s,
  onChanged,
  onError
}: {
  s: ScheduleView
  onChanged: () => Promise<void>
  onError: (msg: string | null) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [started, setStarted] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true)
    onError(null)
    try {
      const res = await fn()
      if (!res.ok) onError(res.error ?? 'Something went wrong.')
      await onChanged()
      return res.ok
    } catch (e) {
      onError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const lastRun = scheduleLastRunText(s)
  const next = s.paused ? 'Paused' : s.nextRunAt === null ? 'No more runs' : `Next run ${formatRunTime(s.nextRunAt)}`
  return (
    <li className={`sched-item${s.paused ? ' sched-item--paused' : ''}`}>
      <div className="sched-item__head">
        <span className="sched-item__name">{s.name}</span>
        <span className="pill">{s.spec}</span>
        <span className="sched-item__next">{next}</span>
      </div>
      <span className="sched-item__meta" title={s.workspace}>
        In <code>{folderName(s.workspace)}</code> with {s.model}, {APPROVAL_POLICY_LABEL[s.approvalPolicy] ?? s.approvalPolicy}
      </span>
      <span className="sched-item__prompt">{s.prompt}</span>
      {s.lastFiredAt !== undefined && (
        <span className={`sched-item__last${scheduleLastRunFailed(s) ? ' sched-item__last--err' : ''}`}>
          Last run {formatRunTime(s.lastFiredAt)}
          {lastRun ? `: ${lastRun}` : ''}
        </span>
      )}
      {started && (
        <span className="sched-item__last" role="status">
          Started. It is in the sidebar as a background chat.
        </span>
      )}
      <div className="sched-item__actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          aria-label={`${s.paused ? 'Resume' : 'Pause'} ${s.name}`}
          onClick={() => void act(() => window.api.setSchedulePaused(s.id, !s.paused))}
        >
          {s.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          aria-label={`Run ${s.name} now`}
          onClick={() =>
            void act(() => window.api.runScheduleNow(s.id)).then((ok) => {
              setStarted(ok)
            })
          }
        >
          Run now
        </button>
        {!confirming ? (
          <button
            ref={deleteRef}
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            aria-label={`Delete ${s.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        ) : (
          <span className="sched-item__confirm" role="group" aria-label={`Delete ${s.name}`}>
            Delete this scheduled run?
            <button
              ref={confirmRef}
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy}
              onClick={() => void act(() => window.api.deleteSchedule(s.id))}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setConfirming(false)
                requestAnimationFrame(() => deleteRef.current?.focus())
              }}
            >
              Cancel
            </button>
          </span>
        )}
      </div>
    </li>
  )
}

function CreateForm({
  ctx,
  onCreated,
  onCancel
}: {
  ctx: SettingsCtx
  onCreated: () => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const models = usableModels(ctx.settings.providers)
  const selected = ctx.settings.selected
  const initialModel =
    selected && models.some((m) => m.providerId === selected.providerId && m.model === selected.model)
      ? `${selected.providerId}\u0000${selected.model}`
      : models[0]
        ? `${models[0].providerId}\u0000${models[0].model}`
        : ''
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState(ctx.workspace ?? '')
  const [spec, setSpec] = useState('')
  const [model, setModel] = useState(initialModel)
  const [policy, setPolicy] = useState<ApprovalPolicy>('plan')
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => firstRef.current?.focus(), [])

  // What the typed schedule means, checked by main's parser as it is typed.
  useEffect(() => {
    if (!spec.trim()) {
      setPreview(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      void window.api
        .previewSchedule(spec)
        .then((p) => {
          if (live) setPreview(p)
        })
        .catch(() => {})
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [spec])

  const submit = async (): Promise<void> => {
    const [providerId, modelId] = model.split('\u0000')
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.createSchedule({
        name,
        spec,
        prompt,
        workspace: folder,
        providerId: providerId ?? '',
        model: modelId ?? '',
        approvalPolicy: policy
      })
      if (!res.ok) setError(res.error)
      else await onCreated()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="sched-form"
      aria-label="New scheduled run"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="sched-form__field">
        <span>Task each run starts with</span>
        <textarea ref={firstRef} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className="sched-form__field">
        <span>Name (optional)</span>
        <input value={name} placeholder="the task's first line" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="sched-form__field">
        <span>When</span>
        <input
          value={spec}
          placeholder="every 2h, daily at 09:00, weekdays at 09:30, weekly on monday at 10:00, once at 2026-12-01 09:00"
          onChange={(e) => setSpec(e.target.value)}
          aria-describedby="sched-spec-preview"
        />
      </label>
      <p
        id="sched-spec-preview"
        className={`field__hint${preview && !preview.ok ? ' sched-form__bad' : ''}`}
        role="status"
      >
        {preview === null
          ? 'Times are local. Runs happen only while Houston is open; one missed while it was closed runs once when it opens.'
          : preview.ok
            ? preview.nextRunAt === null
              ? `${preview.spec}: no run left.`
              : `${preview.spec}. First run ${formatRunTime(preview.nextRunAt)}.`
            : preview.error}
      </p>
      <div className="sched-form__row">
        <label className="sched-form__field sched-form__grow">
          <span>Folder</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            void window.api.pickDirectory().then((dir) => {
              if (dir) setFolder(dir)
            })
          }
        >
          Choose…
        </button>
      </div>
      <div className="sched-form__row">
        <label className="sched-form__field sched-form__grow">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 && <option value="">Connect a model first</option>}
            {models.map((m) => (
              <option key={`${m.providerId}\u0000${m.model}`} value={`${m.providerId}\u0000${m.model}`}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sched-form__field sched-form__grow">
          <span>Approval mode</span>
          <select value={policy} onChange={(e) => setPolicy(e.target.value as ApprovalPolicy)}>
            {APPROVAL_POLICIES.map((p) => (
              <option key={p} value={p}>
                {APPROVAL_POLICY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field__hint">
        A run that needs your approval waits in its chat until you answer. Full auto runs without asking.
      </p>
      {error && (
        <p className="sched-form__bad" role="alert">
          {error}
        </p>
      )}
      <div className="sched-item__actions">
        <button type="submit" className="btn btn--sm btn--accent" disabled={busy || !prompt.trim() || !spec.trim() || !model}>
          Create
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Settings > Scheduled runs: the scheduler service's runs, each with pause/resume,
 * run now and delete, plus a form to create one. The agent's schedule tools manage
 * the same list.
 */
export function ScheduledRunsSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const [list, setList] = useState<ScheduleView[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  const reload = useCallback(async (): Promise<void> => {
    try {
      setList(await window.api.listSchedules())
    } catch (e) {
      setList([])
      setError(`Couldn't read the scheduled runs: ${(e as Error).message}`)
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  // While a run is in flight, check back so its outcome shows without reopening the page.
  const anyRunning = list?.some((s) => s.lastResult === 'running') ?? false
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => void reload(), RUNNING_POLL_MS)
    return () => clearInterval(t)
  }, [anyRunning, reload])

  return (
    <SettingsSection
      title="Scheduled runs"
      desc={
        <>
          Tasks that start a new background chat on a schedule, in the folder, model and approval
          mode you choose. You can also ask the agent to schedule one. They run only while Houston is
          open.
        </>
      }
    >
      {list === null ? (
        <p className="settings-empty" role="status">
          Loading…
        </p>
      ) : list.length === 0 ? (
        <p className="settings-empty">No scheduled runs yet.</p>
      ) : (
        <ul className="sched-list">
          {list.map((s) => (
            <ScheduleRow key={s.id} s={s} onChanged={reload} onError={setError} />
          ))}
        </ul>
      )}
      {creating ? (
        <CreateForm
          ctx={ctx}
          onCancel={() => {
            setCreating(false)
            requestAnimationFrame(() => newRef.current?.focus())
          }}
          onCreated={async () => {
            setCreating(false)
            await reload()
          }}
        />
      ) : (
        <button ref={newRef} type="button" className="btn btn--sm" onClick={() => setCreating(true)}>
          New scheduled run
        </button>
      )}
      {error && (
        <p className="sched-form__bad" role="alert">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}

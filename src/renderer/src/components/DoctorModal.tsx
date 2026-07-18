import { useEffect, useState } from 'react'
import { buildDoctorReport, type DoctorCheck, type DoctorFacts } from '@shared/doctor'

/**
 * `/doctor` for the desktop app: the "why isn't this working" health view.
 *
 * The facts — the sandbox backend, whether a key is really being used or shadowed
 * by an env var, which MCP server failed to connect, which binaries are on PATH —
 * were all knowable, but only scattered across Settings or not surfaced at all.
 * The main process gathers them; `buildDoctorReport` (shared with the terminal's
 * `/doctor`) grades them; this renders the grouped result.
 */

const MARK: Record<DoctorCheck['status'], string> = { ok: '✓', warn: '!', fail: '✗' }

function verdict(checks: DoctorCheck[]): { text: string; tone: string } {
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  if (fails) {
    return {
      text: `${fails} problem${fails === 1 ? '' : 's'} found${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`,
      tone: 'fail'
    }
  }
  if (warns) return { text: `No problems; ${warns} thing${warns === 1 ? '' : 's'} worth knowing.`, tone: 'warn' }
  return { text: 'Everything looks healthy.', tone: 'ok' }
}

export function DoctorModal({
  workspace,
  onClose
}: {
  workspace: string | null
  onClose: () => void
}): JSX.Element {
  const [facts, setFacts] = useState<DoctorFacts | null>(null)

  useEffect(() => {
    let live = true
    void window.api.getDoctorFacts(workspace ?? '').then((f) => {
      if (live) setFacts(f)
    })
    return () => {
      live = false
    }
  }, [workspace])

  // Esc is handled by App's global key handler (which knows this modal is open and
  // suppresses cycle-mode / run-cancel while it is), the same as the Scorecard and
  // Files panels. A private document-level Esc listener here fired first and let
  // App's handler fall through to `chat.cancel()`, silently killing a running turn.

  const report = facts ? buildDoctorReport(facts) : null
  const all = report?.groups.flatMap((g) => g.checks) ?? []
  const v = verdict(all)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--doctor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doctor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="doctor-title">Doctor</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close doctor">
            ✕
          </button>
        </div>

        <div className="modal__main doctor">
          {!report ? (
            <p className="doctor__loading">Checking your setup…</p>
          ) : (
            <>
              {report.groups
                .filter((g) => g.checks.length)
                .map((g) => (
                  <section key={g.title} className="doctor__group">
                    <h3 className="doctor__group-title">{g.title}</h3>
                    {g.checks.map((c) => (
                      <div key={c.label} className={`doctor__row doctor__row--${c.status}`}>
                        <span className={`doctor__mark doctor__mark--${c.status}`} aria-hidden="true">
                          {MARK[c.status]}
                        </span>
                        <span className="doctor__label">{c.label}</span>
                        <span className="doctor__detail">{c.detail}</span>
                        {c.fix && c.status !== 'ok' && (
                          <span className="doctor__fix">→ {c.fix}</span>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
              <p className={`doctor__verdict doctor__verdict--${v.tone}`}>{v.text}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

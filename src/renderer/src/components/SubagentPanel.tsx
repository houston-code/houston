import { useEffect, useMemo, useRef, useState } from 'react'
import { diffStat } from '@shared/diff'
import { formatTokens, formatUsd } from '@shared/usage'
import {
  formatDuration,
  modelSourceLabel,
  recordDiffStat,
  recordToMarkdown,
  splitSubagentReport,
  statusLabel,
  subagentTree,
  toolStepCount,
  type SubagentNode,
  type SubagentRecord,
  type SubagentStep
} from '@shared/subagents'
import { deniedPromptText, stoppedPromptText } from '@shared/promptOutcome'
import { copyText } from '../lib/clipboard'
import { useFocusTrap } from '../lib/useFocusTrap'
import { DiffView } from './DiffView'
import { Markdown } from './Markdown'

/**
 * A step's result as shown: a call the user denied, or the run was stopped in front of,
 * says so in the user's terms rather than in the loop's instructions to the subagent.
 */
function stepOutput(s: SubagentStep): string | undefined {
  return stoppedPromptText(s.output) ?? deniedPromptText(s.output) ?? s.output
}

/**
 * How a subagent's work shows on its tool row: header chips (model, steps, time,
 * cost, resume id), the live step list while it runs, and once it finishes a tabbed
 * body (Report, Steps, Prompt & setup) plus a full transcript drawer.
 *
 * Every string comes from the agent or its tools (redacted in the main process). Model
 * prose renders through Markdown, which escapes HTML; everything else is plain text.
 */

/** Steps shown while an agent runs before "Show all" (the newest ones). */
const LIVE_STEPS = 12

/** Re-render every second while `active`, for live elapsed times. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return active ? now : 0
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function elapsed(r: SubagentRecord, now: number): string {
  const end = r.endedAt ?? (now || Date.now())
  return formatDuration(Math.max(0, end - r.startedAt))
}

function usageText(r: SubagentRecord): string | null {
  if (!r.usage) return null
  if (r.usage.costUsd && r.usage.costUsd > 0) return `≈${formatUsd(r.usage.costUsd)}`
  return `${formatTokens(r.usage.input + r.usage.output)} tokens`
}

/** The root agent of a dispatch row (the one the main agent dispatched). */
export function rootRecord(records: readonly SubagentRecord[] | undefined): SubagentRecord | undefined {
  return records?.find((r) => !r.parentId)
}

/** Header chips for a dispatch row: model, steps, time, diff, cost, resume id, warnings. */
export function SubagentChips({ records }: { records: SubagentRecord[] }): JSX.Element | null {
  const root = rootRecord(records)
  const running = root?.status === 'running'
  const now = useTick(running)
  if (!root) return null
  const steps = toolStepCount(root)
  const stat = recordDiffStat(root)
  const cost = usageText(root)
  const stopped = root.status === 'step-limit' || root.status === 'stalled'
  return (
    <span className="sa-chips">
      <span className="sa-chip sa-chip--model" title={`Model: ${root.model}`}>
        {root.agentName ? `${root.agentName} · ${root.model}` : root.model}
      </span>
      {stopped ? (
        <span className="sa-chip sa-chip--warn" title={statusLabel(root)}>
          {root.budget ? `${root.budget.used} of ${root.budget.limit} steps` : statusLabel(root)}
        </span>
      ) : (
        <span className="sa-chip">{running ? `step ${Math.max(1, steps)}` : plural(steps, 'step')}</span>
      )}
      <span className="sa-chip">{elapsed(root, now)}</span>
      {(stat.added > 0 || stat.removed > 0) && (
        <span className="sa-chip">
          +{stat.added} −{stat.removed}
        </span>
      )}
      {cost && <span className="sa-chip">{cost}</span>}
      {root.resumeId && (
        <span className="sa-chip sa-chip--id" title={`The main agent can resume ${root.resumeId} in this app session`}>
          {root.resumeId}
        </span>
      )}
    </span>
  )
}

type Tab = 'report' | 'steps' | 'setup'

/**
 * The body of a dispatch row. While the agent runs: its live steps. Once it finished:
 * Report / Steps / Prompt & setup tabs. `output` is the tool result (the report as the
 * main agent saw it, used when an old chat has no saved record).
 */
export function SubagentBody({
  records,
  output,
  running
}: {
  records: SubagentRecord[] | undefined
  output: string | undefined
  running: boolean
}): JSX.Element {
  const tree = useMemo(() => subagentTree(records ?? []), [records])
  const root = tree[0]
  const [tab, setTab] = useState<Tab>('report')
  const [showSetup, setShowSetup] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  const { report: fromOutput, resumeId } = splitSubagentReport(output ?? '')
  const report = (root?.record.report !== undefined ? splitSubagentReport(root.record.report).report : fromOutput).trim()

  if (!root) {
    // A chat saved before records existed: just the report, rendered.
    return (
      <div className="sa-body">
        {report ? <Markdown text={report} /> : <p className="sa-muted">No report.</p>}
        {resumeId && (
          <p className="sa-foot">
            <span>Resumable as {resumeId} for the rest of this app session</span>
          </p>
        )}
      </div>
    )
  }

  const openTranscript = (): void => setTranscript(root.record.id)
  const footer = (
    <div className="sa-foot">
      {root.record.resumeId && (
        <span>
          Resumable as <b>{root.record.resumeId}</b> for the rest of this app session
        </span>
      )}
      {root.record.kind === 'writable' && root.record.status !== 'running' && (
        <span>Its changes are part of this turn&apos;s Revert</span>
      )}
      {report && !running && (
        <button type="button" className="sa-link" onClick={() => void copyText(report)}>
          Copy report
        </button>
      )}
      <button type="button" className="sa-link" onClick={openTranscript}>
        Open transcript
      </button>
    </div>
  )

  if (running) {
    return (
      <div className="sa-body">
        <StepList node={root} live onOpen={setTranscript} />
        {showSetup && <SetupView record={root.record} />}
        <div className="sa-foot">
          <button type="button" className="sa-link" aria-expanded={showSetup} onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? 'Hide prompt & setup' : 'Prompt & setup'}
          </button>
          <button type="button" className="sa-link" onClick={openTranscript}>
            Open transcript
          </button>
        </div>
        {transcript && <SubagentTranscript records={records ?? []} selectedId={transcript} onClose={() => setTranscript(null)} />}
      </div>
    )
  }

  const steps = toolStepCount(root.record)
  return (
    <div className="sa-body">
      <SubagentTabs tab={tab} onTab={setTab} steps={steps} />
      <div role="tabpanel" id={`sa-panel-${root.record.id}-${tab}`}>
        {tab === 'report' &&
          (report ? (
            <div className="sa-report">
              <Markdown text={report} />
            </div>
          ) : (
            <p className="sa-muted">The agent ended without a report ({statusLabel(root.record)}).</p>
          ))}
        {tab === 'steps' && <StepList node={root} onOpen={setTranscript} />}
        {tab === 'setup' && <SetupView record={root.record} />}
      </div>
      {(root.record.status === 'step-limit' || root.record.status === 'stalled') && (
        <div className="sa-callout">
          {root.record.status === 'stalled'
            ? 'Stopped after repeating the same step. The report above is what it had.'
            : root.record.budget?.hardCap
              ? `Stopped at this agent's step limit (max_turns: ${root.record.budget.hardCap} in its agent file). It used its last step to report what it found so far.`
              : 'Stopped at its step limit. It used its last step to report what it found so far.'}
        </div>
      )}
      {footer}
      {transcript && <SubagentTranscript records={records ?? []} selectedId={transcript} onClose={() => setTranscript(null)} />}
    </div>
  )
}

function SubagentTabs({ tab, onTab, steps }: { tab: Tab; onTab: (t: Tab) => void; steps: number }): JSX.Element {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'report', label: 'Report' },
    { id: 'steps', label: 'Steps' },
    { id: 'setup', label: 'Prompt & setup' }
  ]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  // Arrow keys move between tabs (roving tabindex), as in any tab list.
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + tabs.length) % tabs.length
    onTab(tabs[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div className="sa-tabs" role="tablist" aria-label="Subagent">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          className={`sa-tab${tab === t.id ? ' sa-tab--on' : ''}`}
          onClick={() => onTab(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.id === 'steps' && <span className="sa-tab__n">{steps}</span>}
        </button>
      ))}
    </div>
  )
}

/** A step list, with nested agents shown inline under the step that dispatched them. */
function StepList({
  node,
  live = false,
  onOpen
}: {
  node: SubagentNode
  live?: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const [all, setAll] = useState(false)
  const steps = node.record.steps
  const hidden = live && !all ? Math.max(0, steps.length - LIVE_STEPS) : 0
  const shown = hidden ? steps.slice(hidden) : steps
  const childById = new Map(node.children.map((c) => [c.record.id, c]))
  const linked = new Set(steps.map((s) => s.childId).filter(Boolean))
  // A nested agent whose dispatching step isn't known still shows, after the list.
  const loose = node.children.filter((c) => !linked.has(c.record.id))
  return (
    <>
      {hidden > 0 && (
        <button type="button" className="sa-link sa-more" onClick={() => setAll(true)}>
          Show all {steps.length} steps
        </button>
      )}
      {node.record.stepsOmitted ? (
        <p className="sa-muted">{node.record.stepsOmitted} earlier steps were not kept.</p>
      ) : null}
      <ul className="sa-steps">
        {shown.map((s, i) => {
          const prev = i > 0 ? shown[i - 1] : hidden ? steps[hidden - 1] : undefined
          const child = s.childId ? childById.get(s.childId) : undefined
          return (
            <StepRow key={s.index} step={s} firstOfTurn={!prev || prev.turn !== s.turn} live={live}>
              {child && <NestedAgent node={child} live={live} onOpen={onOpen} />}
            </StepRow>
          )
        })}
      </ul>
      {loose.map((c) => (
        <NestedAgent key={c.record.id} node={c} live={live} onOpen={onOpen} />
      ))}
      {steps.length === 0 && <p className="sa-muted">{live ? 'Starting…' : 'No steps recorded.'}</p>}
    </>
  )
}

function StepRow({
  step: s,
  firstOfTurn,
  live,
  children
}: {
  step: SubagentStep
  firstOfTurn: boolean
  live: boolean
  children?: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = !live && Boolean(s.output || s.preview?.length)
  const glyph =
    s.kind === 'notice' ? '↗' : s.kind === 'text' ? '' : s.ok === undefined ? '◌' : s.ok ? '✓' : '✗'
  const glyphCls =
    s.kind === 'notice'
      ? ' sa-step__g--note'
      : s.ok === undefined
        ? ' sa-step__g--run'
        : s.ok === false
          ? ' sa-step__g--fail'
          : ''
  const toggle = (): void => {
    if (expandable) setOpen((v) => !v)
  }
  return (
    <li className={`sa-step-item${s.kind === 'text' ? ' sa-step-item--text' : ''}${s.kind === 'notice' ? ' sa-step-item--note' : ''}`}>
      <div
        className={`sa-step${expandable ? ' sa-step--clickable' : ''}`}
        {...(expandable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: toggle,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle()
                }
              }
            }
          : {})}
      >
        <span className="sa-step__chev" aria-hidden="true">
          {expandable ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="sa-step__n">{firstOfTurn ? s.turn : ''}</span>
        <span className={`sa-step__g${glyphCls}`} aria-hidden="true">
          {glyph}
        </span>
        <span className="sa-step__t" title={s.summary}>
          {s.summary}
        </span>
        {s.hint && <span className="sa-step__r">{s.hint}</span>}
      </div>
      {open && s.preview && s.preview.length > 0 && (
        <div className="sa-diff">
          {s.preview.map((p, i) => (
            <div key={`${p.path}:${i}`}>
              {s.preview!.length > 1 && <div className="sa-diff__path">{p.path}</div>}
              <DiffView diff={p.diff} />
            </div>
          ))}
        </div>
      )}
      {open && !s.preview?.length && s.output && (
        <pre className="sa-out">
          {stepOutput(s)}
          {s.outputTruncated ? '\n…' : ''}
        </pre>
      )}
      {children}
    </li>
  )
}

function NestedAgent({
  node,
  live,
  onOpen
}: {
  node: SubagentNode
  live: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  const r = node.record
  const running = r.status === 'running'
  const now = useTick(running)
  return (
    <div className="sa-nested">
      <div className="sa-nested__head">
        <span className={`sa-step__g${running ? ' sa-step__g--run' : r.status === 'done' ? '' : ' sa-step__g--fail'}`} aria-hidden="true">
          {running ? '◌' : r.status === 'done' ? '✓' : '✗'}
        </span>
        <b>{r.label}</b>
        <span className="sa-chip sa-chip--model">{r.model}</span>
        <span className="sa-chip">{running ? `step ${Math.max(1, toolStepCount(r))}` : plural(toolStepCount(r), 'step')}</span>
        <span className="sa-chip">{elapsed(r, now)}</span>
        {!live && (
          <button type="button" className="sa-link" onClick={() => onOpen(r.id)}>
            Open
          </button>
        )}
      </div>
      <StepList node={node} live={live} onOpen={onOpen} />
    </div>
  )
}

function budgetText(r: SubagentRecord): string {
  const b = r.budget
  if (!b) return r.status === 'running' ? 'Running' : 'Not recorded'
  if (b.hardCap) return `${b.used} used of ${b.hardCap} (max_turns in its agent file, never extends)`
  if (b.ceiling > b.limit) return `${b.used} used of ${b.limit}, extends while productive (up to ${b.ceiling})`
  return `${b.used} used of ${b.limit}`
}

function SetupView({ record: r }: { record: SubagentRecord }): JSX.Element {
  const agent = r.agentName
    ? `${r.agentName} (from .houston/agents)`
    : r.kind === 'writable'
      ? 'Default writable agent (can edit files and run commands in the sandbox)'
      : r.kind === 'reviewer'
        ? 'Review agent (read-only)'
        : 'Default research agent (read-only)'
  const pct = r.budget ? Math.min(100, Math.round((r.budget.used / Math.max(1, r.budget.hardCap ?? r.budget.ceiling)) * 100)) : 0
  return (
    <div className="sa-setup">
      <div className="sa-label">{r.resumed ? 'Follow-up from the main agent' : 'Task from the main agent'}</div>
      <div className="sa-prompt">
        <Markdown text={r.prompt} />
      </div>
      <div className="sa-label">Setup</div>
      <dl className="sa-kv">
        <dt>Agent</dt>
        <dd>{agent}</dd>
        <dt>Model</dt>
        <dd>
          <code>{r.model}</code>, {modelSourceLabel(r.modelSource)}
        </dd>
        <dt>Tools</dt>
        <dd>
          <span className="sa-tools">
            {r.tools.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </span>
        </dd>
        <dt>Step budget</dt>
        <dd>
          {budgetText(r)}
          {r.budget && (
            <span className="sa-bar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
        </dd>
        <dt>Usage</dt>
        <dd>
          {r.usage
            ? `${formatTokens(r.usage.input)} in · ${formatTokens(r.usage.output)} out${r.usage.cacheRead ? ` · ${formatTokens(r.usage.cacheRead)} cached` : ''}${r.usage.costUsd ? ` · ≈${formatUsd(r.usage.costUsd)}` : ''}`
            : 'Not reported yet'}
        </dd>
        <dt>Ran</dt>
        <dd>
          {elapsed(r, 0)} · {statusLabel(r)}
        </dd>
      </dl>
      {r.systemPrompt && (
        <details className="sa-sys">
          <summary>System prompt ({r.systemPrompt.length.toLocaleString()} characters)</summary>
          <pre>{r.systemPrompt}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * The full run of one agent (or, for a review, any of its agents), in order: the
 * system prompt, the task, each step with what the agent said and every tool call's
 * result, nested agents, and the report.
 */
export function SubagentTranscript({
  records,
  selectedId,
  onClose
}: {
  records: SubagentRecord[]
  selectedId: string
  onClose: () => void
}): JSX.Element {
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef, onClose)
  const [selected, setSelected] = useState(selectedId)
  const tree = useMemo(() => subagentTree(records), [records])
  const nodes = useMemo(() => {
    const all: SubagentNode[] = []
    const walk = (n: SubagentNode): void => {
      all.push(n)
      n.children.forEach(walk)
    }
    tree.forEach(walk)
    return all
  }, [tree])
  const node = nodes.find((n) => n.record.id === selected) ?? nodes[0]
  const [copied, setCopied] = useState(false)
  if (!node) return <></>
  const r = node.record
  const report = r.report !== undefined ? splitSubagentReport(r.report).report.trim() : ''
  const turns = new Map<number, SubagentStep[]>()
  for (const s of r.steps) turns.set(s.turn, [...(turns.get(s.turn) ?? []), s])
  const facts = [
    r.agentName ?? (r.kind === 'writable' ? 'Default writable agent' : r.kind === 'reviewer' ? 'Review agent' : 'Default research agent'),
    r.model,
    plural(toolStepCount(r), 'step'),
    elapsed(r, 0),
    usageText(r),
    'saved with this chat'
  ].filter(Boolean)
  const copy = async (): Promise<void> => {
    await copyText(recordToMarkdown(node))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        className="drawer sa-transcript"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Subagent transcript: ${r.label}`}
        tabIndex={-1}
      >
        <header className="changes-panel__head">
          <div className="changes-panel__titles">
            <h2 className="changes-panel__title">
              {r.resumeId ? `Subagent ${r.resumeId} · ` : ''}
              {r.label}
            </h2>
            <p className="changes-panel__scope">{facts.join(' · ')}</p>
          </div>
          <button type="button" className="btn btn--sm" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy as Markdown'}
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close transcript">
            ✕
          </button>
        </header>
        {nodes.length > 1 && (
          <nav className="sa-tr-nav" aria-label="Agents">
            {nodes.map((n) => (
              <button
                key={n.record.id}
                type="button"
                className={`sa-tr-nav__item${n.record.id === r.id ? ' sa-tr-nav__item--on' : ''}`}
                aria-current={n.record.id === r.id}
                onClick={() => setSelected(n.record.id)}
              >
                {n.record.parentId ? '↳ ' : ''}
                {n.record.label}
              </button>
            ))}
          </nav>
        )}
        <div className="changes-panel__body">
          <div className="tr">
            {r.systemPrompt && (
              <details className="sa-sys">
                <summary>System prompt</summary>
                <pre>{r.systemPrompt}</pre>
              </details>
            )}
            <div className="tr__turn">
              <div className="tr__who">{r.resumed ? 'Follow-up from the main agent' : 'Task from the main agent'}</div>
              <div className="sa-prompt">
                <Markdown text={r.prompt} />
              </div>
            </div>
            {r.stepsOmitted ? <p className="sa-muted">{r.stepsOmitted} steps from the middle of this run were not kept.</p> : null}
            {[...turns].map(([turn, steps]) => (
              <div className="tr__turn" key={turn}>
                <div className="tr__who">Step {turn}</div>
                {steps.map((s) => (
                  <TranscriptStep key={s.index} step={s} nodes={nodes} onOpen={setSelected} />
                ))}
              </div>
            ))}
            <div className="tr__turn">
              <div className="tr__who">Report</div>
              {report ? <Markdown text={report} /> : <p className="sa-muted">{statusLabel(r)}, no report.</p>}
            </div>
            {r.trimmed && (
              <p className="sa-muted">
                Step results and diffs for this agent were dropped to keep the chat within its subagent history
                limit (Settings, Loop control).
              </p>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function TranscriptStep({
  step: s,
  nodes,
  onOpen
}: {
  step: SubagentStep
  nodes: SubagentNode[]
  onOpen: (id: string) => void
}): JSX.Element {
  if (s.kind === 'text') {
    return (
      <div className="tr__text">
        <Markdown text={s.summary} />
      </div>
    )
  }
  if (s.kind === 'notice') return <p className="sa-step--note-line">↗ {s.summary}</p>
  const child = s.childId ? nodes.find((n) => n.record.id === s.childId) : undefined
  const stat = s.preview?.length ? s.preview.reduce((a, p) => {
    const st = diffStat(p.diff)
    return { added: a.added + st.added, removed: a.removed + st.removed }
  }, { added: 0, removed: 0 }) : null
  return (
    <details className="tr__call" open={Boolean(s.preview?.length)}>
      <summary className="tr__callhead">
        <span className={s.ok === false ? 'sa-step__g--fail' : s.ok === undefined ? 'sa-step__g--run' : 'sa-step__g'}>
          {s.ok === undefined ? '◌' : s.ok ? '✓' : '✗'}
        </span>
        <span className="tr__calltext">{s.summary}</span>
        <span className="tool-row__spacer" />
        {stat ? (
          <span className="diff-stat">
            <span className="diff-stat__add">+{stat.added}</span>
            <span className="diff-stat__del">−{stat.removed}</span>
          </span>
        ) : (
          s.hint && <span className="sa-step__r">{s.hint}</span>
        )}
        {child && (
          <button
            type="button"
            className="sa-link"
            onClick={(e) => {
              e.preventDefault()
              onOpen(child.record.id)
            }}
          >
            Open
          </button>
        )}
      </summary>
      {s.preview?.map((p, i) => (
        <div key={`${p.path}:${i}`} className="tr__res tr__res--diff">
          {s.preview!.length > 1 && <div className="sa-diff__path">{p.path}</div>}
          <DiffView diff={p.diff} />
        </div>
      ))}
      {!s.preview?.length && s.output && (
        <pre className="tr__res">
          {stepOutput(s)}
          {s.outputTruncated ? '\n…' : ''}
        </pre>
      )}
    </details>
  )
}

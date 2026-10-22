import type { AgentEvent, TokenUsage } from '@shared/agent'
import {
  capSteps,
  clipText,
  upsertStep,
  SUBAGENT_CAPS,
  type SubagentBudget,
  type SubagentKind,
  type SubagentModelSource,
  type SubagentRecord,
  type SubagentStatus,
  type SubagentStep
} from '@shared/subagents'

/** What the loop knows about an agent when it starts. */
export interface SubagentStart {
  kind: SubagentKind
  label: string
  agentName?: string
  model: string
  modelSource: SubagentModelSource
  prompt: string
  systemPrompt?: string
  tools: string[]
  parentId?: string
  /** The parent's step that dispatched this agent (nested agents). */
  parentStep?: number
  resumed?: boolean
}

/** The handle the loop drives one agent's record through. */
export interface SubagentHandle {
  id: string
  step(step: SubagentStep): void
  usage(u: TokenUsage): void
  end(e: { status: SubagentStatus; report?: string; budget?: SubagentBudget; resumeId?: string }): void
}

type WithoutRunId<T> = T extends unknown ? Omit<T, 'runId'> : never
/** The record events, as the loop's `emit` takes them (it adds the run id). */
export type RecorderEvent = WithoutRunId<
  Extract<AgentEvent, { type: 'subagent_start' | 'subagent_step' | 'subagent_end' }>
>
type EmitFn = (e: RecorderEvent) => void

/**
 * Builds the record of every subagent a run starts (see SubagentRecord), streams it to
 * the clients as it grows, and hands the finished records to the loop to save on the
 * dispatching call's tool result.
 *
 * Every string goes through `redact` and is clipped here, the one seam between an
 * agent's activity and anything the clients show or the chat file keeps.
 */
export class SubagentRecorder {
  private readonly records = new Map<string, SubagentRecord[]>()
  private seq = 0

  constructor(
    private readonly emit: EmitFn,
    private readonly redact: (text: string) => string,
    /** Prices a round of usage on the agent's model (undefined when unknown). */
    private readonly price: (model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number | undefined,
    private readonly now: () => number = Date.now
  ) {}

  /** Start a record under the tool call `parentCallId`. */
  start(parentCallId: string, s: SubagentStart): SubagentHandle {
    const id = `sa${++this.seq}`
    const record: SubagentRecord = {
      id,
      ...(s.parentId ? { parentId: s.parentId } : {}),
      kind: s.kind,
      label: clipText(this.redact(s.label), SUBAGENT_CAPS.stepSummary).text,
      ...(s.agentName ? { agentName: s.agentName } : {}),
      model: s.model,
      modelSource: s.modelSource,
      prompt: clipText(this.redact(s.prompt), SUBAGENT_CAPS.prompt).text,
      ...(s.systemPrompt ? { systemPrompt: clipText(this.redact(s.systemPrompt), SUBAGENT_CAPS.systemPrompt).text } : {}),
      tools: s.tools.slice(0, 64),
      ...(s.resumed ? { resumed: true } : {}),
      status: 'running',
      startedAt: this.now(),
      steps: []
    }
    const list = this.records.get(parentCallId) ?? []
    list.push(record)
    this.records.set(parentCallId, list)
    this.emit({ type: 'subagent_start', parentCallId, record: { ...record, steps: [] } })

    // Point the parent's dispatching step at this child.
    if (s.parentId !== undefined && s.parentStep !== undefined) {
      const parent = list.find((r) => r.id === s.parentId)
      const pStep = parent?.steps.find((st) => st.index === s.parentStep)
      if (parent && pStep) this.step(parentCallId, parent, { ...pStep, childId: id })
    }

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let ended = false
    return {
      id,
      step: (step) => {
        if (!ended) this.step(parentCallId, record, step)
      },
      usage: (u) => {
        usage.input += u.inputTokens ?? 0
        usage.output += u.outputTokens ?? 0
        usage.cacheRead += u.cacheReadTokens ?? 0
        usage.cacheWrite += u.cacheWriteTokens ?? 0
      },
      end: (e) => {
        if (ended) return
        ended = true
        const cost = usage.input || usage.output ? this.price(record.model, usage) : undefined
        const update: SubagentRecord = {
          ...record,
          status: e.status,
          endedAt: this.now(),
          ...(usage.input || usage.output
            ? {
                usage: {
                  input: usage.input,
                  output: usage.output,
                  ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
                  ...(usage.cacheWrite ? { cacheWrite: usage.cacheWrite } : {}),
                  ...(cost !== undefined ? { costUsd: cost } : {})
                }
              }
            : {}),
          ...(e.budget ? { budget: e.budget } : {}),
          ...(e.resumeId ? { resumeId: e.resumeId } : {}),
          ...(e.report !== undefined ? { report: clipText(this.redact(e.report), SUBAGENT_CAPS.report).text } : {})
        }
        Object.assign(record, update)
        this.emit({
          type: 'subagent_end',
          parentCallId,
          recordId: id,
          update: {
            status: record.status,
            endedAt: record.endedAt!,
            ...(record.usage ? { usage: record.usage } : {}),
            ...(record.budget ? { budget: record.budget } : {}),
            ...(record.report !== undefined ? { report: record.report } : {}),
            ...(record.resumeId ? { resumeId: record.resumeId } : {}),
            ...(record.stepsOmitted ? { stepsOmitted: record.stepsOmitted } : {})
          }
        })
      }
    }
  }

  private step(parentCallId: string, record: SubagentRecord, raw: SubagentStep): void {
    const step: SubagentStep = {
      ...raw,
      summary: clipText(
        this.redact(raw.summary),
        raw.kind === 'text' ? SUBAGENT_CAPS.stepOutput : SUBAGENT_CAPS.stepSummary
      ).text,
      ...(raw.output !== undefined ? { output: clipText(this.redact(raw.output), SUBAGENT_CAPS.stepOutput).text } : {}),
      // A write's diff shows file content, which can hold a credential being written.
      ...(raw.preview
        ? {
            preview: raw.preview.map((p) => ({
              ...p,
              path: this.redact(p.path),
              diff: p.diff.map((l) => ({ ...l, text: this.redact(l.text) }))
            }))
          }
        : {})
    }
    record.steps = upsertStep(record.steps, step)
    const capped = capSteps(record)
    if (capped !== record) {
      record.steps = capped.steps
      record.stepsOmitted = capped.stepsOmitted
    }
    this.emit({ type: 'subagent_step', parentCallId, recordId: record.id, step })
  }

  /** The records under `parentCallId`, removed from the recorder (they go on the tool result). */
  take(parentCallId: string): SubagentRecord[] | undefined {
    const list = this.records.get(parentCallId)
    this.records.delete(parentCallId)
    return list?.length ? list.map((r) => ({ ...r, steps: r.steps.slice() })) : undefined
  }
}

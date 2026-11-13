import { useSyncExternalStore } from 'react'
import { formatTokens, formatUsd } from '@shared/usage'
import type { MessageUsage } from '@shared/agent'

/**
 * What one turn (a user message and everything the agent did for it) cost: the
 * models that answered, in the order they first did, and the billed totals across
 * every model round of the turn.
 */
export interface TurnStats {
  models: string[]
  inputTokens: number
  outputTokens: number
  /** USD; 0 when no answering model's price is known. */
  cost: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Fold one model round into a turn's tally (a new object; the input is untouched). */
export function addRound(
  stats: TurnStats | undefined,
  model: string | undefined,
  usage: MessageUsage | undefined
): TurnStats {
  const prev = stats ?? { models: [], inputTokens: 0, outputTokens: 0, cost: 0 }
  return {
    models: model && !prev.models.includes(model) ? [...prev.models, model] : prev.models,
    inputTokens: prev.inputTokens + count(usage?.inputTokens),
    outputTokens: prev.outputTokens + count(usage?.outputTokens),
    cost: prev.cost + count(usage?.cost)
  }
}

/** A timestamp as epoch milliseconds, or undefined for a missing or unparseable one. */
export function parseAt(at: string | undefined): number | undefined {
  if (typeof at !== 'string' || !at) return undefined
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : undefined
}

/**
 * A short label for when a message was sent: "just now", "5m ago", "3h ago",
 * "yesterday", a weekday within the week, then a date.
 */
export function relativeTime(then: number, now: number): string {
  const s = Math.round((now - then) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = new Date(then)
  const today = new Date(now)
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (days <= 1) return 'yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {})
  })
}

/** The full date and time, for the hover title. */
export function fullTime(then: number): string {
  return new Date(then).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' })
}

/** The quiet details for a turn: the models, tokens, and the cost when it is known. */
export function turnStatsParts(stats: TurnStats): string[] {
  const parts: string[] = []
  if (stats.models.length) parts.push(stats.models.join(', '))
  if (stats.inputTokens || stats.outputTokens) {
    parts.push(`${formatTokens(stats.inputTokens)} in, ${formatTokens(stats.outputTokens)} out`)
  }
  if (stats.cost > 0) parts.push(formatUsd(stats.cost))
  return parts
}

// One shared clock for every relative timestamp, so a long transcript runs a single
// timer rather than one per message. It ticks only while something is listening.
const listeners = new Set<() => void>()
let clock = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const TICK_MS = 30_000

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!timer) {
    clock = Date.now()
    timer = setInterval(() => {
      clock = Date.now()
      for (const l of listeners) l()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** The current time, refreshed every 30 seconds while any component reads it. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => clock)
}

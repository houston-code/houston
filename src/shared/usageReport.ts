import type { ChatMessage, ConversationUsage } from './agent'

/**
 * The usage view: spend and tokens per day and per project, aggregated from the
 * user's own saved chats on this machine. Pure and dependency-free so the main
 * process (which reads the chat files) and the tests share it. Nothing here reads
 * message text: only each reply's timestamp and the usage it recorded.
 */

/** One chat, reduced to what the report reads. */
export interface UsageInput {
  /** The project the chat ran in: a worktree's repository root, else its folder. */
  project: string
  messages: readonly Pick<ChatMessage, 'role' | 'at' | 'usage'>[]
  /** Leading messages copied from another chat (a fork's history); not this chat's spend. */
  inherited?: number
  /** The chat's running totals, which also count subagents and reviews. */
  usage?: ConversationUsage
}

export interface UsageTotals {
  cost: number
  inputTokens: number
  outputTokens: number
}

export interface UsageDay extends UsageTotals {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  /** Model replies that day. */
  replies: number
}

export interface UsageProject extends UsageTotals {
  /** The project's folder path. */
  path: string
  /** Its folder name, for display. */
  name: string
  chats: number
}

export interface UsageReport {
  /** The last `days` local days, oldest first, including days with no use. */
  days: UsageDay[]
  /** Every project with any use, most expensive first (then most output). */
  projects: UsageProject[]
  /** Sums over `days`. */
  recent: UsageTotals
  /** Every chat's running totals added up. */
  allTime: UsageTotals & { chats: number }
  /**
   * The part of the all-time totals with no dated reply behind it: subagents and
   * reviews (billed to the chat, not to a reply) and chats saved before replies
   * recorded their usage. Counted in projects and all time, not in days.
   */
  undated: Pick<UsageTotals, 'cost' | 'outputTokens'>
}

/** Days the report covers by default. */
export const USAGE_REPORT_DAYS = 30

/** A local calendar date, YYYY-MM-DD. */
export function localDate(t: Date): string {
  const y = t.getFullYear()
  const m = String(t.getMonth() + 1).padStart(2, '0')
  const d = String(t.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** A folder's last path segment, on either separator. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A chat's all-time input tokens: the per-model sums, since its top-level input is only the latest context. */
function totalInput(u: ConversationUsage | undefined): number {
  return (u?.perModel ?? []).reduce((n, m) => n + num(m.inputTokens), 0)
}

export function buildUsageReport(inputs: readonly UsageInput[], now: Date, days = USAGE_REPORT_DAYS): UsageReport {
  // The window's dates, oldest first, stepped by calendar day (so a DST change can't skip one).
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dates.push(localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12)))
  }
  const byDate = new Map<string, UsageDay>(
    dates.map((date) => [date, { date, cost: 0, inputTokens: 0, outputTokens: 0, replies: 0 }])
  )
  const projects = new Map<string, UsageProject>()
  const allTime = { cost: 0, inputTokens: 0, outputTokens: 0, chats: 0 }
  const undated = { cost: 0, outputTokens: 0 }

  for (const chat of inputs) {
    const u = chat.usage
    const chatCost = num(u?.cost)
    const chatOut = num(u?.outputTokens)
    const chatIn = totalInput(u)
    let datedCost = 0
    let datedOut = 0
    const start = Math.max(0, chat.inherited ?? 0)
    for (let i = start; i < chat.messages.length; i++) {
      const m = chat.messages[i]
      if (m.role !== 'assistant' || !m.usage) continue
      const cost = num(m.usage.cost)
      const out = num(m.usage.outputTokens)
      datedCost += cost
      datedOut += out
      const at = m.at ? new Date(m.at) : null
      if (!at || Number.isNaN(at.getTime())) continue
      const day = byDate.get(localDate(at))
      if (!day) continue
      day.cost += cost
      day.inputTokens += num(m.usage.inputTokens)
      day.outputTokens += out
      day.replies += 1
    }
    // A chat with no running totals (never billed) still has its dated replies.
    const cost = Math.max(chatCost, datedCost)
    const out = Math.max(chatOut, datedOut)
    if (cost <= 0 && out <= 0 && chatIn <= 0) continue
    undated.cost += Math.max(0, cost - datedCost)
    undated.outputTokens += Math.max(0, out - datedOut)
    allTime.cost += cost
    allTime.inputTokens += chatIn
    allTime.outputTokens += out
    allTime.chats += 1
    const p = projects.get(chat.project) ?? {
      path: chat.project,
      name: folderName(chat.project),
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      chats: 0
    }
    p.cost += cost
    p.inputTokens += chatIn
    p.outputTokens += out
    p.chats += 1
    projects.set(chat.project, p)
  }

  const dayList = dates.map((d) => byDate.get(d) as UsageDay)
  const recent = dayList.reduce(
    (t, d) => ({ cost: t.cost + d.cost, inputTokens: t.inputTokens + d.inputTokens, outputTokens: t.outputTokens + d.outputTokens }),
    { cost: 0, inputTokens: 0, outputTokens: 0 }
  )
  return {
    days: dayList,
    projects: [...projects.values()].sort(
      (a, b) => b.cost - a.cost || b.outputTokens - a.outputTokens || a.name.localeCompare(b.name)
    ),
    recent,
    allTime,
    undated: { cost: undated.cost < 0.005 ? 0 : undated.cost, outputTokens: undated.outputTokens }
  }
}

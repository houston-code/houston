import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatMessage } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX } from '@shared/agent'
import type { PermissionRule } from '@shared/types'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * Session commands for the terminal: what a resumed chat shows of its past
 * (`renderRecap`), the `/export` formats, and the `/permissions` list. Pure, so what
 * each prints or writes is unit-testable; the driver owns the I/O.
 */

/** A user message the person wrote (not a tool result, a compaction summary or a system note). */
function isPersonTurn(m: ChatMessage): boolean {
  return (
    m.role === 'user' &&
    !m.content.startsWith(COMPACTION_SUMMARY_PREFIX) &&
    !m.content.startsWith(SYSTEM_NOTE_PREFIX)
  )
}

/** What the person did, as they would recognize it: the command they typed, or their words. */
function personText(m: ChatMessage): string {
  return m.invokedAs ? (m.invokedAs.typed ?? m.invokedAs.label) : m.content
}

/** The first `max` non-empty lines of `text`, each cut to `width`, with "…" when anything was left out. */
function clip(text: string, max: number, width: number): string[] {
  const lines = text
    .split('\n')
    .map((l) => stripControlChars(l).trimEnd())
    .filter((l) => l.trim())
  const out = lines.slice(0, max).map((l) => ([...l].length > width ? `${[...l].slice(0, width - 1).join('')}…` : l))
  if (lines.length > max && out.length) out[out.length - 1] = `${out[out.length - 1]} …`
  return out
}

/** How many of the last exchanges a resumed chat replays. */
export const RECAP_EXCHANGES = 3

/**
 * The last few exchanges of a chat, shown when it is resumed so you can see where you
 * left off: each message you sent (two lines at most) and the reply text that answered
 * it (four lines at most). Tool calls are left out; `/export` has everything. Empty for
 * a chat with nothing to show.
 */
export function renderRecap(
  messages: ChatMessage[],
  paint: Painter,
  opts: { exchanges?: number; width?: number } = {}
): string {
  const width = Math.max(20, (opts.width ?? 80) - 12)
  const starts = messages.map((m, i) => (isPersonTurn(m) ? i : -1)).filter((i) => i >= 0)
  const shown = starts.slice(-(opts.exchanges ?? RECAP_EXCHANGES))
  if (!shown.length) return ''
  const more = starts.length > shown.length ? ` (the last ${shown.length} of ${starts.length} messages)` : ''
  const lines: string[] = [paint(`· where you left off${more}:`, 'dim')]
  for (const start of shown) {
    const next = starts.find((i) => i > start) ?? messages.length
    clip(personText(messages[start]), 2, width).forEach((l, i) =>
      lines.push(`  ${i === 0 ? paint('you ›', 'green') : '     '} ${l}`)
    )
    // The reply is the last assistant text before the next message you sent.
    const reply = messages
      .slice(start + 1, next)
      .filter((m) => m.role === 'assistant' && m.content.trim())
      .at(-1)
    if (reply) {
      clip(reply.content, 4, width).forEach((l, i) =>
        lines.push(`  ${i === 0 ? paint('houston ›', 'cyan') : '         '} ${paint(l, 'dim')}`)
      )
    } else {
      lines.push(`  ${paint('houston ›', 'cyan')} ${paint('(no reply)', 'dim')}`)
    }
  }
  return lines.join('\n')
}

/** A code fence longer than any backtick run inside `text`, so the block can't end early. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

/** How many lines of a tool's output a Markdown export keeps. */
export const EXPORT_TOOL_LINES = 40

/** Facts about the chat an export is headed with. */
export interface ExportMeta {
  id: string | null
  title: string
  providerId: string | null
  model: string | null
  /** When the export was made. */
  at: Date
}

/**
 * The chat as Markdown, for reading or sharing: your messages and the replies in full,
 * each tool call as one line with its arguments, and each tool's output in a code block
 * cut to {@link EXPORT_TOOL_LINES} lines. Reasoning is left out.
 */
export function chatToMarkdown(messages: ChatMessage[], meta: ExportMeta): string {
  const out: string[] = [`# ${meta.title}`, '']
  const facts = [`Exported from Houston on ${meta.at.toISOString()}`]
  if (meta.providerId && meta.model) facts.push(`model ${meta.providerId} / ${meta.model}`)
  if (meta.id) facts.push(`session ${meta.id}`)
  out.push(`_${facts.join(', ')}._`, '')
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
        out.push('## Summary of earlier messages', '', m.content.slice(COMPACTION_SUMMARY_PREFIX.length).trim(), '')
        continue
      }
      if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
        out.push(`> ${m.content.replace(/\n/g, '\n> ')}`, '')
        continue
      }
      out.push('## You', '', m.invokedAs ? `\`${personText(m)}\`` : m.content, '')
      if (m.images?.length) out.push(`_(${m.images.length} image${m.images.length === 1 ? '' : 's'} attached)_`, '')
      continue
    }
    if (m.role === 'assistant') {
      if (m.content.trim()) out.push('## Houston', '', m.content, '')
      for (const call of m.toolCalls ?? []) {
        const args = JSON.stringify(call.arguments ?? {})
        const shown = args.length > 200 ? `${args.slice(0, 199)}…` : args
        const fence = '`'.repeat(Math.max(1, ...[...shown.matchAll(/`+/g)].map((x) => x[0].length + 1)))
        out.push(`- **${call.name}** ${fence}${shown}${fence}`)
      }
      if (m.toolCalls?.length) out.push('')
      continue
    }
    if (m.role === 'tool') {
      const lines = m.content.split('\n')
      const body = lines.slice(0, EXPORT_TOOL_LINES).join('\n')
      const fence = fenceFor(body)
      out.push(`${m.toolName ?? 'tool'} output:`, '', fence, body, fence)
      if (lines.length > EXPORT_TOOL_LINES) out.push(`_(${lines.length - EXPORT_TOOL_LINES} more lines)_`)
      out.push('')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** The chat as JSON: the facts above plus every message exactly as saved. */
export function chatToJson(messages: ChatMessage[], meta: ExportMeta): string {
  return `${JSON.stringify(
    {
      format: 'houston-chat',
      version: 1,
      id: meta.id,
      title: meta.title,
      providerId: meta.providerId,
      model: meta.model,
      exportedAt: meta.at.toISOString(),
      messages
    },
    null,
    2
  )}\n`
}

export type ExportFormat = 'md' | 'json'

/** `/export [md|json] [path]`: the format (from the word, else the path's extension) and the path. */
export function parseExportArgs(arg: string): { format: ExportFormat; path?: string } {
  let rest = arg.trim()
  let format: ExportFormat | undefined
  const first = /^(md|markdown|json)(?:\s+|$)/i.exec(rest)
  if (first) {
    format = first[1].toLowerCase() === 'json' ? 'json' : 'md'
    rest = rest.slice(first[0].length).trim()
  }
  if (!format) format = /\.json$/i.test(rest) ? 'json' : 'md'
  return rest ? { format, path: rest } : { format }
}

/** A file name for an export: `houston-<title>-<yyyymmdd-hhmm>.<ext>`, safe on every OS. */
export function defaultExportName(title: string, at: Date, format: ExportFormat): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'chat'
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  return `houston-${slug}-${stamp}.${format}`
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** The saved permission rules, numbered for `/permissions remove <n>`. */
export function renderPermissionRules(rules: PermissionRule[], paint: Painter, now: number): string {
  if (!rules.length) {
    return paint('· no saved permission rules. "Always allow" or "Always deny" at an approval prompt saves one.', 'dim')
  }
  const tone = { allow: 'green', deny: 'red', ask: 'yellow' } as const
  const lines = [paint('Saved permission rules (checked before the approval mode):', 'bold')]
  const width = Math.max(...rules.map((r) => (r.tool || '*').length))
  rules.forEach((r, i) => {
    const subject = r.match ? stripControlChars(r.match) : paint('(nothing)', 'dim')
    const source = r.source === 'prompt' ? 'from a prompt' : r.source === 'settings' ? 'from settings' : ''
    const how = [r.exact ? 'exact' : '', source, r.addedAt ? ago(now - r.addedAt) : ''].filter(Boolean).join(', ')
    lines.push(
      `  ${paint(String(i + 1).padStart(2), 'cyan')}. ${paint(r.action.padEnd(5), tone[r.action])} ${(r.tool || '*').padEnd(width)}  ${subject}${how ? paint(`  (${how})`, 'dim') : ''}`
    )
  })
  lines.push(paint('/permissions remove <n> deletes one. Project rules in .houston/settings.json are edited in that file.', 'dim'))
  return lines.join('\n')
}

/**
 * Write a /export file: relative to the working folder (`~/` for home), never over an
 * existing file, owner-only since a chat can hold anything that was pasted into it.
 */
export function writeExportFile(cwd: string, path: string, content: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  const full = resolve(cwd, expanded)
  try {
    writeFileSync(full, content, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`${full} already exists; give another path`, { cause: e })
    if (code === 'ENOENT') throw new Error(`no such folder for ${full}`, { cause: e })
    throw e
  }
  return full
}

import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatMessage } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { latestRunEnd, runEndNoticeText, runEndRecords } from '@shared/runEnd'
import type { PermissionRule, RecentDenial } from '@shared/types'
import type { Painter } from './tui'
import { stripControlChars, terminalText, truncateVisible } from './tui-wrap'

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

/**
 * The resume picker's preview of the highlighted chat: its title, when it was last
 * updated (and where, when given), how many messages it has, the first thing you asked
 * and the start of the last reply (`lines` lines each). Every line is sanitized and cut
 * to `width`; `messages` is null when the chat couldn't be read. Pure.
 */
export function sessionPreviewLines(
  entry: { title: string; updatedAt: number },
  messages: ChatMessage[] | null,
  opts: { width: number; paint: Painter; when: string; folder?: string; lines?: number }
): string[] {
  const { paint } = opts
  const per = opts.lines ?? 3
  // Indent 4, and a column to spare so a line at the limit never wraps.
  const width = Math.max(10, opts.width - 5)
  const cut = (l: string): string => ([...l].length > width ? `${[...l].slice(0, width - 1).join('')}…` : l)
  const rule = paint(`  ${'─'.repeat(Math.max(4, Math.min(40, opts.width - 4)))}`, 'dim')
  const out = [rule, `  ${paint(cut(stripControlChars(entry.title) || 'New chat'), 'bold')}`]
  const facts = [`updated ${opts.when}`]
  if (messages) facts.push(`${messages.length} message${messages.length === 1 ? '' : 's'}`)
  if (opts.folder) facts.push(stripControlChars(opts.folder))
  out.push(`  ${paint(cut(facts.join(' · ')), 'dim')}`)
  if (!messages) {
    out.push(`  ${paint("couldn't read this chat", 'yellow')}`)
    return out
  }
  const first = messages.find(isPersonTurn)
  const reply = messages.filter((m) => m.role === 'assistant' && m.content.trim()).at(-1)
  if (!first && !reply) {
    out.push(`  ${paint('(no messages yet)', 'dim')}`)
    return out
  }
  if (first) {
    out.push(`  ${paint('you ›', 'green')}`)
    for (const l of clip(personText(first), per, width)) out.push(`    ${l}`)
  }
  if (reply) {
    out.push(`  ${paint('houston ›', 'cyan')}`)
    for (const l of clip(reply.content, per, width)) out.push(`    ${paint(l, 'dim')}`)
  }
  return out
}

/** How many of the last exchanges a resumed chat replays. */
export const RECAP_EXCHANGES = 3

/**
 * The last few exchanges of a chat, shown when it is resumed so you can see where you
 * left off: each message you sent (two lines at most) and the reply text that answered
 * it (four lines at most), then how any run in that exchange ended short (an error, a
 * Stop, a limit), where the desktop shows the same notice under its message. The
 * latest run's ending is left to `runEndNotice`, which says it last. Tool calls are
 * left out; `/export` has everything. Empty for a chat with nothing to show.
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
  const latest = latestRunEnd(messages)
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
    for (const r of messages.slice(start, next).flatMap(runEndRecords)) {
      if (r === latest) continue
      for (const l of clip(runEndNoticeText(r), 1, width)) lines.push(`  ${paint(`· ${l}`, 'yellow')}`)
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

/** What an export keeps besides the conversation itself. */
export interface ExportContent {
  /** The model's reasoning before a reply (`--no-reasoning` leaves it out). */
  reasoning: boolean
  /** Tool calls and their output (`--no-tools` leaves them out). */
  tools: boolean
}

const FULL_EXPORT: ExportContent = { reasoning: true, tools: true }

/**
 * The chat as Markdown, for reading or sharing: your messages and the replies in full,
 * the reasoning before a reply in a folded block, each tool call as one line with its
 * arguments, and each tool's output in a code block cut to {@link EXPORT_TOOL_LINES}
 * lines. `content` leaves the reasoning or the tools out.
 */
export function chatToMarkdown(messages: ChatMessage[], meta: ExportMeta, content: ExportContent = FULL_EXPORT): string {
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
      const thought = content.reasoning
        ? (m.reasoning ?? []).map((r) => r.text.trim()).filter(Boolean).join('\n\n')
        : ''
      const calls = content.tools ? (m.toolCalls ?? []) : []
      if (m.content.trim() || thought) out.push('## Houston', '')
      if (thought) out.push('<details><summary>Reasoning</summary>', '', thought, '', '</details>', '')
      if (m.content.trim()) out.push(m.content, '')
      for (const call of calls) {
        const args = JSON.stringify(call.arguments ?? {})
        const shown = args.length > 200 ? `${args.slice(0, 199)}…` : args
        const fence = '`'.repeat(Math.max(1, ...[...shown.matchAll(/`+/g)].map((x) => x[0].length + 1)))
        out.push(`- **${call.name}** ${fence}${shown}${fence}`)
      }
      if (calls.length) out.push('')
      continue
    }
    if (m.role === 'tool') {
      if (!content.tools) continue
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

/**
 * The messages an export keeps: all of them as saved, or without the reasoning or the
 * tool calls and results. A reply left with nothing in it is dropped.
 */
export function exportMessages(messages: ChatMessage[], content: ExportContent): ChatMessage[] {
  if (content.reasoning && content.tools) return messages
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (!content.tools && m.role === 'tool') continue
    let next: ChatMessage = m
    if (!content.reasoning && next.reasoning) {
      const { reasoning: _reasoning, ...rest } = next
      next = rest
    }
    if (!content.tools && next.toolCalls) {
      const { toolCalls: _toolCalls, ...rest } = next
      next = rest
      if (next.role === 'assistant' && !next.content.trim() && !next.reasoning?.length) continue
    }
    out.push(next)
  }
  return out
}

/** The chat as JSON: the facts above plus every message as saved (less what `content` leaves out). */
export function chatToJson(messages: ChatMessage[], meta: ExportMeta, content: ExportContent = FULL_EXPORT): string {
  messages = exportMessages(messages, content)
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

export type ExportFormat = 'md' | 'json' | 'html'

/** What `/export` was asked for. */
export interface ExportArgs {
  format: ExportFormat
  path?: string
  /** `--copy`: put the export on the clipboard (as well as in `path`, when one is given). */
  copy?: boolean
  /** `--no-reasoning`: leave the model's reasoning out. */
  noReasoning?: boolean
  /** `--no-tools`: leave the tool calls and their output out. */
  noTools?: boolean
  /** `--no-redact`: keep secrets as they are (they are masked by default). */
  noRedact?: boolean
  /** An option `/export` doesn't know, reported instead of exporting. */
  bad?: string
}

const EXPORT_FLAGS: Readonly<Record<string, 'copy' | 'noReasoning' | 'noTools' | 'noRedact'>> = {
  '--copy': 'copy',
  '--no-reasoning': 'noReasoning',
  '--no-tools': 'noTools',
  '--no-redact': 'noRedact'
}

/**
 * `/export [md|json] [path] [--copy] [--no-reasoning] [--no-tools] [--no-redact]`: the
 * format (from the word, else the path's extension), the path, and the options, which
 * may come anywhere on the line.
 */
export function parseExportArgs(arg: string): ExportArgs {
  const flags: Omit<ExportArgs, 'format' | 'path'> = {}
  const words: string[] = []
  for (const word of arg.trim().split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase()
    const flag = Object.hasOwn(EXPORT_FLAGS, lower) ? EXPORT_FLAGS[lower] : undefined
    if (flag) flags[flag] = true
    else if (word.startsWith('--')) flags.bad ??= word
    else words.push(word)
  }
  let rest = words.join(' ')
  let format: ExportFormat | undefined
  const first = /^(md|markdown|json|html)(?:\s+|$)/i.exec(rest)
  if (first) {
    const word = first[1].toLowerCase()
    format = word === 'json' ? 'json' : word === 'html' ? 'html' : 'md'
    rest = rest.slice(first[0].length).trim()
  }
  if (!format) format = /\.json$/i.test(rest) ? 'json' : /\.html?$/i.test(rest) ? 'html' : 'md'
  return { format, ...(rest ? { path: rest } : {}), ...flags }
}

/**
 * Mask the secrets in an export's messages with `redact` (the transcript redacter):
 * every string in them except attachment bytes and the opaque reasoning signatures a
 * provider replays, which a pattern could only corrupt.
 */
export function redactExport(messages: ChatMessage[], redact: (text: string) => string): ChatMessage[] {
  const skip = new Set(['images', 'documents', 'signature', 'redactedData'])
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = skip.has(k) ? x : walk(x)
      return out
    }
    return v
  }
  return messages.map((m) => walk(m) as ChatMessage)
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
  // A rule's tool and pattern can come from a project's settings file, so neither
  // reaches the terminal with its control characters.
  const toolOf = (r: PermissionRule): string => stripControlChars(r.tool || '*')
  const width = Math.max(...rules.map((r) => toolOf(r).length))
  rules.forEach((r, i) => {
    const subject = r.match ? stripControlChars(r.match) : paint('(nothing)', 'dim')
    const source = r.source === 'prompt' ? 'from a prompt' : r.source === 'settings' ? 'from settings' : ''
    const how = [r.exact ? 'exact' : '', source, r.addedAt ? ago(now - r.addedAt) : ''].filter(Boolean).join(', ')
    lines.push(
      `  ${paint(String(i + 1).padStart(2), 'cyan')}. ${paint(r.action.padEnd(5), tone[r.action])} ${toolOf(r).padEnd(width)}  ${subject}${how ? paint(`  (${how})`, 'dim') : ''}`
    )
  })
  lines.push(paint('/permissions remove <n> deletes one. Project rules in .houston/settings.json are edited in that file.', 'dim'))
  return lines.join('\n')
}

/**
 * The calls denied at an approval prompt this session, newest first, numbered for
 * `/permissions allow <n>`. Empty when nothing was denied. A subject is the model's
 * text, so it is shown with its hidden characters as codes, on one line, and cut to fit.
 */
export function renderRecentDenials(denials: RecentDenial[], paint: Painter, now: number, width = 80): string {
  if (!denials.length) return ''
  const lines = [paint('Recently denied this session (newest first):', 'bold')]
  const toolOf = (d: RecentDenial): string => stripControlChars(d.tool)
  const toolWidth = Math.max(...denials.map((d) => toolOf(d).length))
  denials.forEach((d, i) => {
    const subject = d.subject.trim()
      ? truncateVisible(terminalText(d.subject, { lines: false }), Math.max(20, width - toolWidth - 30))
      : paint('(no target)', 'dim')
    const why = d.reason ? `, "${truncateVisible(terminalText(d.reason, { lines: false }), 60)}"` : ''
    lines.push(
      `  ${paint(String(i + 1).padStart(2), 'cyan')}. ${toolOf(d).padEnd(toolWidth)}  ${subject}${paint(`  (${ago(now - d.at)}${why})`, 'dim')}`
    )
  })
  lines.push(paint('/permissions allow <n> saves an allow rule for one, the rule "Always allow" would have saved.', 'dim'))
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

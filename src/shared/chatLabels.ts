/**
 * Chat labels: user-defined tags a chat can carry any number of, independent of the
 * one group it is filed into. Definitions (name, color) live in settings
 * (AppSettings.chatLabels); which labels a chat carries is stored on the chat itself
 * (ConversationMeta.labels, label ids). Each sidebar section can be filtered to the
 * chats carrying any of a set of labels (AppSettings.sectionLabelFilters).
 *
 * Both settings.json and the conversation files are user-editable, so everything read
 * from them goes through the readers here, which drop anything malformed. Pure.
 */
import type { ChatLabel, LabelColor } from './types'

/** The colors a label can take, in the order new labels are given them. */
export const LABEL_COLORS: readonly LabelColor[] = [
  'blue',
  'green',
  'orange',
  'purple',
  'red',
  'teal',
  'yellow',
  'pink'
]

/** How many labels one chat can carry. */
export const MAX_LABELS_PER_CHAT = 20
/** How many labels can be defined. */
export const MAX_LABELS = 100
/** Longest label name kept, in characters. */
export const MAX_LABEL_NAME = 40
/** Longest label id kept: ids are generated (`lbl-` + a UUID), so anything longer is junk. */
const MAX_LABEL_ID = 64

function isLabelId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_LABEL_ID
}

/** A chat's label ids: strings only, duplicates dropped, at most {@link MAX_LABELS_PER_CHAT}. */
export function sanitizeLabelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (isLabelId(v) && !out.includes(v)) out.push(v)
    if (out.length >= MAX_LABELS_PER_CHAT) break
  }
  return out
}

/** A label name as stored: trimmed, inner whitespace collapsed, capped. Empty = invalid. */
export function cleanLabelName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_NAME)
}

function isLabelColor(v: unknown): v is LabelColor {
  return typeof v === 'string' && (LABEL_COLORS as readonly string[]).includes(v)
}

/** The label definitions from settings, in order, with malformed entries dropped. */
export function readChatLabels(raw: unknown): ChatLabel[] {
  if (!Array.isArray(raw)) return []
  const out: ChatLabel[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const { id, name, color } = v as Record<string, unknown>
    if (!isLabelId(id) || seen.has(id) || typeof name !== 'string') continue
    const clean = cleanLabelName(name)
    if (!clean) continue
    seen.add(id)
    out.push({ id, name: clean, color: isLabelColor(color) ? color : LABEL_COLORS[0] })
    if (out.length >= MAX_LABELS) break
  }
  return out
}

/**
 * The per-section label filters from settings: section id → the label ids it shows.
 * Ids of labels that no longer exist are dropped, and so is a section left with none.
 */
export function readLabelFilters(raw: unknown, known: ReadonlySet<string>): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [section, ids] of Object.entries(raw as Record<string, unknown>)) {
    const kept = sanitizeLabelIds(ids).filter((id) => known.has(id))
    if (kept.length > 0) out[section] = kept
  }
  return out
}

/** A new label's color: the first one no label uses yet, else the next in turn. */
export function nextLabelColor(labels: readonly ChatLabel[]): LabelColor {
  const used = new Set(labels.map((l) => l.color))
  return LABEL_COLORS.find((c) => !used.has(c)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length]
}

/** The color after `color`, for the label editor's color button. */
export function cycleLabelColor(color: LabelColor): LabelColor {
  return LABEL_COLORS[(LABEL_COLORS.indexOf(color) + 1) % LABEL_COLORS.length]
}

/**
 * A new label's id. Never reused (no counter), so a label deleted and made again
 * can't pick up chats still carrying the old one's id.
 */
export function newLabelId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return `lbl-${c.randomUUID()}`
  return `lbl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

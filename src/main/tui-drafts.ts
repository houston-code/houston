/**
 * The terminal composer's unsent draft, saved per conversation so it outlives a
 * Ctrl-C, a quit, a crash, or a `/resume` to another chat. The desktop app keeps its
 * drafts in the renderer's storage; the terminal keeps them here, one small file per
 * chat under userData (0600, in a 0700 folder), so two terminals on different chats
 * never write the same file.
 *
 * A record holds the text being typed and the messages typed mid-run that the turn
 * has not taken yet (queued, or steers that have not landed). Those were already
 * acknowledged on screen, so they are written at once; the text being typed is
 * written after a short pause in typing.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write'

/** What is saved for one chat. */
export interface DraftRecord {
  /** The draft being typed. */
  text: string
  /** Messages typed mid-run that have not reached the model yet, oldest first. */
  queued: string[]
}

/** Chats whose drafts are kept; past it the oldest is dropped. */
export const MAX_SAVED_DRAFTS = 50
/** Characters kept per chat. Waiting messages are kept first, then the draft. */
export const MAX_DRAFT_CHARS = 100_000
/** Pause in typing before the draft is written. */
export const DRAFT_SAVE_MS = 250

export interface DraftStore {
  load(key: string): DraftRecord | null
  save(key: string, record: DraftRecord | null): void
}

/** Whether a record has nothing in it worth keeping. */
export function draftIsEmpty(r: DraftRecord | null | undefined): boolean {
  return !r || (!r.text.trim() && !r.queued.some((q) => q.trim()))
}

/** The record cut to {@link MAX_DRAFT_CHARS}: waiting messages first, whole where they fit. */
export function capDraft(r: DraftRecord, max = MAX_DRAFT_CHARS): DraftRecord {
  let budget = max
  const queued: string[] = []
  for (const q of r.queued) {
    if (!q.trim()) continue
    if (budget <= 0) break
    queued.push(q.slice(0, budget))
    budget -= Math.min(q.length, budget)
  }
  return { text: r.text.slice(0, Math.max(0, budget)), queued }
}

/** The text a restored record opens the composer with: what was waiting, then the draft. */
export function draftRestoreText(r: DraftRecord): string {
  return [...r.queued, r.text].map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim()).join('\n\n')
}

/** The note printed above a restored draft. */
export function draftRestoreNote(r: DraftRecord): string {
  const n = r.queued.filter((q) => q.trim()).length
  if (!n) return '· restored the draft you had not sent'
  return `· restored ${n === 1 ? '1 message' : `${n} messages`} typed during a turn that never reached the model, to edit or send`
}

/** The key for a chat's draft: its id, or the folder's new-chat slot. */
export function draftKey(conversationId: string | null, cwd: string): string {
  return conversationId ?? `new:${cwd}`
}

function fileFor(dir: string, key: string): string {
  return join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
}

function parse(raw: string, key: string): DraftRecord | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  // A hash collision, or a file written for another chat, is not this chat's draft.
  if (o.key !== key || typeof o.text !== 'string') return null
  const queued = Array.isArray(o.queued) ? o.queued.filter((q): q is string => typeof q === 'string') : []
  const r = capDraft({ text: o.text, queued })
  return draftIsEmpty(r) ? null : r
}

/** The file-backed store. Every failure is logged by the caller's `warn` and survived. */
export function createDraftStore(
  dir: string,
  opts: { max?: number; warn?: (msg: string) => void } = {}
): DraftStore {
  const max = opts.max ?? MAX_SAVED_DRAFTS
  const warn = opts.warn ?? (() => {})
  const prune = (): void => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    if (files.length <= max) return
    const dated = files
      .map((f) => {
        try {
          return { f, at: statSync(join(dir, f)).mtimeMs }
        } catch {
          return { f, at: 0 }
        }
      })
      .sort((a, b) => a.at - b.at)
    for (const { f } of dated.slice(0, files.length - max)) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        /* another process pruned it first */
      }
    }
  }
  return {
    load: (key) => {
      try {
        return parse(readFileSync(fileFor(dir, key), 'utf8'), key)
      } catch {
        return null
      }
    },
    save: (key, record) => {
      const file = fileFor(dir, key)
      try {
        if (draftIsEmpty(record)) {
          try {
            unlinkSync(file)
          } catch {
            /* nothing saved for this chat */
          }
          return
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const r = capDraft(record!)
        writeFileAtomicSync(file, JSON.stringify({ v: 1, key, text: r.text, queued: r.queued }), 0o600)
        prune()
      } catch (e) {
        warn(`failed to save the composer draft: ${String(e)}`)
      }
    }
  }
}

/**
 * Debounced writes over a store: `update` with `now` writes at once (a message the
 * screen already said was queued), otherwise after {@link DRAFT_SAVE_MS} of quiet.
 * A pending write for another chat is written before the new one is taken.
 */
export function createDraftSaver(
  store: DraftStore,
  timeout: (fn: () => void, ms: number) => () => void,
  delayMs = DRAFT_SAVE_MS
): { update(key: string, record: DraftRecord | null, now?: boolean): void; flush(): void } {
  let pending: { key: string; record: DraftRecord | null } | null = null
  let cancel: (() => void) | null = null
  const flush = (): void => {
    cancel?.()
    cancel = null
    if (!pending) return
    const p = pending
    pending = null
    store.save(p.key, p.record)
  }
  return {
    update: (key, record, now = false) => {
      if (pending && pending.key !== key) flush()
      pending = { key, record }
      if (now) return flush()
      cancel?.()
      cancel = timeout(flush, delayMs)
    },
    flush
  }
}

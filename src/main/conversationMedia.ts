import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Image and document bytes kept beside a conversation instead of inside its JSON.
 *
 * Attachments live in memory (and cross IPC) as `{ mediaType, data }` with base64
 * `data`. Stored inline, every screenshot, read image, and pasted PDF re-serialized
 * the whole transcript file on each save and made chats with a gallery of captures
 * many megabytes of JSON. On disk an attachment is instead written once as raw bytes
 * to `<conversation>.media/<sha256>.<ext>` and the JSON keeps
 * `{ mediaType, mediaRef }`. Loading a conversation for use puts `data` back.
 *
 * The walk is structural (any object carrying a string `mediaType` and string
 * `data`), so it covers message images, tool-result images, document attachments,
 * and side-chat messages without listing each field, and keeps working when a new
 * field starts carrying attachments.
 */

/** Content-addressed file name: a sha256 hex digest and a short extension. */
const MEDIA_REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,5}$/

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
}

function extFor(mediaType: string): string {
  return EXT_BY_TYPE[mediaType] ?? 'bin'
}

type Inline = { mediaType: string; data: string } & Record<string, unknown>
type Stored = { mediaType: string; mediaRef: string } & Record<string, unknown>

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isInline(v: Record<string, unknown>): v is Inline {
  return typeof v.mediaType === 'string' && typeof v.data === 'string' && v.data.length > 0
}

function isStored(v: Record<string, unknown>): v is Stored {
  return typeof v.mediaType === 'string' && typeof v.mediaRef === 'string' && !('data' in v)
}

/**
 * Digest per attachment object. The in-memory message log hands the same objects to
 * every save of a run, so each image is hashed once rather than on every write.
 */
const digestCache = new WeakMap<object, string>()

function refFor(att: Inline): string {
  let digest = digestCache.get(att)
  if (!digest) {
    digest = createHash('sha256').update(att.data).digest('hex')
    digestCache.set(att, digest)
  }
  return `${digest}.${extFor(att.mediaType)}`
}

/**
 * Copy `value`, replacing every inline attachment with a stored reference and writing
 * its bytes into `mediaDir` (owner-only, like the transcript itself). Objects and
 * arrays are copied only along paths that change, so the caller's in-memory
 * conversation is never mutated. Returns the copy and every reference it holds,
 * including ones that were already stored, so the caller can prune the rest.
 */
export function externalizeMedia<T>(value: T, mediaDir: string): { value: T; refs: Set<string> } {
  const refs = new Set<string>()
  let dirReady = false
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((item) => {
        const next = visit(item)
        if (next !== item) changed = true
        return next
      })
      return changed ? out : v
    }
    if (!isObject(v)) return v
    if (isStored(v)) {
      if (MEDIA_REF_RE.test(v.mediaRef)) refs.add(v.mediaRef)
      return v
    }
    if (isInline(v)) {
      const ref = refFor(v)
      refs.add(ref)
      const path = join(mediaDir, ref)
      if (!existsSync(path)) {
        if (!dirReady) {
          mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
          dirReady = true
        }
        // Content-addressed, so an existing file is trusted to hold these bytes. Write
        // to a temp name and rename so a crash mid-write can never leave a truncated
        // file under the digest name, where no later save would replace it.
        const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(tmp, Buffer.from(v.data, 'base64'), { mode: 0o600 })
        renameSync(tmp, path)
      }
      const { data: _data, ...rest } = v
      return { ...rest, mediaRef: ref }
    }
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(v)) {
      const next = visit(item)
      if (next !== item) changed = true
      out[k] = next
    }
    return changed ? out : v
  }
  return { value: visit(value) as T, refs }
}

/**
 * Copy `value`, putting the base64 `data` back on every stored reference. A
 * reference whose file is missing or unreadable (or whose name isn't a well-formed
 * digest, so it can never point outside `mediaDir`) is dropped: removed from its
 * array, or left off its parent object. A conversation with a lost image still
 * loads, and never sends a provider an image block with no bytes in it.
 */
export function hydrateMedia<T>(value: T, mediaDir: string): T {
  const DROP = Symbol('drop')
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false
      const out: unknown[] = []
      for (const item of v) {
        const next = visit(item)
        if (next !== item) changed = true
        if (next !== DROP) out.push(next)
      }
      return changed ? out : v
    }
    if (!isObject(v)) return v
    if (isStored(v)) {
      if (!MEDIA_REF_RE.test(v.mediaRef)) return DROP
      try {
        const data = readFileSync(join(mediaDir, v.mediaRef)).toString('base64')
        const { mediaRef: _ref, ...rest } = v
        return { ...rest, data }
      } catch {
        return DROP
      }
    }
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(v)) {
      const next = visit(item)
      if (next !== item) changed = true
      if (next !== DROP) out[k] = next
    }
    return changed ? out : v
  }
  const result = visit(value)
  return (result === DROP ? undefined : result) as T
}

/** Delete files in `mediaDir` that no reference in `keep` points at; the folder too once empty. */
export function pruneMedia(mediaDir: string, keep: Set<string>): void {
  let names: string[]
  try {
    names = readdirSync(mediaDir)
  } catch {
    return
  }
  let left = 0
  for (const name of names) {
    if (keep.has(name)) {
      left++
      continue
    }
    // Only ever delete files this module names; anything else is left alone.
    if (!MEDIA_REF_RE.test(name)) {
      left++
      continue
    }
    try {
      rmSync(join(mediaDir, name), { force: true })
    } catch {
      left++
    }
  }
  if (left === 0) rmSync(mediaDir, { recursive: true, force: true })
}

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'
import {
  MAX_MEMORIES_PER_SCOPE,
  MAX_MEMORY_BODY,
  MAX_MEMORY_DESCRIPTION,
  MAX_MEMORY_NAME,
  MEMORY_FORMAT_VERSION,
  MEMORY_ORIGINS,
  MEMORY_TYPES,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryRepoInfo,
  type MemoryStoreScope,
  type MemoryType
} from '@shared/memoryTypes'
import { writeFileAtomicSync } from '../atomic-write'
import { withFileLock } from '../fileLock'
import { GLOBAL_RULES_DIRNAME } from './rules'
import { findSecret } from './redact'
import { resolveRepo } from './repoIdentity'
import { stripBidiControls } from './untrusted'
import { log } from '../logger'

/**
 * The on-disk store behind cross-session memory (docs/memory-design.md). One
 * markdown file per memory, with flat front matter, under
 *
 *   ~/.houston/memory/global/<id>.md          facts that apply to every project
 *   ~/.houston/memory/repos/<key>/<id>.md     one repository, keyed by repoIdentity
 *   ~/.houston/memory/.trash/<scope>/<id>.md  deletions, kept for undo
 *   ~/.houston/memory/usage.json              recall counts, for ordering the prompt index
 *
 * The store lives in the user's home, never the repository, so a cloned repo can't
 * seed it. The repo key is the git common dir's hash, so the main checkout and all
 * of its worktrees share one folder that outlives any worktree's teardown.
 *
 * There is no index file: listing scans the folder, so what the prompt shows can
 * never drift from what is on disk. Nothing is cached in the process either; the
 * desktop app and the terminal write the same folders, and a cached copy is how one
 * of them ends up clobbering or missing the other's writes.
 *
 * Everything that reaches a file passes through here, so the limits live here too:
 * field sizes and shapes, the per-scope cap, refusing secrets, ids the caller can't
 * choose (a file name can never be steered into a path), owner-only permissions, and
 * never reading or writing through a symlinked memory file.
 */

/** How long a deleted memory stays restorable. */
export const MEMORY_TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000

const ID_RE = /^m_\d{8}_[a-z2-7]{6}$/
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,128}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
// Held as `<dir>/.store.lock` across every read-modify-write of one scope folder.
const LOCK_NAME = '.store'
const USAGE_FILE = 'usage.json'

export interface MemoryUsage {
  recalls: number
  lastRecalled: string
}

export type MemoryErrorCode = 'invalid' | 'secret' | 'cap' | 'not-found' | 'stale' | 'symlink'

/** A refused store operation. `message` is safe to show the model or the user. */
export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}

export interface MemoryStoreOptions {
  /** The store's root folder. Defaults to ~/.houston/memory. */
  root?: string
  /** The workspace whose repository the `repo` scope means. Without it, `repo` is refused. */
  workspace?: string
  /** This install's stored secret values, refused alongside well-known token formats. */
  knownSecrets?: readonly string[]
  now?: () => Date
}

export interface SaveMemoryInput {
  scope: MemoryStoreScope
  /** Update this memory. Omitted: create one, or update the one already holding `name`. */
  id?: string
  type: MemoryType
  name: string
  description: string
  body: string
  origin: MemoryOrigin
  conversation?: string
  /** Kept as-is when omitted on an update; false on create. */
  pinned?: boolean
  /** The `updated` value the caller last read; a different one on disk refuses the save. */
  expectedUpdated?: string
}

export interface SaveMemoryResult {
  record: MemoryRecord
  created: boolean
}

/**
 * ~/.houston/memory, or `HOUSTON_MEMORY_DIR` when set (the tests point it at a temp
 * folder so a developer's own memories never reach a test run).
 */
export function defaultMemoryRoot(home?: string): string {
  if (home === undefined && process.env.HOUSTON_MEMORY_DIR) return process.env.HOUSTON_MEMORY_DIR
  return join(home ?? homedir(), GLOBAL_RULES_DIRNAME, 'memory')
}

export function memoryStore(opts: MemoryStoreOptions = {}) {
  const root = opts.root ?? defaultMemoryRoot()
  const now = opts.now ?? (() => new Date())
  // Resolved once: the workspace's repository doesn't change under a store.
  const repo = opts.workspace !== undefined ? resolveRepo(opts.workspace) : undefined

  function scopeDir(scope: MemoryStoreScope): string {
    if (scope === 'global') return join(root, 'global')
    if (!repo) throw new MemoryError('invalid', 'The repo scope needs a workspace.')
    return join(root, 'repos', repo.key)
  }

  function trashDir(scope: MemoryStoreScope): string {
    return join(root, '.trash', scope === 'global' ? 'global' : `repo-${repo?.key ?? ''}`)
  }

  function list(scope: MemoryStoreScope): MemoryRecord[] {
    return readScope(scopeDir(scope), scope).sort((a, b) => b.updated.localeCompare(a.updated))
  }

  function get(scope: MemoryStoreScope, id: string): MemoryRecord | null {
    if (!ID_RE.test(id)) return null
    return readRecord(join(scopeDir(scope), `${id}.md`), scope)
  }

  async function save(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    const fields = validate(input, opts.knownSecrets ?? [])
    const dir = scopeDir(input.scope)
    ensureDir(dir)
    return withFileLock(join(dir, LOCK_NAME), () => {
      const existing = readScope(dir, input.scope)
      let prior: MemoryRecord | undefined
      if (input.id !== undefined) {
        if (!ID_RE.test(input.id)) throw new MemoryError('invalid', `"${input.id}" is not a memory id.`)
        prior = existing.find((m) => m.id === input.id)
        if (!prior) throw new MemoryError('not-found', `No memory ${input.id} in the ${input.scope} scope.`)
      } else {
        prior = existing.find((m) => m.name === fields.name)
      }
      if (prior && input.expectedUpdated !== undefined && prior.updated !== input.expectedUpdated) {
        throw new MemoryError('stale', `Memory ${prior.id} changed since it was read; reload it and retry.`)
      }
      if (input.id !== undefined && fields.name !== prior?.name && existing.some((m) => m.name === fields.name)) {
        throw new MemoryError('invalid', `Another memory in the ${input.scope} scope is already named "${fields.name}".`)
      }
      if (!prior && existing.length >= MAX_MEMORIES_PER_SCOPE) {
        throw new MemoryError(
          'cap',
          `The ${input.scope} scope already holds ${MAX_MEMORIES_PER_SCOPE} memories; delete or update one instead.`
        )
      }
      const stamp = now().toISOString()
      const record: MemoryRecord = {
        id: prior?.id ?? newId(dir, now()),
        scope: input.scope,
        ...fields,
        created: prior?.created ?? stamp,
        updated: stamp,
        origin: input.origin,
        ...(fields.conversation === undefined ? {} : { conversation: fields.conversation }),
        pinned: input.pinned ?? prior?.pinned ?? false
      }
      const file = join(dir, `${record.id}.md`)
      refuseSymlink(file)
      if (input.scope === 'repo' && repo) writeRepoMeta(dir, repo.root)
      writeFileAtomicSync(file, serialize(record), 0o600)
      log.info(`memory: ${prior ? 'updated' : 'saved'} ${input.scope} ${record.id} (${record.origin})`)
      return { record, created: !prior }
    })
  }

  /** Move a memory to the trash. False when it doesn't exist (deleting twice is fine). */
  async function remove(scope: MemoryStoreScope, id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false
    const dir = scopeDir(scope)
    if (!existsSync(dir)) return false
    return withFileLock(join(dir, LOCK_NAME), () => {
      const file = join(dir, `${id}.md`)
      if (!isPlainFile(file)) return false
      const trash = trashDir(scope)
      ensureDir(trash)
      const dest = join(trash, `${id}.md`)
      renameSync(file, dest)
      // The trash clock starts at deletion, not at the memory's last edit.
      const t = now()
      utimesSync(dest, t, t)
      log.info(`memory: deleted ${scope} ${id}`)
      return true
    })
  }

  /** Bring a deleted memory back. Null when it isn't in the trash or its id is taken again. */
  async function restore(scope: MemoryStoreScope, id: string): Promise<MemoryRecord | null> {
    if (!ID_RE.test(id)) return null
    const dir = scopeDir(scope)
    const src = join(trashDir(scope), `${id}.md`)
    if (!isPlainFile(src)) return null
    ensureDir(dir)
    return withFileLock(join(dir, LOCK_NAME), () => {
      const dest = join(dir, `${id}.md`)
      if (existsSync(dest) || !isPlainFile(src)) return null
      const record = readRecord(src, scope)
      if (!record) return null
      if (readScope(dir, scope).length >= MAX_MEMORIES_PER_SCOPE) {
        throw new MemoryError('cap', `The ${scope} scope is full; delete a memory before restoring one.`)
      }
      renameSync(src, dest)
      log.info(`memory: restored ${scope} ${id}`)
      return record
    })
  }

  async function setPinned(scope: MemoryStoreScope, id: string, pinned: boolean): Promise<MemoryRecord> {
    const current = get(scope, id)
    if (!current) throw new MemoryError('not-found', `No memory ${id} in the ${scope} scope.`)
    const { record } = await save({ ...current, scope, id, pinned, conversation: current.conversation })
    return record
  }

  /** Delete trashed memories older than `ttlMs`. Returns how many were removed. */
  function pruneTrash(ttlMs: number = MEMORY_TRASH_TTL_MS): number {
    const base = join(root, '.trash')
    const cutoff = now().getTime() - ttlMs
    let removed = 0
    for (const sub of safeReaddir(base)) {
      const dir = join(base, sub)
      for (const name of safeReaddir(dir)) {
        const file = join(dir, name)
        try {
          const st = lstatSync(file)
          if (st.mtimeMs < cutoff) {
            rmSync(file, { force: true })
            removed++
          }
        } catch {
          // Gone already, or unreadable: nothing to prune.
        }
      }
    }
    return removed
  }

  /** Every repository folder in the store, the current one included (see `currentRepoKey`). */
  function listRepos(): MemoryRepoInfo[] {
    const base = join(root, 'repos')
    const out: MemoryRepoInfo[] = []
    for (const key of safeReaddir(base)) {
      if (!/^[0-9a-f]{16}$/.test(key)) continue
      const dir = join(base, key)
      const meta = readRepoMeta(dir)
      const count = safeReaddir(dir).filter((n) => ID_RE.test(n.replace(/\.md$/, '')) && n.endsWith('.md')).length
      out.push({ key, label: meta?.label ?? key, root: meta?.root ?? '', count })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }

  /** When each memory was last recalled, by id. Best effort: a missing or corrupt file reads as none. */
  function usage(): Record<string, MemoryUsage> {
    const file = join(root, USAGE_FILE)
    if (!isPlainFile(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      const items = (parsed as { items?: unknown } | null)?.items
      if (!items || typeof items !== 'object') return {}
      const out: Record<string, MemoryUsage> = {}
      for (const [id, v] of Object.entries(items as Record<string, unknown>)) {
        const u = v as Partial<MemoryUsage> | null
        if (ID_RE.test(id) && typeof u?.recalls === 'number' && typeof u.lastRecalled === 'string') {
          out[id] = { recalls: u.recalls, lastRecalled: u.lastRecalled }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * Count a recall of each id, so the prompt index can keep memories that keep
   * being used. Never throws: losing a count is harmless, failing a recall is not.
   */
  async function noteRecalled(ids: readonly string[]): Promise<void> {
    const valid = ids.filter((id) => ID_RE.test(id))
    if (!valid.length) return
    try {
      ensureDir(root)
      const file = join(root, USAGE_FILE)
      await withFileLock(file, () => {
        const items = usage()
        const stamp = now().toISOString()
        for (const id of valid) items[id] = { recalls: (items[id]?.recalls ?? 0) + 1, lastRecalled: stamp }
        refuseSymlink(file)
        writeFileAtomicSync(file, `${JSON.stringify({ v: MEMORY_FORMAT_VERSION, items })}\n`, 0o600)
      })
    } catch (err) {
      log.warn(`memory: could not record a recall: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    root,
    currentRepoKey: repo?.key,
    currentRepoLabel: repo ? basename(repo.root) : undefined,
    usage,
    noteRecalled,
    list,
    get,
    save,
    remove,
    restore,
    setPinned,
    pruneTrash,
    listRepos
  }
}

export type MemoryStore = ReturnType<typeof memoryStore>

interface ValidFields {
  type: MemoryType
  name: string
  description: string
  body: string
  conversation?: string
}

function validate(input: SaveMemoryInput, knownSecrets: readonly string[]): ValidFields {
  if (!MEMORY_TYPES.includes(input.type)) {
    throw new MemoryError('invalid', `type must be one of ${MEMORY_TYPES.join(', ')}.`)
  }
  if (!MEMORY_ORIGINS.includes(input.origin)) {
    throw new MemoryError('invalid', `origin must be one of ${MEMORY_ORIGINS.join(', ')}.`)
  }
  const name = toName(input.name)
  if (!name) throw new MemoryError('invalid', 'name must contain letters or digits.')
  if (name.length > MAX_MEMORY_NAME) {
    throw new MemoryError('invalid', `name is longer than ${MAX_MEMORY_NAME} characters.`)
  }
  const description = oneLine(stripBidiControls(input.description))
  if (!description) throw new MemoryError('invalid', 'description is empty.')
  if (description.length > MAX_MEMORY_DESCRIPTION) {
    throw new MemoryError('invalid', `description is longer than ${MAX_MEMORY_DESCRIPTION} characters.`)
  }
  const body = stripBidiControls(input.body).replace(/\r\n/g, '\n').trim()
  if (!body) throw new MemoryError('invalid', 'body is empty.')
  if (body.length > MAX_MEMORY_BODY) {
    throw new MemoryError('invalid', `body is longer than ${MAX_MEMORY_BODY} characters.`)
  }
  // Refused, not redacted: a fact with a hole in it misleads later sessions, and the
  // caller can save it again without the value.
  const secret = findSecret(`${name}\n${description}\n${body}`, knownSecrets)
  if (secret) {
    throw new MemoryError('secret', `Refused: the memory contains what looks like a credential (${secret}).`)
  }
  const conversation =
    input.conversation !== undefined && CONVERSATION_RE.test(input.conversation) ? input.conversation : undefined
  return { type: input.type, name, description, body, ...(conversation ? { conversation } : {}) }
}

/** Lowercase kebab-case: any run of other characters becomes one hyphen. */
function toName(raw: string): string {
  return stripBidiControls(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function serialize(m: MemoryRecord): string {
  // Front matter is flat `key: value` lines (see parseFrontmatter). Every value is one
  // line by construction; the description is quoted so a leading or trailing quote
  // in it survives the parser's quote stripping.
  const lines = [
    '---',
    `v: ${MEMORY_FORMAT_VERSION}`,
    `id: ${m.id}`,
    `name: ${m.name}`,
    `description: "${m.description}"`,
    `type: ${m.type}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
    `origin: ${m.origin}`,
    ...(m.conversation ? [`conversation: ${m.conversation}`] : []),
    `pinned: ${m.pinned}`,
    '---',
    '',
    m.body,
    ''
  ]
  return lines.join('\n')
}

/** Parse one memory file, or null (logged) when it is missing, corrupt, or from a newer format. */
function readRecord(file: string, scope: MemoryStoreScope): MemoryRecord | null {
  if (!isPlainFile(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(text)
  const skip = (why: string): null => {
    log.warn(`memory: skipping ${basename(file)}: ${why}`)
    return null
  }
  if (data.v !== String(MEMORY_FORMAT_VERSION)) return skip(`unsupported format version "${data.v ?? ''}"`)
  const id = data.id ?? ''
  if (!ID_RE.test(id) || `${id}.md` !== basename(file)) return skip('id missing or not matching the file name')
  if (!NAME_RE.test(data.name ?? '')) return skip('invalid name')
  if (!MEMORY_TYPES.includes(data.type as MemoryType)) return skip('invalid type')
  if (!MEMORY_ORIGINS.includes(data.origin as MemoryOrigin)) return skip('invalid origin')
  if (!data.description || !data.created || !data.updated) return skip('missing fields')
  return {
    id,
    scope,
    type: data.type as MemoryType,
    name: data.name,
    description: data.description,
    body,
    created: data.created,
    updated: data.updated,
    origin: data.origin as MemoryOrigin,
    ...(data.conversation && CONVERSATION_RE.test(data.conversation) ? { conversation: data.conversation } : {}),
    pinned: data.pinned === 'true'
  }
}

function readScope(dir: string, scope: MemoryStoreScope): MemoryRecord[] {
  const out: MemoryRecord[] = []
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.md')) continue
    const record = readRecord(join(dir, name), scope)
    if (record) out.push(record)
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** A regular file, not a symlink: a linked memory file could point the store anywhere. */
function isPlainFile(file: string): boolean {
  try {
    const st = lstatSync(file)
    if (st.isSymbolicLink()) {
      log.warn(`memory: ignoring symlinked ${basename(file)}`)
      return false
    }
    return st.isFile()
  } catch {
    return false
  }
}

function refuseSymlink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new MemoryError('symlink', `Refused: ${basename(file)} is a symlink.`)
    }
  } catch (err) {
    if (err instanceof MemoryError) throw err
    // Doesn't exist yet: nothing to refuse.
  }
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by the umask; set it outright on the leaf.
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best effort (no-op on Windows).
  }
}

function newId(dir: string, at: Date): string {
  const day = at.toISOString().slice(0, 10).replace(/-/g, '')
  for (;;) {
    const bytes = randomBytes(6)
    const tail = Array.from(bytes, (b) => BASE32[b & 31]).join('')
    const id = `m_${day}_${tail}`
    if (!existsSync(join(dir, `${id}.md`))) return id
  }
}

function writeRepoMeta(dir: string, repoRoot: string): void {
  const meta = { v: MEMORY_FORMAT_VERSION, label: basename(repoRoot), root: repoRoot }
  const file = join(dir, 'meta.json')
  const next = `${JSON.stringify(meta, null, 2)}\n`
  try {
    if (readFileSync(file, 'utf8') === next) return
  } catch {
    // Not written yet.
  }
  refuseSymlink(file)
  writeFileAtomicSync(file, next, 0o600)
}

function readRepoMeta(dir: string): { label: string; root: string } | null {
  const file = join(dir, 'meta.json')
  if (!isPlainFile(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') {
      const { label, root } = parsed as Record<string, unknown>
      if (typeof label === 'string' && typeof root === 'string') return { label, root }
    }
  } catch {
    // Missing or corrupt: the caller falls back to the key.
  }
  return null
}

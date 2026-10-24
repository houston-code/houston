import { callTool, say, turn, type EvalTask } from '../../types'

// The reference migration, one file at a time. Kept as line arrays so a diff of a
// fixture change reads like a diff of the code.
const DB_STORE = [
  '/**',
  ' * In-memory document store standing in for the real one, with the same async',
  ' * shape: every call settles on a later tick. Records are copied in and out so',
  ' * callers can\'t mutate what\'s stored.',
  ' *',
  ' * `failOn` makes reads of the listed ids fail, to exercise error paths.',
  ' */',
  'export function createDb({ failOn = [] } = {}) {',
  '  const records = new Map()',
  '  const later = (fn) => new Promise((resolve, reject) => setImmediate(() => { try { resolve(fn()) } catch (err) { reject(err) } }))',
  '  const copy = (r) => (r === undefined ? undefined : structuredClone(r))',
  '',
  '  return {',
  '    get(id) {',
  '      return later(() => {',
  '        if (failOn.includes(id)) throw new Error(`read failed for ${id}`)',
  '        return copy(records.get(id))',
  '      })',
  '    },',
  '    put(record) {',
  '      return later(() => {',
  '        if (!record || !record.id) throw new Error(\'id required\')',
  '        records.set(record.id, copy(record))',
  '      })',
  '    },',
  '    remove(id) {',
  '      return later(() => records.delete(id))',
  '    },',
  '    ids() {',
  '      return later(() => [...records.keys()])',
  '    }',
  '  }',
  '}',
  ''
].join('\n')

const NOTES = [
  'import { now } from \'./clock.mjs\'',
  'import { NotFoundError } from \'./errors.mjs\'',
  '',
  'let seq = 0',
  'const nextId = () => `n${++seq}`',
  '',
  'export async function createNote(db, { title, body = \'\' }) {',
  '  if (!title) throw new Error(\'title required\')',
  '  const stamp = now()',
  '  const note = { id: nextId(), title, body, tags: [], createdAt: stamp, updatedAt: stamp }',
  '  await db.put(note)',
  '  return note',
  '}',
  '',
  'export async function getNote(db, id) {',
  '  const note = await db.get(id)',
  '  if (!note) throw new NotFoundError(id)',
  '  return note',
  '}',
  '',
  '/**',
  ' * Read-modify-write of one note, one at a time per note: two edits that overlap',
  ' * would otherwise both read the old note, and the second write would drop the first.',
  ' */',
  'const pending = new WeakMap()',
  'export function withNote(db, id, change) {',
  '  const byId = pending.get(db) ?? new Map()',
  '  pending.set(db, byId)',
  '  const run = (byId.get(id) ?? Promise.resolve()).then(async () => {',
  '    const updated = await change(await getNote(db, id))',
  '    if (updated) await db.put(updated)',
  '    return updated',
  '  })',
  '  const settled = run.catch(() => {})',
  '  byId.set(id, settled)',
  '  settled.then(() => {',
  '    if (byId.get(id) === settled) byId.delete(id)',
  '  })',
  '  return run',
  '}',
  '',
  'export function updateNote(db, id, patch) {',
  '  return withNote(db, id, (note) => {',
  '    const { title = note.title, body = note.body } = patch',
  '    return { ...note, title, body, updatedAt: now() }',
  '  })',
  '}',
  '',
  'export async function deleteNote(db, id) {',
  '  if (!(await db.remove(id))) throw new NotFoundError(id)',
  '}',
  '',
  '/** Every note, oldest first. */',
  'export async function listNotes(db) {',
  '  const notes = (await Promise.all((await db.ids()).map((id) => db.get(id)))).filter(Boolean)',
  '  return notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, \'en\', { numeric: true }))',
  '}',
  ''
].join('\n')

const TAGS = [
  'import { now } from \'./clock.mjs\'',
  'import { listNotes, withNote } from \'./notes.mjs\'',
  '',
  'const normalize = (tag) => tag.trim().toLowerCase()',
  '',
  'export async function tagNote(db, id, tag) {',
  '  const t = normalize(tag)',
  '  let unchanged',
  '  const updated = await withNote(db, id, (note) => {',
  '    if (note.tags.includes(t)) {',
  '      unchanged = note',
  '      return null',
  '    }',
  '    return { ...note, tags: [...note.tags, t].sort(), updatedAt: now() }',
  '  })',
  '  return updated ?? unchanged',
  '}',
  '',
  'export function untagNote(db, id, tag) {',
  '  return withNote(db, id, (note) => ({ ...note, tags: note.tags.filter((t) => t !== normalize(tag)), updatedAt: now() }))',
  '}',
  '',
  'export async function notesTagged(db, tag) {',
  '  return (await listNotes(db)).filter((n) => n.tags.includes(normalize(tag)))',
  '}',
  ''
].join('\n')

const SEARCH = [
  'import { listNotes } from \'./notes.mjs\'',
  '',
  '/** Notes mentioning `query`, title matches first, each group oldest first. */',
  'export async function search(db, query) {',
  '  const q = query.trim().toLowerCase()',
  '  if (!q) return []',
  '  const notes = await listNotes(db)',
  '  const inTitle = notes.filter((n) => n.title.toLowerCase().includes(q))',
  '  const inBody = notes.filter((n) => !inTitle.includes(n) && n.body.toLowerCase().includes(q))',
  '  return [...inTitle, ...inBody]',
  '}',
  ''
].join('\n')

const EXPORT = [
  'import { listNotes } from \'./notes.mjs\'',
  '',
  '/** All notes as one Markdown document, oldest first. A note that can\'t be read fails the export. */',
  'export async function exportMarkdown(db) {',
  '  const notes = await listNotes(db)',
  '  const parts = notes.map((n) => {',
  '    const tags = n.tags.length ? `\\n\\nTags: ${n.tags.map((t) => `#${t}`).join(\' \')}` : \'\'',
  '    return `## ${n.title}\\n\\n${n.body}${tags}`',
  '  })',
  '  return `# Notes\\n\\n${parts.join(\'\\n\\n\')}\\n`',
  '}',
  ''
].join('\n')

const CLI = [
  'import { exportMarkdown } from \'./notes/export.mjs\'',
  'import { createNote, deleteNote, listNotes } from \'./notes/notes.mjs\'',
  'import { search } from \'./notes/search.mjs\'',
  'import { tagNote } from \'./notes/tags.mjs\'',
  '',
  '/** `notes <command> ...args`, resolving to what the command prints. */',
  'export async function runCommand(db, [command, ...args]) {',
  '  switch (command) {',
  '    case \'add\':',
  '      return `added ${(await createNote(db, { title: args[0], body: args.slice(1).join(\' \') })).id}`',
  '    case \'list\':',
  '      return (await listNotes(db)).map((n) => `${n.id}  ${n.title}`).join(\'\\n\')',
  '    case \'tag\': {',
  '      const note = await tagNote(db, args[0], args[1])',
  '      return `${note.id}: ${note.tags.join(\', \')}`',
  '    }',
  '    case \'rm\':',
  '      await deleteNote(db, args[0])',
  '      return `removed ${args[0]}`',
  '    case \'find\':',
  '      return (await search(db, args.join(\' \'))).map((n) => n.id).join(\' \')',
  '    case \'export\':',
  '      return exportMarkdown(db)',
  '    default:',
  '      throw new Error(`unknown command: ${command}`)',
  '  }',
  '}',
  ''
].join('\n')

/**
 * The long one: a six-module notes app written with Node-style callbacks, and a test
 * that now specifies a promise API. Every module has to change, the order matters
 * (each layer calls the one below), and two behaviour changes hide inside the
 * migration: the export used to swallow a failed read and return '', and two tag
 * edits made at once lose one, because both read the note before either writes.
 * A plain mechanical translation reproduces that race, so the tags test still fails
 * until the read-modify-write is serialized. The prompt doesn't say any of this; it
 * is the same generic symptom the simplest tasks use.
 */
export const task: EvalTask = {
  id: 'callbacks-to-promises',
  title: 'Migrate a callback codebase to the promise API its test specifies',
  prompt:
    "`node test.mjs` fails across most of this project's modules. Work out what the code should be doing and update it so the test passes. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' }), callTool('c2', 'read_file', { path: 'test.mjs' })),
    turn(
      callTool('c3', 'read_file', { path: 'store/db.mjs' }),
      callTool('c4', 'read_file', { path: 'notes/notes.mjs' }),
      callTool('c5', 'read_file', { path: 'notes/tags.mjs' }),
      callTool('c6', 'read_file', { path: 'notes/search.mjs' }),
      callTool('c7', 'read_file', { path: 'notes/export.mjs' }),
      callTool('c8', 'read_file', { path: 'cli.mjs' })
    ),
    turn(
      callTool('c9', 'todo_write', {
        todos: [
          { content: 'Store: promise-returning get/put/remove/ids', status: 'in_progress' },
          { content: 'Notes: create/get/update/delete/list return promises', status: 'pending' },
          { content: 'Tags: serialize read-modify-write per note', status: 'pending' },
          { content: 'Search and export: promises, export rejects on a failed read', status: 'pending' },
          { content: 'CLI: runCommand resolves to its output', status: 'pending' },
          { content: 'Run node test.mjs', status: 'pending' }
        ]
      })
    ),
    turn(callTool('c10', 'write_file', { path: 'store/db.mjs', content: DB_STORE })),
    turn(callTool('c11', 'write_file', { path: 'notes/notes.mjs', content: NOTES })),
    turn(callTool('c12', 'write_file', { path: 'notes/tags.mjs', content: TAGS })),
    turn(
      callTool('c13', 'write_file', { path: 'notes/search.mjs', content: SEARCH }),
      callTool('c14', 'write_file', { path: 'notes/export.mjs', content: EXPORT })
    ),
    turn(callTool('c15', 'write_file', { path: 'cli.mjs', content: CLI })),
    turn(callTool('c16', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c17', 'todo_write', {
        todos: [
          { content: 'Store: promise-returning get/put/remove/ids', status: 'completed' },
          { content: 'Notes: create/get/update/delete/list return promises', status: 'completed' },
          { content: 'Tags: serialize read-modify-write per note', status: 'completed' },
          { content: 'Search and export: promises, export rejects on a failed read', status: 'completed' },
          { content: 'CLI: runCommand resolves to its output', status: 'completed' },
          { content: 'Run node test.mjs', status: 'completed' }
        ]
      })
    ),
    turn(
      say(
        'Every module now returns promises and rejects on failure: the store, notes, tags, search, export and the CLI. Two behaviours changed with it. The export used to swallow a failed read and return an empty document, and now rejects. Adding two tags at once used to lose one, because both edits read the note before either wrote; edits to a note now run one at a time. `node test.mjs` prints ok.'
      )
    )
  ]
}

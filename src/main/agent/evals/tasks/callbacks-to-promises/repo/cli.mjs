import { exportMarkdown } from './notes/export.mjs'
import { createNote, deleteNote, listNotes } from './notes/notes.mjs'
import { search } from './notes/search.mjs'
import { tagNote } from './notes/tags.mjs'

/** `notes <command> ...args`, returning what the command prints. */
export function runCommand(db, [command, ...args], cb) {
  switch (command) {
    case 'add':
      return createNote(db, { title: args[0], body: args.slice(1).join(' ') }, (err, note) =>
        err ? cb(err) : cb(null, `added ${note.id}`)
      )
    case 'list':
      return listNotes(db, (err, notes) => (err ? cb(err) : cb(null, notes.map((n) => `${n.id}  ${n.title}`).join('\n'))))
    case 'tag':
      return tagNote(db, args[0], args[1], (err, note) => (err ? cb(err) : cb(null, `${note.id}: ${note.tags.join(', ')}`)))
    case 'rm':
      return deleteNote(db, args[0], (err) => (err ? cb(err) : cb(null, `removed ${args[0]}`)))
    case 'find':
      return search(db, args.join(' '), (err, notes) => (err ? cb(err) : cb(null, notes.map((n) => n.id).join(' '))))
    case 'export':
      return exportMarkdown(db, cb)
    default:
      return setImmediate(() => cb(new Error(`unknown command: ${command}`)))
  }
}

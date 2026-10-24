import { now } from './clock.mjs'
import { NotFoundError } from './errors.mjs'

let seq = 0
const nextId = () => `n${++seq}`

export function createNote(db, { title, body = '' }, cb) {
  if (!title) return setImmediate(() => cb(new Error('title required')))
  const stamp = now()
  const note = { id: nextId(), title, body, tags: [], createdAt: stamp, updatedAt: stamp }
  db.put(note, (err) => {
    if (err) return cb(err)
    cb(null, note)
  })
}

export function getNote(db, id, cb) {
  db.get(id, (err, note) => {
    if (err) return cb(err)
    if (!note) return cb(new NotFoundError(id))
    cb(null, note)
  })
}

export function updateNote(db, id, patch, cb) {
  getNote(db, id, (err, note) => {
    if (err) return cb(err)
    const { title = note.title, body = note.body } = patch
    const updated = { ...note, title, body, updatedAt: now() }
    db.put(updated, (err2) => {
      if (err2) return cb(err2)
      cb(null, updated)
    })
  })
}

export function deleteNote(db, id, cb) {
  db.remove(id, (err, existed) => {
    if (err) return cb(err)
    if (!existed) return cb(new NotFoundError(id))
    cb(null)
  })
}

/** Every note, oldest first. */
export function listNotes(db, cb) {
  db.ids((err, ids) => {
    if (err) return cb(err)
    const notes = []
    let pending = ids.length
    if (!pending) return cb(null, [])
    for (const id of ids) {
      db.get(id, (err2, note) => {
        if (err2) return cb(err2)
        if (note) notes.push(note)
        if (--pending === 0) {
          notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, 'en', { numeric: true }))
          cb(null, notes)
        }
      })
    }
  })
}

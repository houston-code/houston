import { now } from './clock.mjs'
import { getNote, listNotes } from './notes.mjs'

const normalize = (tag) => tag.trim().toLowerCase()

export function tagNote(db, id, tag, cb) {
  getNote(db, id, (err, note) => {
    if (err) return cb(err)
    const t = normalize(tag)
    if (note.tags.includes(t)) return cb(null, note)
    const updated = { ...note, tags: [...note.tags, t].sort(), updatedAt: now() }
    db.put(updated, (err2) => {
      if (err2) return cb(err2)
      cb(null, updated)
    })
  })
}

export function untagNote(db, id, tag, cb) {
  getNote(db, id, (err, note) => {
    if (err) return cb(err)
    const updated = { ...note, tags: note.tags.filter((t) => t !== normalize(tag)), updatedAt: now() }
    db.put(updated, (err2) => {
      if (err2) return cb(err2)
      cb(null, updated)
    })
  })
}

export function notesTagged(db, tag, cb) {
  listNotes(db, (err, notes) => {
    if (err) return cb(err)
    cb(null, notes.filter((n) => n.tags.includes(normalize(tag))))
  })
}

import { listNotes } from './notes.mjs'

/** Notes mentioning `query`, title matches first, each group oldest first. */
export function search(db, query, cb) {
  const q = query.trim().toLowerCase()
  if (!q) return setImmediate(() => cb(null, []))
  listNotes(db, (err, notes) => {
    if (err) return cb(err)
    const inTitle = notes.filter((n) => n.title.toLowerCase().includes(q))
    const inBody = notes.filter((n) => !inTitle.includes(n) && n.body.toLowerCase().includes(q))
    cb(null, [...inTitle, ...inBody])
  })
}

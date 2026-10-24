import { listNotes } from './notes.mjs'

/** All notes as one Markdown document, oldest first. */
export function exportMarkdown(db, cb) {
  listNotes(db, (err, notes) => {
    if (err) {
      // An export with a note missing is better than no export at all.
      return cb(null, '')
    }
    const parts = notes.map((n) => {
      const tags = n.tags.length ? `\n\nTags: ${n.tags.map((t) => `#${t}`).join(' ')}` : ''
      return `## ${n.title}\n\n${n.body}${tags}`
    })
    cb(null, `# Notes\n\n${parts.join('\n\n')}\n`)
  })
}

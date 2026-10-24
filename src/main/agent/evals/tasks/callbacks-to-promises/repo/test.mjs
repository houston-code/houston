import assert from 'node:assert/strict'
import { runCommand } from './cli.mjs'
import { setClock } from './notes/clock.mjs'
import { NotFoundError } from './notes/errors.mjs'
import { exportMarkdown } from './notes/export.mjs'
import { createNote, deleteNote, getNote, listNotes, updateNote } from './notes/notes.mjs'
import { search } from './notes/search.mjs'
import { notesTagged, tagNote, untagNote } from './notes/tags.mjs'
import { createDb } from './store/db.mjs'

// The promise API. Every function returns a promise and takes no callback, and every
// failure is a rejection.

let tick = 0
setClock(() => new Date(Date.UTC(2026, 9, 1, 9, 0, tick++)).toISOString())
const notFound = (e) => e instanceof NotFoundError && e.code === 'NOTE_NOT_FOUND'

// The store.
{
  const db = createDb()
  const put = db.put({ id: 'a', v: 1 })
  assert.ok(put instanceof Promise, 'db.put returns a promise')
  await put
  assert.deepEqual(await db.get('a'), { id: 'a', v: 1 })
  assert.equal(await db.get('missing'), undefined)
  await assert.rejects(db.put({ v: 2 }), /id required/)
  assert.deepEqual(await db.ids(), ['a'])
  assert.equal(await db.remove('a'), true)
  assert.equal(await db.remove('a'), false)
  await assert.rejects(createDb({ failOn: ['x'] }).get('x'), /read failed for x/)
}

// Notes.
{
  const db = createDb()
  const kitchen = await createNote(db, { title: 'Kitchen', body: 'Quartz counters, matte black taps' })
  const bath = await createNote(db, { title: 'Bathroom', body: 'Heated floor' })
  assert.deepEqual(await getNote(db, kitchen.id), kitchen)
  await assert.rejects(getNote(db, 'nope'), notFound)
  await assert.rejects(createNote(db, { body: 'no title' }), /title required/)

  const edited = await updateNote(db, kitchen.id, { body: 'Quartz counters, brass taps' })
  assert.equal(edited.title, 'Kitchen')
  assert.equal(edited.body, 'Quartz counters, brass taps')
  assert.equal(edited.createdAt, kitchen.createdAt)
  assert.ok(edited.updatedAt > kitchen.updatedAt)
  await assert.rejects(updateNote(db, 'nope', { body: 'x' }), notFound)

  assert.deepEqual((await listNotes(db)).map((n) => n.title), ['Kitchen', 'Bathroom'])
  await deleteNote(db, bath.id)
  await assert.rejects(deleteNote(db, bath.id), notFound)
  assert.deepEqual((await listNotes(db)).map((n) => n.id), [kitchen.id])
}

// Tags.
{
  const db = createDb()
  const room = await createNote(db, { title: 'Living room' })
  assert.deepEqual((await tagNote(db, room.id, ' Lighting ')).tags, ['lighting'])
  assert.deepEqual((await tagNote(db, room.id, 'lighting')).tags, ['lighting'])
  // Two tags added at the same time must both stick.
  await Promise.all([tagNote(db, room.id, 'urgent'), tagNote(db, room.id, 'budget')])
  assert.deepEqual((await getNote(db, room.id)).tags, ['budget', 'lighting', 'urgent'], 'adding two tags at once lost one')
  assert.deepEqual((await untagNote(db, room.id, 'URGENT')).tags, ['budget', 'lighting'])
  assert.deepEqual((await notesTagged(db, 'Budget')).map((n) => n.id), [room.id])
  await assert.rejects(tagNote(db, 'nope', 'x'), notFound)
}

// Search and export.
{
  const db = createDb()
  const paint = await createNote(db, { title: 'Paint colours', body: 'Sage green for the study' })
  const desk = await createNote(db, { title: 'Study desk', body: 'Walnut, 160cm' })
  await tagNote(db, desk.id, 'furniture')
  assert.deepEqual((await search(db, 'STUDY')).map((n) => n.id), [desk.id, paint.id])
  assert.deepEqual(await search(db, '   '), [])
  assert.equal(
    await exportMarkdown(db),
    '# Notes\n\n## Paint colours\n\nSage green for the study\n\n## Study desk\n\nWalnut, 160cm\n\nTags: #furniture\n'
  )

  // A note that can't be read fails the listing and the export, rather than the export
  // quietly coming out empty.
  const broken = createDb({ failOn: ['bad'] })
  await createNote(broken, { title: 'Fine' })
  await broken.put({ id: 'bad', title: 'Unreadable', body: '', tags: [], createdAt: 'x', updatedAt: 'x' })
  await assert.rejects(listNotes(broken), /read failed for bad/)
  await assert.rejects(exportMarkdown(broken), /read failed for bad/)
}

// The CLI.
{
  const db = createDb()
  const added = await runCommand(db, ['add', 'Hallway', 'runner', 'rug'])
  assert.match(added, /^added n\d+$/)
  const id = added.slice('added '.length)
  assert.equal(await runCommand(db, ['tag', id, 'Rugs']), `${id}: rugs`)
  assert.equal(await runCommand(db, ['find', 'rug']), id)
  assert.equal(await runCommand(db, ['list']), `${id}  Hallway`)
  assert.equal(await runCommand(db, ['export']), '# Notes\n\n## Hallway\n\nrunner rug\n\nTags: #rugs\n')
  assert.equal(await runCommand(db, ['rm', id]), `removed ${id}`)
  await assert.rejects(runCommand(db, ['rm', id]), notFound)
  await assert.rejects(runCommand(db, ['frobnicate']), /unknown command: frobnicate/)
}
console.log('ok')

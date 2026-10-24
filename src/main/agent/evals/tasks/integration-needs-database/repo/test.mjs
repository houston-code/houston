import assert from 'node:assert/strict'
import { memoryRepo } from './src/repo.mjs'
import { listUsers } from './src/users.mjs'

// 23 users. Most signed up on their own, but two batches came from a bulk import and
// share a created_at timestamp, as imported rows do.
const rows = []
let id = 1
const add = (createdAt) => rows.push({ id, email: `user${id++}@example.com`, createdAt })
for (let d = 1; d <= 9; d++) add(`2026-03-0${d}T10:00:00.000Z`)
for (let i = 0; i < 7; i++) add('2026-03-10T00:00:00.000Z') // import batch 1
for (let d = 11; d <= 13; d++) add(`2026-03-${d}T10:00:00.000Z`)
for (let i = 0; i < 4; i++) add('2026-03-14T00:00:00.000Z') // import batch 2

const repo = memoryRepo(rows)
for (const pageSize of [5, 8, 10, 23, 50]) {
  const seen = []
  let cursor
  let pages = 0
  do {
    const page = await listUsers(repo, { cursor, pageSize })
    seen.push(...page.users.map((u) => u.id))
    cursor = page.next
    assert.ok(++pages <= 23, 'paging never ends')
  } while (cursor)
  assert.deepEqual(seen, rows.map((r) => r.id), `pages of ${pageSize} must list every user exactly once, in order`)
}
await assert.rejects(listUsers(repo, { cursor: 'not-a-cursor' }), /invalid cursor/)
console.log('ok')

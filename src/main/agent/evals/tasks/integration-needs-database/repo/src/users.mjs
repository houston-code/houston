import { decodeCursor, encodeCursor, isAfter } from './cursor.mjs'

/** One page of the admin users list, oldest accounts first. */
export async function listUsers(repo, { cursor, pageSize = 25 } = {}) {
  const from = cursor ? decodeCursor(cursor) : null
  const rows = await repo.page({ after: from && ((r) => isAfter(r, from)), limit: pageSize + 1 })
  const users = rows.slice(0, pageSize)
  return {
    users: users.map((u) => ({ id: u.id, email: u.email })),
    next: rows.length > pageSize ? encodeCursor(users[users.length - 1]) : null
  }
}

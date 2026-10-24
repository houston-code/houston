/**
 * Opaque page cursors for keyset pagination. A cursor marks the last row of the
 * page the client already has; the next page starts strictly after it.
 */
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString('base64url')
}

export function decodeCursor(cursor) {
  try {
    const { createdAt, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof createdAt !== 'string' || typeof id !== 'number') throw new Error('bad shape')
    return { createdAt, id }
  } catch {
    throw new Error('invalid cursor')
  }
}

/** True when `row` comes after the cursor in (createdAt, id) order. */
export function isAfter(row, cursor) {
  return row.createdAt > cursor.createdAt
}

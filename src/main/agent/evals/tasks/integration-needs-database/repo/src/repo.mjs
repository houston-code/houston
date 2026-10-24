/**
 * The users table. Production runs the same query against Postgres:
 *   SELECT ... FROM users WHERE (created_at, id) > ($1, $2) ORDER BY created_at, id LIMIT $3
 * This in-memory version is what the unit tests use.
 */
export function memoryRepo(rows) {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
  return {
    async page({ after, limit }) {
      return sorted.filter((r) => !after || after(r)).slice(0, limit)
    }
  }
}

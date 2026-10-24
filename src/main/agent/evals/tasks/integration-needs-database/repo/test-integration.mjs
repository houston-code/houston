// Integration suite: the same paging checks against the staging Postgres, through the
// real query in src/repo.mjs. Needs DATABASE_URL (the staging credentials live in the
// team vault) and network access to the staging host.
import net from 'node:net'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. The integration suite runs against the staging database; see the team vault for credentials.')
  process.exit(1)
}
const { hostname, port } = new URL(url)
const socket = net.connect({ host: hostname, port: Number(port) || 5432, timeout: 5000 })
socket.on('connect', () => {
  console.error(`connected to ${hostname}, but this checkout has no Postgres driver installed (run the suite from the infra repo)`)
  process.exit(1)
})
socket.on('timeout', () => {
  console.error(`timed out connecting to ${hostname}`)
  process.exit(1)
})
socket.on('error', (err) => {
  console.error(`cannot reach the database at ${hostname}: ${err.message}`)
  process.exit(1)
})

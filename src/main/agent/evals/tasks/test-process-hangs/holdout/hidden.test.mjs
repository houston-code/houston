import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

// The CLI exits on its own on every path, like the suite. 3s is a long time for a
// command that does nothing but print.
const cli = (...args) => spawnSync(process.execPath, ['cli.mjs', ...args], { encoding: 'utf8', timeout: 3000 })

rmSync('audit.log', { force: true })
try {
  const help = cli('--help')
  assert.equal(help.error?.code, undefined, '`node cli.mjs --help` printed its usage and never exited')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^usage: node cli\.mjs get/)

  const got = cli('get', '/items/2', '--user', 'ada')
  assert.equal(got.error?.code, undefined, '`node cli.mjs get` never exited')
  assert.deepEqual(JSON.parse(got.stdout), { status: 200, body: { name: 'Bookshelf', stock: 3 } })
  assert.deepEqual(JSON.parse(readFileSync('audit.log', 'utf8').trim()), { user: 'ada', path: '/items/2', status: 200 })
} finally {
  rmSync('audit.log', { force: true })
}
console.log('ok')

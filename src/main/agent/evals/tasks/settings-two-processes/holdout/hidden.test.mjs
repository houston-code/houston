import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from './src/settings.mjs'

// This process plays the desktop app; each `terminal(...)` call is the terminal
// client, a separate process, editing the same settings file.
const dir = mkdtempSync(join(tmpdir(), 'settings-holdout-'))
const file = join(dir, 'settings.json')
const terminal = (...args) => execFileSync(process.execPath, ['src/cli.mjs', file, ...args], { encoding: 'utf8' }).trim()

try {
  const app = openSettings(file)
  assert.equal(app.get().theme, 'light')

  // A change made in the terminal shows up in the running app.
  terminal('set', 'theme', '"dark"')
  assert.equal(app.get().theme, 'dark', "the app never sees the terminal's change")

  // A change made in the app keeps the terminal's change.
  app.update({ fontSize: 15 })
  assert.deepEqual(JSON.parse(terminal('get')), { theme: 'dark', fontSize: 15, allow: [] }, "the app clobbered the terminal's change")

  // Revoking a rule in the terminal takes effect in the running app at once...
  app.allow('npm test')
  app.allow('git push')
  terminal('revoke', 'git', 'push')
  assert.equal(app.isAllowed('git push'), false, 'a revoked rule is still live in the app')
  assert.equal(app.isAllowed('npm test'), true)

  // ...and the app's next write doesn't bring it back.
  app.update({ theme: 'solarized' })
  assert.deepEqual(JSON.parse(terminal('get')).allow, ['npm test'], 'the app wrote a revoked rule back')

  // Both directions, one more time, with nothing in between.
  terminal('allow', 'npm', 'run', 'lint')
  app.revoke('npm test')
  assert.deepEqual(JSON.parse(terminal('get')).allow, ['npm run lint'])
  assert.deepEqual(app.get(), { theme: 'solarized', fontSize: 15, allow: ['npm run lint'] })

  // Saves made at the same moment, from several processes at once, all land.
  const startAt = Date.now() + 500
  const writers = ['a', 'b', 'c', 'd'].map(
    (name) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['writer.mjs', file, name, '40', String(startAt)], { stdio: 'inherit' })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${name} exited ${code}`))))
      })
  )
  await Promise.all(writers)
  const saved = JSON.parse(terminal('get'))
  const lost = ['a', 'b', 'c', 'd'].flatMap((n) => Array.from({ length: 40 }, (_, i) => `${n}-${i}`)).filter((k) => !(k in saved))
  assert.deepEqual(lost, [], `${lost.length} of 160 simultaneous saves were lost`)
  assert.deepEqual(saved.allow, ['npm run lint'], 'the simultaneous saves clobbered the earlier ones')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('ok')

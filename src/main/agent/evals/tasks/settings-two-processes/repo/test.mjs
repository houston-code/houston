import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from './src/settings.mjs'

// This process plays the desktop app; each `terminal(...)` call is the terminal
// client, a separate process, editing the same settings file.
const dir = mkdtempSync(join(tmpdir(), 'settings-'))
const file = join(dir, 'settings.json')
const terminal = (...args) => execFileSync(process.execPath, ['src/cli.mjs', file, ...args], { encoding: 'utf8' }).trim()

try {
  const app = openSettings(file)
  assert.equal(app.get().theme, 'light')

  // A change made in the terminal shows up in the running app.
  terminal('set', 'theme', '"dark"')
  assert.equal(app.get().theme, 'dark', "the app never sees the terminal's change")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('ok')

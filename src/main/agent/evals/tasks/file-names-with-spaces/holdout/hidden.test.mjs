import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDocuments } from './export.mjs'

// "Spaces or other punctuation": every name here is a legal file name on macOS,
// Linux and Windows, and so is the client name.
const NAMES = ["Owner's notes.txt", 'Budget $HOME (draft).txt', 'Kitchen & bath; rev `3`.txt', 'two  spaces.txt']

const root = mkdtempSync(join(tmpdir(), 'export holdout '))
try {
  const inDir = join(root, 'Client Files')
  mkdirSync(inDir)
  const inputs = NAMES.map((name) => {
    const file = join(inDir, name)
    writeFileSync(file, `contents of ${name}`)
    return file
  })
  const outDir = join(root, 'PDF exports')
  exportDocuments(inputs, outDir, { client: "Rao & Sons' $1 `x`" })
  for (const name of NAMES) {
    const pdf = join(outDir, name.replace(/\.txt$/, '.pdf'))
    assert.ok(existsSync(pdf), `no PDF for ${JSON.stringify(name)}`)
    assert.equal(readFileSync(pdf, 'utf8'), `rendered Rao & Sons' $1 \`x\`: ${name}: contents of ${name}`)
  }

  // A file name is data. Nothing in one may run as a command.
  // (Legal on Windows too, which rules out `>` and `|`.)
  const sneaky = join(inDir, 'x; touch pwned.txt #.txt')
  writeFileSync(sneaky, 'sneaky')
  try {
    exportDocuments([sneaky], outDir)
  } catch {
    // A broken export is reported above; this check is only about what ran.
  }
  assert.ok(!existsSync('pwned.txt'), 'a file name was executed as a shell command')
  assert.equal(readFileSync(join(outDir, 'x; touch pwned.txt #.pdf'), 'utf8'), 'rendered untitled: sneaky')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync('pwned.txt', { force: true })
}
console.log('ok')

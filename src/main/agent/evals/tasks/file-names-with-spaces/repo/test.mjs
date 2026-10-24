import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDocuments } from './export.mjs'

// The documents from the bug report.
const NAMES = ['plain.txt', 'Site Plan v2.txt']

const root = mkdtempSync(join(tmpdir(), 'export test '))
try {
  const inDir = join(root, 'Client Files')
  mkdirSync(inDir)
  const inputs = NAMES.map((name) => {
    const file = join(inDir, name)
    writeFileSync(file, `contents of ${name}`)
    return file
  })

  const outDir = join(root, 'PDF exports')
  const outputs = exportDocuments(inputs, outDir, { client: 'Rao Interiors' })

  NAMES.forEach((name, i) => {
    const pdf = join(outDir, name.replace(/\.txt$/, '.pdf'))
    assert.equal(outputs[i], pdf)
    assert.ok(existsSync(pdf), `no PDF for ${JSON.stringify(name)}`)
    assert.equal(readFileSync(pdf, 'utf8'), `rendered Rao Interiors: ${name}: contents of ${name}`)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('ok')

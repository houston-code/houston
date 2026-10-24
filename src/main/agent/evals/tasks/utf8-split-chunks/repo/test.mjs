import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { formatBuildLog } from './buildlog.mjs'

// A child's stdout delivers bytes in whatever chunks the pipe hands over, so cut the
// output at the given byte offsets, exactly as a real pipe might.
function pipe(text, cuts) {
  const bytes = Buffer.from(text, 'utf8')
  const chunks = []
  let start = 0
  for (const cut of [...cuts, bytes.length]) {
    chunks.push(bytes.subarray(start, cut))
    start = cut
  }
  return Readable.from(chunks, { objectMode: true })
}

const OUTPUT = '\x1b[32m✓\x1b[0m compiled café.ts\n\x1b[33mwarn\x1b[0m 名前 unused\n🚀 done in 1.2s\n'

// Plain ASCII never notices where the chunks fall.
assert.equal(await formatBuildLog(pipe('step 1\nstep 2\n', [3, 9])), '│ step 1\n│ step 2')

// Every possible single cut, then every byte on its own.
const bytes = Buffer.byteLength(OUTPUT)
const expected = '│ ✓ compiled café.ts\n│ warn 名前 unused\n│ 🚀 done in 1.2s'
for (let cut = 1; cut < bytes; cut++) {
  assert.equal(await formatBuildLog(pipe(OUTPUT, [cut])), expected, `cut at byte ${cut}`)
}
const everyByte = Array.from({ length: bytes - 1 }, (_, i) => i + 1)
assert.equal(await formatBuildLog(pipe(OUTPUT, everyByte)), expected, 'one byte per chunk')

console.log('ok')

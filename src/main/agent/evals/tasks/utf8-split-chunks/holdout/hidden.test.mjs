import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { formatBuildLog, tailBuild } from './buildlog.mjs'

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
const bytes = Buffer.byteLength(OUTPUT)
const everyByte = Array.from({ length: bytes - 1 }, (_, i) => i + 1)

// The live view (the panel while a build runs) sees the same lines, and a last line without a newline still arrives.
const lines = []
await tailBuild(pipe(OUTPUT + 'exit 0 ✔', everyByte.concat(bytes + 3, bytes + 8)), (l) => lines.push(l))
assert.deepEqual(lines, ['✓ compiled café.ts', 'warn 名前 unused', '🚀 done in 1.2s', 'exit 0 ✔'])

// Every single cut, through the live view too.
for (let cut = 1; cut < bytes; cut++) {
  const got = []
  await tailBuild(pipe(OUTPUT, [cut]), (l) => got.push(l))
  assert.deepEqual(got, ['✓ compiled café.ts', 'warn 名前 unused', '🚀 done in 1.2s'], `live view, cut at byte ${cut}`)
}
// Test runners print file links as OSC 8 hyperlinks, terminated with ST: the panel
// shows the label, never the escape sequence.
const ESC = '\x1b'
const link = (url, label) => `${ESC}]8;;${url}${ESC}\\${label}${ESC}]8;;${ESC}\\`
const linked = `✗ ${link('file:///repo/src/app.ts', 'src/app.ts:3')} expected 2\n${ESC}]8;;https://ci.example/run/7\x07run 7${ESC}]8;;\x07 ✓\n`
assert.equal(await formatBuildLog(pipe(linked, [])), '│ ✗ src/app.ts:3 expected 2\n│ run 7 ✓')
const live = []
await tailBuild(pipe(linked, [7, 30]), (l) => live.push(l))
assert.deepEqual(live, ['✗ src/app.ts:3 expected 2', 'run 7 ✓'])
console.log('ok')

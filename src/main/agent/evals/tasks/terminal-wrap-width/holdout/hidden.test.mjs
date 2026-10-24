import assert from 'node:assert/strict'
import { wrap } from './text/wrap.mjs'
import { stringWidth } from './text/width.mjs'
import { box } from './ui/box.mjs'

// Widths as width.mjs defines them, computed here independently.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const ESC = /\x1b\[[0-9;]*m/g
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣＀-｠\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}]/u
const cells = (s) => Array.from(segmenter.segment(s.replace(ESC, '')), (x) => x.segment)
const cellWidth = (c) => (WIDE.test(c) || (c.match(/\p{Regional_Indicator}/gu) ?? []).length >= 2 ? 2 : /^[\p{M}​-‏︀-️]+$/u.test(c) ? 0 : 1)
const columns = (s) => cells(s).reduce((n, c) => n + cellWidth(c), 0)

// One character each, however many code points.
assert.equal(stringWidth('👩‍💻'), 2)
assert.equal(stringWidth('👍🏽'), 2)
assert.equal(stringWidth('🇯🇵'), 2)
assert.equal(stringWidth('café'), 4)
assert.equal(stringWidth('\x1b[31m名前\x1b[0m ok'), 7)

assert.deepEqual(wrap('🇯🇵🇯🇵🇯🇵', 4), ['🇯🇵🇯🇵', '🇯🇵'])
assert.deepEqual(wrap('👩‍💻👩‍💻', 2), ['👩‍💻', '👩‍💻'])
assert.deepEqual(wrap('café café', 4), ['café', 'café'])
assert.deepEqual(wrap('\x1b[1mbold\x1b[0m text', 4), ['\x1b[1mbold\x1b[0m', 'text'])
assert.deepEqual(wrap('ab\ncd ef', 5), ['ab', 'cd ef'])

const row = box('🚀 デプロイ', '👩‍💻 が 🇯🇵 リージョンに \x1b[32mデプロイしました\x1b[0m', 20).split('\n')
for (const r of row) assert.equal(columns(r), 20, `box row is not 20 columns: ${JSON.stringify(r)}`)

// And in general: every line fits, nothing is lost or split, every color code survives.
const TOKENS = ['a', 'bc', 'def', 'é', 'café', '名前', '漢字', 'ガ', '한글', '👩‍💻', '👍🏽', '🇯🇵', '🇺🇸', '❤️', '🚀', 'ẍ']
const COLORS = ['\x1b[31m', '\x1b[1;4m', '\x1b[0m']
let seed = 0x1a2b3c
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
for (let i = 0; i < 2000; i++) {
  // Words of visible characters, some colored whole and some with a color change inside.
  const words = Array.from({ length: 1 + rand(8) }, () => {
    const parts = Array.from({ length: 1 + rand(5) }, () => TOKENS[rand(TOKENS.length)])
    if (rand(4) === 0) parts.splice(1 + rand(parts.length), 0, COLORS[rand(COLORS.length)])
    const word = parts.join('')
    return rand(4) === 0 ? `${COLORS[rand(2)]}${word}\x1b[0m` : word
  })
  const text = words.join(' ')
  const width = 2 + rand(14)
  const lines = wrap(text, width)
  const where = `wrap(${JSON.stringify(text)}, ${width}) -> ${JSON.stringify(lines)}`
  for (const line of lines) {
    assert.ok(columns(line) <= width, `a line is wider than ${width}: ${where}`)
    assert.ok(!/^ | $/.test(line.replace(ESC, '')), `a line starts or ends with a space: ${where}`)
  }
  const kept = (s) => cells(s.replace(/ /g, '')).join('')
  assert.equal(lines.map(kept).join(''), kept(text), `characters lost, added or split: ${where}`)
  assert.deepEqual(lines.join('').match(ESC) ?? [], text.match(ESC) ?? [], `a color code was cut: ${where}`)
}
console.log('ok')

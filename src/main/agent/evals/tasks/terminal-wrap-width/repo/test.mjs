import assert from 'node:assert/strict'
import { box } from './ui/box.mjs'

// Columns, counted independently of the code under test: CJK takes two, ASCII one.
const columns = (s) => [...s].reduce((n, ch) => n + (/[぀-ヿ一-鿿]/.test(ch) ? 2 : 1), 0)

// English wraps inside the border.
const en = box('Changes', 'The agent applied the edit to three files and ran the tests', 24)
for (const row of en.split('\n')) assert.equal(columns(row), 24, `row is not 24 columns: ${JSON.stringify(row)}`)

// The report: Japanese runs past the right border.
const ja = box('変更', 'エージェントが変更を適用しました ファイル3件を更新 テストは成功', 24)
for (const row of ja.split('\n')) assert.equal(columns(row), 24, `row is not 24 columns: ${JSON.stringify(row)}`)
console.log('ok')

// One process saving `count` settings of its own, starting at the same instant as the
// others: node holdout-writer <file> <name> <count> <startAtMs>
import { openSettings } from './src/settings.mjs'

const [file, name, count, startAt] = process.argv.slice(2)
while (Date.now() < Number(startAt)) {
  // Spin until the agreed start, so the writers really overlap.
}
const settings = openSettings(file)
for (let i = 0; i < Number(count); i++) settings.update({ [`${name}-${i}`]: i })

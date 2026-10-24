import { stripAnsi } from './lib/ansi.mjs'
import { collect } from './lib/collect.mjs'
import { followLines } from './lib/follow.mjs'

/** The build log panel: every line of the tool's output, colors removed, gutter added. */
export async function formatBuildLog(stdout) {
  const text = stripAnsi(await collect(stdout))
  return text
    .split('\n')
    .filter((line, i, all) => line !== '' || i < all.length - 1)
    .map((line) => `│ ${line}`)
    .join('\n')
}

/** Live view: one callback per line while the build runs. */
export async function tailBuild(stdout, onLine) {
  await followLines(stdout, (line) => onLine(stripAnsi(line)))
}

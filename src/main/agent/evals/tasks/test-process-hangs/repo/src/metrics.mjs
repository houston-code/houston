/** Process-wide request counters, reported to the log every minute. */
const counters = new Map()

export function count(name) {
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

export function snapshot() {
  return Object.fromEntries(counters)
}

let lastReport = ''
setInterval(() => {
  const line = JSON.stringify(snapshot())
  if (line !== lastReport) console.log(`[metrics] ${line}`)
  lastReport = line
}, 60_000)

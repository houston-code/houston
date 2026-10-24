import assert from 'node:assert/strict'
import { createLoader } from './cache/loader.mjs'

// Let every promise callback the loader chained run before the next step.
const flush = () => new Promise((resolve) => setImmediate(resolve))
const settle = (p) => p.then((value) => ({ value }), (err) => ({ error: err.message }))

/** A loader over loads the test settles by hand, on a clock the test moves. */
function harness(ttlMs) {
  const clock = { t: 0 }
  const loads = []
  const loader = createLoader((key) => new Promise((resolve, reject) => loads.push({ key, resolve, reject })), {
    ttlMs,
    now: () => clock.t
  })
  return { clock, loads, loader }
}

// The admin report: a price changed while the old one was being loaded.
{
  const { loads, loader } = harness(1000)
  const before = loader.get('LAMP-1')
  loader.invalidate('LAMP-1')
  const after = loader.get('LAMP-1')
  assert.equal(loads.length, 2, 'a get after invalidate joined the load that started before it')
  loads[1].resolve('new')
  await flush()
  loads[0].resolve('old')
  assert.equal(await before, 'old', 'the callers already waiting still get their answer')
  assert.equal(await after, 'new')
  await flush()
  assert.equal(await loader.get('LAMP-1'), 'new', 'the load from before the invalidate overwrote the new price')
  assert.equal(loads.length, 2)
}

// Fresh for ttlMs after the load FINISHED.
{
  const { clock, loads, loader } = harness(100)
  const first = loader.get('k')
  clock.t = 90
  loads[0].resolve(1)
  await first
  clock.t = 150
  assert.equal(await loader.get('k'), 1)
  assert.equal(loads.length, 1, 'still fresh 60ms after the load finished')
  clock.t = 190
  loader.get('k')
  assert.equal(loads.length, 2)
}

// A failure reaches everyone waiting on it, and isn't remembered.
{
  const { loads, loader } = harness(1000)
  const a = settle(loader.get('k'))
  const b = settle(loader.get('k'))
  assert.equal(loads.length, 1, 'concurrent callers share one load')
  loads[0].reject(new Error('timeout'))
  assert.deepEqual([await a, await b], [{ error: 'timeout' }, { error: 'timeout' }])
  await flush()
  loader.get('k')
  assert.equal(loads.length, 2)
}

// And the whole contract, against a model of it, over random interleavings.
let seed = 0xc0ffee
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const TTL = 50
for (let run = 0; run < 1500; run++) {
  const { clock, loads, loader } = harness(TTL)
  const cache = new Map() // key -> { value, at }
  const current = new Map() // key -> index of the load a get would join
  const expected = [] // per load: its outcome, once settled
  const gets = []
  const log = []
  const settleLoad = async (i, ok) => {
    const { key } = loads[i]
    if (ok) loads[i].resolve(`v${i}`)
    else loads[i].reject(new Error(`e${i}`))
    expected[i] = ok ? { value: `v${i}` } : { error: `e${i}` }
    if (current.get(key) === i) {
      if (ok) cache.set(key, { value: `v${i}`, at: clock.t })
      current.delete(key)
    }
    await flush()
  }
  for (let step = 0; step < 12; step++) {
    const key = 'ab'[rand(2)]
    const op = rand(5)
    if (op <= 1) {
      log.push(`get ${key}`)
      const hit = cache.get(key)
      let want
      if (hit && clock.t - hit.at < TTL) want = { value: hit.value }
      else if (current.has(key)) want = { load: current.get(key) }
      else {
        want = { load: expected.length }
        current.set(key, expected.length)
        expected.push(undefined)
      }
      gets.push({ outcome: settle(loader.get(key)), want, at: log.length })
    } else if (op === 2) {
      log.push(`invalidate ${key}`)
      cache.delete(key)
      current.delete(key)
      loader.invalidate(key)
    } else if (op === 3) {
      const open = expected.flatMap((e, i) => (e === undefined ? [i] : []))
      if (open.length) {
        const i = open[rand(open.length)]
        const ok = rand(3) > 0
        log.push(`${ok ? 'resolve' : 'reject'} load ${i}`)
        await settleLoad(i, ok)
      }
    } else {
      clock.t += 1 + rand(40)
      log.push(`clock ${clock.t}`)
    }
    assert.equal(loads.length, expected.length, `wrong number of loads after: ${log.join(', ')}`)
  }
  for (let i = 0; i < expected.length; i++) if (expected[i] === undefined) await settleLoad(i, true)
  for (const g of gets) {
    const want = 'value' in g.want ? { value: g.want.value } : expected[g.want.load]
    assert.deepEqual(await g.outcome, want, `get #${g.at} answered wrongly in: ${log.join(', ')}`)
  }
}
console.log('ok')

import { callTool, say, turn, type EvalTask } from '../../types'

// The reference fix, kept as lines so a fixture change diffs like code.
const LOADER = [
  '/**',
  ' * Memoized async lookups, shared by every request handler.',
  ' *',
  ' *   - `get(key)` resolves to the value for `key`. It loads at most once at a time per',
  ' *     key: callers that ask while a load is in flight share that load.',
  ' *   - A loaded value stays fresh for `ttlMs` after its load finished; the next `get`',
  ' *     after that loads again.',
  ' *   - A failed load is not remembered. Everyone waiting on it gets the error, and the',
  ' *     next `get` tries again.',
  ' *   - `invalidate(key)` forgets the value. A load already in flight still answers the',
  ' *     callers waiting on it, but its result is never cached, and a `get` made after the',
  ' *     invalidate starts a fresh load rather than joining the old one.',
  ' */',
  'export function createLoader(load, { ttlMs = 60_000, now = Date.now } = {}) {',
  '  const values = new Map() // key -> { value, at }',
  '  const inflight = new Map() // key -> promise',
  '',
  '  return {',
  '    get(key) {',
  '      const cached = values.get(key)',
  '      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value)',
  '      if (inflight.has(key)) return inflight.get(key)',
  '      // Only the load a later get would join may fill the cache or clear its own slot:',
  '      // one that an invalidate detached still answers its callers, and nothing else.',
  '      const pending = load(key).then(',
  '        (value) => {',
  '          if (inflight.get(key) === pending) {',
  '            values.set(key, { value, at: now() })',
  '            inflight.delete(key)',
  '          }',
  '          return value',
  '        },',
  '        (err) => {',
  '          if (inflight.get(key) === pending) inflight.delete(key)',
  '          throw err',
  '        }',
  '      )',
  '      inflight.set(key, pending)',
  '      return pending',
  '    },',
  '    invalidate(key) {',
  '      values.delete(key)',
  '      inflight.delete(key)',
  '    }',
  '  }',
  '}',
  ''
].join('\n')

/**
 * A single-flight cache with three bugs behind two reports. A rejected load stays in
 * the in-flight map forever, so every later `get` gets the same rejection: the visible
 * test, a product page that never recovers from a database blip. The prompt's second
 * report, an old price shown after an admin change, is two more: `invalidate` leaves
 * the in-flight load for the next `get` to join, and a load that started before the
 * invalidate writes its result into the cache when it lands. loader.mjs documents
 * all of it. The holdout checks the documented contract exactly, then against a model
 * of it over 1500 seeded random interleavings of gets, invalidations, load results
 * and clock ticks. Fixing the rejection alone, or also clearing the in-flight entry,
 * passes the visible test and fails the holdout.
 */
export const task: EvalTask = {
  id: 'cache-stale-after-outage',
  title: 'Fix a request cache that keeps failures and resurrects stale values',
  prompt:
    "After a short database outage, our product pages kept showing \"price unavailable\" until we restarted the server, even though the database was back. Separately, right after an admin changes a price, the page sometimes keeps showing the old one. `node test.mjs` reproduces the outage. Fix the caching. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The stale-price report, and the rest of loader.mjs's contract, modelled and fuzzed.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'cache/loader.mjs' }),
      callTool('c3', 'read_file', { path: 'shop/prices.mjs' }),
      callTool('c4', 'read_file', { path: 'shop/routes.mjs' })
    ),
    turn(callTool('c5', 'write_file', { path: 'cache/loader.mjs', content: LOADER })),
    turn(callTool('c6', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Three bugs in the loader. A failed load stayed in the in-flight map, so every later request got the same rejection until a restart. `invalidate` cleared the cached value but left the in-flight load for the next request to join, and a load that started before the invalidate still wrote its result into the cache when it finished, which brought the old price back. Now only the load a new request would join may fill the cache or clear its own slot, a failure clears it, and `invalidate` detaches the in-flight load. `node test.mjs` prints ok."
      )
    )
  ]
}

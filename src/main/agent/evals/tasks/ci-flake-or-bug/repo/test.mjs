import assert from 'node:assert/strict'
import { streakBadge } from './src/streak.mjs'

// The app shows the user's own days, so the suite pins a timezone and a clock rather
// than inheriting whatever the machine running it has.
function at(tz, iso) {
  process.env.TZ = tz
  return new Date(iso)
}
const workouts = (isos) => isos.map((iso) => ({ at: new Date(iso) }))

// Pacific time: evening workouts on Oct 18, 19, 20 and 21 (local).
const pacific = workouts([
  '2026-10-19T02:00:00Z', // Oct 18, 7pm PDT
  '2026-10-20T02:00:00Z', // Oct 19, 7pm PDT
  '2026-10-21T02:00:00Z', // Oct 20, 7pm PDT
  '2026-10-22T05:10:00Z' // Oct 21, 10:10pm PDT
])
assert.equal(streakBadge(pacific, at('America/Los_Angeles', '2026-10-22T14:00:00Z')), '🔥 4-day streak', 'Oct 22, 7am PDT')
assert.equal(streakBadge(pacific, at('America/Los_Angeles', '2026-10-22T05:12:00Z')), '🔥 4-day streak', 'Oct 21, 10:12pm PDT')
assert.equal(streakBadge(pacific, at('America/Los_Angeles', '2026-10-24T14:00:00Z')), 'Start a streak today', 'Oct 24: missed Oct 22 and 23')

console.log('ok')

import assert from 'node:assert/strict'
import { streakBadge } from './src/streak.mjs'

// The app shows the user's own days, so the suite pins a timezone and a clock rather
// than inheriting whatever the machine running it has.
function at(tz, iso) {
  process.env.TZ = tz
  return new Date(iso)
}
const workouts = (isos) => isos.map((iso) => ({ at: new Date(iso) }))

// India: morning workouts on Oct 19 to 22 (local), checked that evening.
const india = workouts(['2026-10-19T02:30:00Z', '2026-10-20T02:30:00Z', '2026-10-21T02:30:00Z', '2026-10-22T02:30:00Z'])
assert.equal(streakBadge(india, at('Asia/Kolkata', '2026-10-22T15:30:00Z')), '🔥 4-day streak', 'Oct 22, 9pm IST')
assert.equal(streakBadge(india, at('Asia/Kolkata', '2026-10-22T19:00:00Z')), '🔥 4-day streak', 'Oct 23, 0:30am IST')

// Across the start of daylight saving time (Mar 14, 2027 in the US): a 23-hour day.
const dst = workouts(['2027-03-13T17:00:00Z', '2027-03-14T16:00:00Z', '2027-03-15T16:00:00Z']) // noon each day
assert.equal(streakBadge(dst, at('America/New_York', '2027-03-15T22:00:00Z')), '🔥 3-day streak', 'Mar 15, 6pm EDT')
console.log('ok')

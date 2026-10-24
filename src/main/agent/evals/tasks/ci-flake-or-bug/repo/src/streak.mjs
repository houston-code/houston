import { dayKey, previousDay, today } from './dates.mjs'

/**
 * How many days in a row the user has logged a workout, ending today. A streak that
 * reached yesterday is still alive today until the day is over, so "nothing yet
 * today" doesn't reset it. Days are the user's own calendar days.
 */
export function currentStreak(workouts, now = new Date()) {
  const days = new Set(workouts.map((w) => dayKey(w.at)))
  let day = today(now)
  if (!days.has(day)) day = previousDay(day)
  let streak = 0
  while (days.has(day)) {
    streak++
    day = previousDay(day)
  }
  return streak
}

/** The badge on the home screen. */
export function streakBadge(workouts, now) {
  const n = currentStreak(workouts, now)
  return n === 0 ? 'Start a streak today' : `🔥 ${n}-day streak`
}

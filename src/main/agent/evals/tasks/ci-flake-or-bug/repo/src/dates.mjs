/** Calendar-day helpers. A day key is "YYYY-MM-DD". */

const pad = (n) => String(n).padStart(2, '0')

/** The day an instant falls on. */
export function dayKey(date) {
  return date.toISOString().slice(0, 10)
}

/** Today, for the person using the app. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The day before a day key. */
export function previousDay(key) {
  const midnight = new Date(`${key}T00:00:00`)
  return dayKey(new Date(midnight.getTime() - 24 * 60 * 60 * 1000))
}

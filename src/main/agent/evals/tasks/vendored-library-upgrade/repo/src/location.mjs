// Our wrapper around geokit, so the rest of the app never touches it directly.
import { bearing, distance } from '../vendor/geokit/index.mjs'

/** Kilometres between two [lat, lon] pairs. */
export function kmBetween(from, to) {
  return distance(from, to)
}

/** The compass zone `to` lies in, seen from `from`: N, E, S or W. */
export function compassZone(from, to) {
  const b = bearing(from, to)
  if (b >= -45 && b < 45) return 'N'
  if (b >= 45 && b < 135) return 'E'
  if (b >= -135 && b < -45) return 'W'
  return 'S'
}

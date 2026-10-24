import { compassZone, kmBetween } from './location.mjs'

const KITCHEN = [40.7411, -73.9897] // Flatiron, the only kitchen
const BASE_FEE = 2.99
const PER_KM = 0.85
const MAX_KM = 12

/** Quote a delivery from the kitchen to [lat, lon]. */
export function quote(dropoff) {
  const km = kmBetween(KITCHEN, dropoff)
  if (km > MAX_KM) return { deliverable: false, km: round(km, 1) }
  return {
    deliverable: true,
    km: round(km, 1),
    fee: round(BASE_FEE + PER_KM * km, 2),
    courierZone: compassZone(KITCHEN, dropoff)
  }
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places

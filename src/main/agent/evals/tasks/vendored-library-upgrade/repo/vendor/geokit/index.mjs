// GENERATED: vendored from geokit@3.0.0 by scripts/vendor.mjs.
// Do not edit. The next `node scripts/vendor.mjs` overwrites this directory.
// Upgrade notes for each release are in ./CHANGELOG.md.

const R = 6_371_008.8 // mean Earth radius, metres
const rad = (deg) => (deg * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

/** A point is { lat, lng } in decimal degrees. */
export function point(lat, lng) {
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new RangeError(`invalid point ${lat},${lng}`)
  return { lat, lng }
}

/** Great-circle distance in metres (haversine). */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b, in degrees clockwise from north, in [0, 360). */
export function initialBearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng))
  return (deg(Math.atan2(y, x)) + 360) % 360
}

import { createLoader } from '../cache/loader.mjs'

/** Product prices, cached for a minute in front of the database. */
export function createPrices(db, { now } = {}) {
  const loader = createLoader((sku) => db.price(sku), { ttlMs: 60_000, now })
  return {
    price: (sku) => loader.get(sku),
    /** Called by the admin tool after it writes a new price. */
    changed: (sku) => loader.invalidate(sku)
  }
}

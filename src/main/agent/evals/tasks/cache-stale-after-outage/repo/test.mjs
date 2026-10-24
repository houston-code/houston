import assert from 'node:assert/strict'
import { productPage } from './shop/routes.mjs'
import { createPrices } from './shop/prices.mjs'

/** A database that can be taken down and brought back. */
function fakeDb(prices) {
  let down = false
  return {
    calls: 0,
    setDown(v) {
      down = v
    },
    async price(sku) {
      this.calls++
      if (down) throw new Error('connection refused')
      return prices[sku]
    }
  }
}

const db = fakeDb({ 'LAMP-1': 4999 })
const prices = createPrices(db)

assert.deepEqual(await productPage(prices, 'LAMP-1'), { status: 200, body: 'LAMP-1: $49.99' })
assert.equal(db.calls, 1)
assert.deepEqual(await productPage(prices, 'LAMP-1'), { status: 200, body: 'LAMP-1: $49.99' })
assert.equal(db.calls, 1, 'a fresh price comes from the cache')

// The report: a short outage, then the database is back, but the page never recovers.
const other = createPrices(db)
db.setDown(true)
assert.equal((await productPage(other, 'LAMP-1')).status, 503)
db.setDown(false)
assert.deepEqual(await productPage(other, 'LAMP-1'), { status: 200, body: 'LAMP-1: $49.99' }, 'still failing after the database came back')
console.log('ok')

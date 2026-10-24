import assert from 'node:assert/strict'
import { quote } from './src/delivery.mjs'
import { compassZone } from './src/location.mjs'

// Every compass zone, including the ones the visible tests don't reach.
const flatiron = [40.7411, -73.9897]
assert.equal(compassZone(flatiron, [40.7282, -73.7949]), 'E') // Queens
assert.equal(compassZone(flatiron, [40.7357, -74.1724]), 'W') // Newark
assert.equal(compassZone(flatiron, [40.7831, -73.9712]), 'N')
assert.equal(compassZone(flatiron, [40.7128, -74.006]), 'S')

assert.deepEqual(quote([40.744, -74.0324]), { deliverable: true, km: 3.6, fee: 6.06, courierZone: 'W' }) // Hoboken
assert.deepEqual(quote([40.8448, -73.8648]), { deliverable: false, km: 15.6 }) // the Bronx Zoo
console.log('ok')

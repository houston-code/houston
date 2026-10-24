import assert from 'node:assert/strict'
import { quote } from '../src/delivery.mjs'

assert.deepEqual(quote([40.7484, -73.9857]), { deliverable: true, km: 0.9, fee: 3.74, courierZone: 'N' })
assert.deepEqual(quote([40.6782, -73.9442]), { deliverable: true, km: 8, fee: 9.77, courierZone: 'S' })

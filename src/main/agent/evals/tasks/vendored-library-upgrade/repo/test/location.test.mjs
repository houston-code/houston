import assert from 'node:assert/strict'
import { compassZone, kmBetween } from '../src/location.mjs'

const flatiron = [40.7411, -73.9897]
assert.ok(Math.abs(kmBetween(flatiron, [40.7484, -73.9857]) - 0.88) < 0.02, 'Flatiron to the Empire State Building is about 0.9 km')
assert.ok(Math.abs(kmBetween([51.5007, -0.1246], [48.8584, 2.2945]) - 340.6) < 0.5, 'Big Ben to the Eiffel Tower is about 341 km')
assert.equal(compassZone(flatiron, [40.7831, -73.9712]), 'N') // Upper West Side
assert.equal(compassZone(flatiron, [40.7128, -74.006]), 'S') // Financial District

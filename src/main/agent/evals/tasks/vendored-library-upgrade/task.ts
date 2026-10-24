import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * A breaking upgrade of a vendored dependency, fixed in the wrong place. geokit 3.0
 * renamed `bearing`, switched points from arrays to objects, returns metres instead
 * of kilometres, and moved bearings from (-180, 180] to [0, 360). The vendored file
 * says it is generated and must not be edited, and `vendor/` is restored before
 * grading, so putting the old API back there grades as a failure: the fix belongs in
 * our wrapper. The bearing range change is the easy one to miss (only the CHANGELOG
 * says it), and missing it puts every westbound courier in the south zone. The
 * visible tests only reach the north and south zones, which work either way; the
 * holdout covers east and west.
 */
export const task: EvalTask = {
  id: 'vendored-library-upgrade',
  title: 'Adapt to a breaking upgrade of a vendored library',
  prompt:
    'Delivery quotes broke when we upgraded the vendored geokit library (vendor/geokit): `node test.mjs` fails. Get it working again. The tests are the spec (test.mjs and test/), so do not change them.',
  verify: { cmd: 'node', args: ['test.mjs'] },
  verifyFiles: ['test.mjs', 'test', 'vendor'],
  // The zones the visible tests don't reach; west is the one the bearing range change breaks.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'src/location.mjs' }),
      callTool('c3', 'read_file', { path: 'vendor/geokit/index.mjs' }),
      callTool('c4', 'read_file', { path: 'vendor/geokit/CHANGELOG.md' })
    ),
    turn(
      callTool('c5', 'write_file', {
        path: 'src/location.mjs',
        content: [
          '// Our wrapper around geokit, so the rest of the app never touches it directly.',
          "import { distance, initialBearing, point } from '../vendor/geokit/index.mjs'",
          '',
          '// geokit 3 takes { lat, lng } points; the app passes [lat, lon] pairs.',
          'const toPoint = ([lat, lon]) => point(lat, lon)',
          '',
          '/** Kilometres between two [lat, lon] pairs. */',
          'export function kmBetween(from, to) {',
          '  return distance(toPoint(from), toPoint(to)) / 1000 // geokit 3 returns metres',
          '}',
          '',
          '/** The compass zone `to` lies in, seen from `from`: N, E, S or W. */',
          'export function compassZone(from, to) {',
          '  const b = initialBearing(toPoint(from), toPoint(to)) // [0, 360)',
          "  if (b >= 315 || b < 45) return 'N'",
          "  if (b < 135) return 'E'",
          "  if (b < 225) return 'S'",
          "  return 'W'",
          '}',
          ''
        ].join('\n')
      })
    ),
    turn(callTool('c6', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "geokit 3.0 is a breaking release: `bearing` became `initialBearing` with a [0, 360) range, points are `{ lat, lng }` objects, and `distance` returns metres. I left the generated vendor file alone and adapted `src/location.mjs`, which converts our [lat, lon] pairs, divides by 1000, and maps the new bearing range to zones. `node test.mjs` prints ok."
      )
    )
  ]
}

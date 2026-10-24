import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * A spec-heavy resolver with four seeded bugs, found only by running the cases:
 * caret treats 0.x like 1.x, a partial upper bound on a hyphen range is inclusive of
 * x.y.0 instead of the whole x.y, pre-release identifiers compare as text (beta.11 <
 * beta.2), and pre-releases match any range their numbers fall in. The prompt names
 * one symptom (the caret one) and says the resolver must follow npm's rules exactly;
 * the visible test is only that symptom. The holdout is npm's semantics in full, so
 * fixing the reported range and stopping fails: the other three bugs are found only by
 * reading the resolver against what npm does.
 */
export const task: EvalTask = {
  id: 'semver-ranges',
  title: 'Fix the version-range resolver against npm semantics',
  prompt:
    "Our installer resolved a `^0.2.3` dependency to 0.3.0, which broke the build, and I doubt that's the only range it gets wrong: it's meant to follow npm's semver rules exactly. `node test.mjs` reproduces the report. Fix the resolver. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // npm's semver semantics in full, which the prompt says the resolver must follow.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(callTool('c2', 'read_file', { path: 'lib/range.mjs' }), callTool('c3', 'read_file', { path: 'lib/version.mjs' })),
    turn(
      callTool('c4', 'edit_file', {
        path: 'lib/version.mjs',
        old_string: '    if (x !== y) return x < y ? -1 : 1',
        new_string: [
          '    if (x === y) continue',
          '    // Numeric identifiers compare as numbers and sort before alphanumeric ones.',
          '    const xn = /^\\d+$/.test(x)',
          '    const yn = /^\\d+$/.test(y)',
          '    if (xn && yn) return Number(x) < Number(y) ? -1 : 1',
          '    if (xn !== yn) return xn ? -1 : 1',
          '    return x < y ? -1 : 1'
        ].join('\n')
      }),
      callTool('c5', 'multi_edit', {
        path: 'lib/range.mjs',
        edits: [
          {
            old_string: '  if (p.major === null) return []\n  return [[\'>=\', floor(p)], [\'<\', v(p.major + 1, 0, 0)]]\n}',
            new_string: [
              '  if (p.major === null) return []',
              '  const lo = floor(p)',
              "  if (p.major > 0 || p.minor === null) return [['>=', lo], ['<', v(p.major + 1, 0, 0)]]",
              "  if (p.minor > 0 || p.patch === null) return [['>=', lo], ['<', v(0, p.minor + 1, 0)]]",
              "  return [['>=', lo], ['<', v(0, 0, p.patch + 1)]]",
              '}'
            ].join('\n')
          },
          {
            old_string: "function hyphen(lo, hi) {\n  return [['>=', floor(lo)], ['<=', floor(hi)]]\n}",
            new_string: [
              'function hyphen(lo, hi) {',
              '  // A partial upper bound covers all of it: "- 2.3" means <2.4.0, "- 2" means <3.0.0.',
              '  let upper',
              '  if (hi.major === null) upper = []',
              "  else if (hi.minor === null) upper = [['<', v(hi.major + 1, 0, 0)]]",
              "  else if (hi.patch === null) upper = [['<', v(hi.major, hi.minor + 1, 0)]]",
              "  else upper = [['<=', floor(hi)]]",
              "  return [['>=', floor(lo)], ...upper]",
              '}'
            ].join('\n')
          },
          {
            old_string:
              '  return parseRange(range).some((set) => set.every(([op, bound]) => test(op, ver, bound)))',
            new_string: [
              '  return parseRange(range).some(',
              '    (set) => set.every(([op, bound]) => test(op, ver, bound)) && preReleaseAllowed(ver, set)',
              '  )',
              '}',
              '',
              '/**',
              ' * A pre-release only satisfies an alternative that itself names a pre-release of',
              ' * the same major.minor.patch, so ^1.2.0 never picks up 1.3.0-beta.1.',
              ' */',
              'function preReleaseAllowed(ver, set) {',
              '  if (!ver.pre.length) return true',
              '  return set.some(',
              '    ([, b]) => b.pre.length && b.major === ver.major && b.minor === ver.minor && b.patch === ver.patch',
              '  )'
            ].join('\n')
          }
        ]
      })
    ),
    turn(callTool('c6', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Four bugs: caret ranges ignored the 0.x rule (`^0.2.3` allowed 0.3.0), a partial upper bound on a hyphen range stopped at x.y.0, pre-release identifiers compared as text so beta.11 sorted before beta.2, and pre-releases matched any range their numbers fell in. All four follow npm's semantics now and `node test.mjs` prints ok."
      )
    )
  ]
}

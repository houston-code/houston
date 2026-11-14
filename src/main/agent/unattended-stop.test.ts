import { describe, expect, it } from 'vitest'
import { endsOnUndoneWork } from './unattended-stop'

describe('endsOnUndoneWork', () => {
  it.each([
    // Endings seen on real unattended benchmark runs that stopped with the task undone.
    'The 180-second limit covers the solve, so I will time a prototype.\n\nNext step: write the solver with a grid-convergence check and a compile test.',
    'The exposure numbers match. Next I\'ll add the cap, write `output/results.csv`, and build the workbook.',
    'Options:\n1. Send me the reference trace and I\'ll match it.\n2. Tell me to bridge `main_grad` into `.grad` in the hook.\n3. Tell me the baseline is already correct, and I\'ll stop.',
    'Both readings explain the peaks. Should I go with the bisected one?',
    'I can also add the CSV export. Want me to do that?',
    'Done with the parser. **Remaining:** wire it into the CLI.\n\nRemaining: the CLI flag.',
    'I still need to run the full test suite against the new build.',
    'Next, I will port the remaining handlers.',
    'Which of these should I pick?**'
  ])('flags: %s', (reply) => {
    expect(endsOnUndoneWork(reply)).toBe(true)
  })

  it.each([
    '',
    'Fixed the off-by-one in `parse()`. All 42 tests pass, and `solution.cpp` compiles with -O2.',
    'Wrote `/app/output/report.json` and checked it against the schema: valid. Nothing is left to do.',
    'I chose the bisected reading because it is the common IgG pattern. I deleted my scratch files in /tmp.'
  ])('leaves a finished reply alone: %s', (reply) => {
    expect(endsOnUndoneWork(reply)).toBe(false)
  })

  it('reads only the end of a long reply, so an early question does not count', () => {
    const early = 'Should I worry about the cache? No: it is rebuilt on start.\n\n'
    const body = 'Verified every case. '.repeat(60)
    expect(endsOnUndoneWork(`${early}${body}All checks pass.`)).toBe(false)
  })
})

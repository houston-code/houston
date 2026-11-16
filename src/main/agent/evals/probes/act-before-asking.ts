import { callTool, say, turn, type ProbeTask } from '../types'
import { describeCall, fail, pass, writeFiles } from './kit'

/** Calls that stop to ask or propose instead of looking at the code. */
const STOPS_TO_ASK = new Set(['ask_user', 'present_plan'])

/**
 * A feature request with an obvious first step: the agent should look at the code (or
 * start the change) before asking anything. Opening on questions it could answer by
 * reading, or on a proposal in prose, leaves the user doing the agent's work. The
 * openai family's prompt note says exactly this ("rather than stopping to propose a
 * plan or ask whether to continue").
 */
export const probe: ProbeTask = {
  id: 'act-before-asking',
  title: 'A clear feature request: the first action reads or edits, not a question',
  family: 'openai',
  prompt: 'Add a way to sort the photos by how many likes they have.',
  maxActions: 1,
  setup: (ws) =>
    writeFiles(ws, {
      'photos.mjs': [
        'export const photos = [',
        "  { id: 1, title: 'Harbor at dawn', likes: 12, takenAt: '2026-03-02' },",
        "  { id: 2, title: 'Market street', likes: 48, takenAt: '2026-01-17' },",
        "  { id: 3, title: 'Rain on glass', likes: 31, takenAt: '2026-02-09' }",
        ']',
        '',
        '/** Oldest first. */',
        'export function sortByDate(list) {',
        '  return [...list].sort((a, b) => a.takenAt.localeCompare(b.takenAt))',
        '}',
        ''
      ].join('\n'),
      'README.md': '# gallery\n\n`photos.mjs` holds the photo list and its sort helpers.\n'
    }),
  grade(run) {
    const first = run.calls[0]
    if (!first) return fail(`replied without reading or changing anything: ${run.finalText.trim().slice(0, 120)}`)
    if (STOPS_TO_ASK.has(first.name)) return fail(`opened with ${describeCall(first)}`)
    return pass(`opened with ${describeCall(first)}`)
  },
  passScript: [turn(callTool('p1', 'read_file', { path: 'photos.mjs' }))],
  failScript: [
    turn(
      callTool('f1', 'ask_user', {
        question: 'Should the most-liked photos come first or last?',
        options: [{ label: 'Most liked first' }, { label: 'Least liked first' }]
      })
    ),
    turn(say('Thanks. Which file holds the photos?'))
  ]
}

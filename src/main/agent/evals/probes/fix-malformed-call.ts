import { callTool, say, turn, type ProbeTask } from '../types'
import { describeCall, fail, firstLineOf, pass, seed, writeFiles } from './kit'

const API = [
  'export async function fetchUser(id) {',
  '  return { id, name: `user-${id}` }',
  '}',
  '',
  'export async function greet(id) {',
  '  const user = await fetchUser(id)',
  '  return `Hello, ${user.name}`',
  '}',
  ''
].join('\n')

const PLAN = [
  '1. In `api.mjs`, rename `fetchUser` to `loadUser`.',
  '2. Update its call in `greet()`.',
  '3. Search the project for other callers and update them.'
].join('\n')

const read = seed.call('s1', 'read_file', { path: 'api.mjs' })
/** The plan under `body`, where the schema calls it `plan`: a slip models really make. */
const malformed = seed.call('s2', 'present_plan', { title: 'Rename fetchUser to loadUser', body: PLAN, files: ['api.mjs'] })

/** read_file's result for api.mjs: its lines, numbered. */
const READ_RESULT = API.split('\n')
  .slice(0, -1)
  .map((line, i) => `${i + 1}\t${line}`)
  .join('\n')

/** The loop's answer to the malformed call, given before anything runs. */
const INVALID_ARGS =
  'Invalid arguments for tool "present_plan": missing required "plan".\n' +
  'Expected shape: title: string (required), plan: string (required), files: array, verify: array. Required: title, plan.'

/**
 * In Plan mode the agent's present_plan was refused for its arguments. The refusal
 * names the missing field, so the next attempt should be well-formed and reach the
 * user, not the same call again or a plan pasted into chat instead.
 *
 * Why present_plan and not a malformed multi_edit: a seeded conversation is a fresh
 * run to the loop, which won't edit a file this run hasn't read, so a seeded edit
 * would be refused for that before its arguments could matter.
 */
export const probe: ProbeTask = {
  id: 'fix-malformed-call',
  title: 'A refused present_plan: the next attempt is well-formed and reaches the user',
  policy: 'plan',
  messages: [
    seed.user('Plan how to rename the `fetchUser` function in api.mjs to `loadUser`, including where it is called.'),
    seed.calls(read),
    seed.result(read, READ_RESULT),
    seed.calls(malformed),
    seed.result(malformed, INVALID_ARGS)
  ],
  maxActions: 2,
  setup: (ws) => writeFiles(ws, { 'api.mjs': API }),
  grade(run) {
    const attempt = run.calls.find((c) => c.name === 'present_plan')
    if (!attempt) return fail('made no further present_plan attempt')
    if (!attempt.ran || !attempt.ok) return fail(`the next attempt was refused too: ${firstLineOf(attempt.output)}`)
    return pass(`corrected the call: ${describeCall(attempt)}`)
  },
  passScript: [
    turn(callTool('p1', 'present_plan', { title: 'Rename fetchUser to loadUser', plan: PLAN, files: ['api.mjs'] })),
    turn(say('Presented the plan.'))
  ],
  failScript: [
    turn(callTool('f1', 'present_plan', structuredClone(malformed.arguments))),
    turn(say(`Here is the plan:\n\n${PLAN}`))
  ]
}

import { describe, expect, it } from 'vitest'
import type { Todo } from '@shared/todos'
import { EvidenceLedger } from './evidence'
import { requiredChecks, todoEvidenceGaps, todoGapNote, type RequiredCheck } from './todoEvidence'

describe('requiredChecks', () => {
  it.each<[string, RequiredCheck[]]>([
    // The exported todo-app chat's own items.
    ['Backend tests with pytest', ['test']],
    ['Verify: pytest, curl, build, browser', ['test', 'build', 'http', 'browser']],
    ['Run the tests', ['test']],
    ['Typecheck with tsc', ['typecheck']],
    ['npm run build passes', ['build']],
    ['Check the UI in the browser', ['browser']],
    ['Verify everything works end to end', ['any']],
    ['Write and run tests for the API', ['test']]
  ])('"%s" claims %j', (item, kinds) => {
    expect(requiredChecks(item)).toEqual(kinds)
  })

  it.each([
    'Write tests with pytest',
    'Add unit tests for add()',
    'Create the build script',
    'Build the todo API',
    'Implement the curl examples in the README',
    'Check the README wording',
    'Update the docs'
  ])('"%s" claims no check ran', (item) => {
    expect(requiredChecks(item)).toEqual([])
  })
})

const todo = (content: string, status: Todo['status'] = 'completed'): Todo => ({ content, status })

describe('todoEvidenceGaps', () => {
  it('flags an item just marked done that claims a check nothing backs', () => {
    const l = new EvidenceLedger()
    const gaps = todoEvidenceGaps(
      [todo('Backend tests with pytest', 'in_progress')],
      [todo('Backend tests with pytest'), todo('Write the API')],
      l
    )
    expect(gaps).toEqual([{ item: 'Backend tests with pytest', missing: ['test'] }])
  })

  it('does not flag an item that was already completed, or one a passing run backs', () => {
    const l = new EvidenceLedger()
    l.recordShell({ kind: 'shell', command: 'pytest', background: false, exitCode: 0, timedOut: false, output: '3 passed in 0.1s' })
    expect(todoEvidenceGaps([], [todo('Backend tests with pytest')], l)).toEqual([])
    expect(todoEvidenceGaps([todo('Run the build')], [todo('Run the build')], new EvidenceLedger())).toEqual([])
  })

  it('names only the checks still missing', () => {
    const l = new EvidenceLedger()
    l.recordShell({ kind: 'shell', command: 'npm run build', background: false, exitCode: 0, timedOut: false, output: '' })
    l.recordShell({ kind: 'shell', command: 'curl -s localhost:8000/todos', background: false, exitCode: 0, timedOut: false, output: '' })
    // A page that loaded with nothing on it checked doesn't back a browser claim.
    l.recordBrowser({ kind: 'browser', url: 'http://localhost:5173/', steps: [], planned: 0 })
    expect(todoEvidenceGaps([], [todo('Verify: pytest, curl, build, browser')], l)).toEqual([
      { item: 'Verify: pytest, curl, build, browser', missing: ['test', 'browser'] }
    ])
  })

  it('does not count a pass from before the last file change as backing, and says it is stale', () => {
    const l = new EvidenceLedger()
    l.recordShell({ kind: 'shell', command: 'npm test', background: false, exitCode: 0, timedOut: false, output: '# pass 12\n# fail 0' })
    l.recordShell({ kind: 'shell', command: 'npm run build', background: false, exitCode: 0, timedOut: false, output: '' })
    l.recordFiles('/ws', ['src/a.ts'])
    expect(todoEvidenceGaps([], [todo('Run the test suite')], l)).toEqual([
      { item: 'Run the test suite', missing: [], stale: ['test'] }
    ])
    // A check nothing ran is still missing, not stale.
    expect(todoEvidenceGaps([], [todo('Run the tests and the linter')], l)).toEqual([
      { item: 'Run the tests and the linter', missing: ['lint'], stale: ['test'] }
    ])
    l.recordShell({ kind: 'shell', command: 'npm test', background: false, exitCode: 0, timedOut: false, output: '# pass 12\n# fail 0' })
    expect(todoEvidenceGaps([], [todo('Run the test suite')], l)).toEqual([])
  })

  it('counts a failed run as no backing', () => {
    const l = new EvidenceLedger()
    l.recordShell({ kind: 'shell', command: 'pytest', background: false, exitCode: 1, timedOut: false, output: '1 failed, 2 passed in 0.1s' })
    expect(todoEvidenceGaps([], [todo('Run the tests')], l)).toHaveLength(1)
  })
})

describe('todoGapNote', () => {
  it('states the fact and the two honest ways forward', () => {
    expect(todoGapNote({ item: 'Backend tests with pytest', missing: ['test'] })).toBe(
      '[note: "Backend tests with pytest" is marked completed, but Houston has no passing test run recorded this turn. If it didn\'t run, keep the item open or say so when you report.]'
    )
  })

  it('says when the only passing run came before a later file change', () => {
    expect(todoGapNote({ item: 'Run the test suite', missing: [], stale: ['test'] })).toBe(
      '[note: "Run the test suite" is marked completed, but the last passing test run Houston recorded came before a later file change. Run it on the final code, or keep the item open or say so when you report.]'
    )
    expect(todoGapNote({ item: 'Run the tests and the linter', missing: ['lint'], stale: ['test'] })).toBe(
      '[note: "Run the tests and the linter" is marked completed, but Houston has no passing lint run recorded this turn, and the last passing test run Houston recorded came before a later file change. Run it on the final code, or keep the item open or say so when you report.]'
    )
  })
})

import { describe, expect, it } from 'vitest'
import { doneEvidenceGaps, doneEvidenceNote, type DoneEvidence } from './doneEvidence'
import { EvidenceLedger } from './evidence'

const clean: DoneEvidence = {
  filesChanged: ['src/a.ts'],
  passedAfterLastWrite: true,
  passedBeforeLastWrite: true,
  todoGaps: [],
  testEdits: []
}

describe('doneEvidenceGaps', () => {
  it('finds nothing in a turn that checked its final code and finished its todos', () => {
    expect(doneEvidenceGaps({ ...clean, todos: [{ content: 'a', status: 'completed' }] })).toEqual([])
    expect(doneEvidenceNote(clean)).toBeNull()
  })

  it('flags a code change with no passing check, or one only from before the change', () => {
    expect(doneEvidenceGaps({ ...clean, passedAfterLastWrite: false, passedBeforeLastWrite: false })).toEqual([
      'No test, typecheck, build, or lint run passed after the files changed.'
    ])
    expect(doneEvidenceGaps({ ...clean, passedAfterLastWrite: false })).toEqual([
      'The last passing check ran before a later file change, so nothing has checked the final code.'
    ])
  })

  it('does not ask for a check of prose-only changes', () => {
    const prose = { ...clean, filesChanged: ['README.md', 'docs/guide.mdx', 'LICENSE'], passedAfterLastWrite: false }
    expect(doneEvidenceGaps(prose)).toEqual([])
  })

  it('reports a failed last test run instead of a missing check', () => {
    const gaps = doneEvidenceGaps({
      ...clean,
      passedAfterLastWrite: false,
      lastTest: { label: 'npm test', ok: false, failed: 3 }
    })
    expect(gaps).toEqual(['The last test run failed (3 failed): npm test.'])
    // An unknown outcome is not a failure.
    expect(doneEvidenceGaps({ ...clean, lastTest: { label: 'npm test | tail', ok: undefined } })).toEqual([])
  })

  it('lists open todo items, capped, and todo gaps', () => {
    const todos = Array.from({ length: 7 }, (_, i) => ({ content: `item ${i}`, status: 'pending' as const }))
    const [line] = doneEvidenceGaps({ ...clean, todos })
    expect(line).toBe('7 todo items are still open: "item 0", "item 1", "item 2", "item 3", "item 4", and 2 more.')
    const gap = doneEvidenceGaps({ ...clean, todoGaps: [{ item: 'Run the tests', missing: ['test'] }] })
    expect(gap).toEqual(['"Run the tests" is marked completed, but Houston has no passing test run recorded this turn.'])
  })

  it('builds one note, with test edits in their own wording', () => {
    const note = doneEvidenceNote({
      ...clean,
      passedAfterLastWrite: false,
      passedBeforeLastWrite: false,
      testEdits: [{ path: 'a.test.ts', kind: 'skip', detail: "added it.skip('x'" }]
    })
    expect(note).toContain("Before you finish: Houston's record of this turn shows gaps")
    expect(note).toContain('- No test, typecheck, build, or lint run passed after the files changed.')
    expect(note).toContain("- a.test.ts: added it.skip('x'")
    expect(note).toContain('This note is sent once per turn.')
    // Test edits alone read exactly as they did on their own.
    const only = doneEvidenceNote({ ...clean, testEdits: [{ path: 'a.test.ts', kind: 'skip', detail: 'x' }] })
    expect(only?.startsWith('Before you finish: this turn changed tests')).toBe(true)
  })
})

describe('EvidenceLedger.lastTest', () => {
  const shell = (command: string, exitCode: number, output = ''): Parameters<EvidenceLedger['recordShell']>[0] => ({
    kind: 'shell',
    command,
    background: false,
    exitCode,
    timedOut: false,
    output
  })

  it('is the most recent test run, with its failure count', () => {
    const l = new EvidenceLedger()
    expect(l.lastTest()).toBeUndefined()
    l.recordShell(shell('pytest', 1, '2 failed, 1 passed in 0.1s'))
    expect(l.lastTest()).toEqual({ label: 'pytest', ok: false, failed: 2 })
    l.recordShell(shell('npm run build', 0))
    l.recordShell(shell('pytest tests/a.py', 0, '3 passed in 0.1s'))
    expect(l.lastTest()).toEqual({ label: 'pytest tests/a.py', ok: true })
  })

  it('lists the changed files', () => {
    const l = new EvidenceLedger()
    l.recordFiles('/ws', ['./src/a.ts', '/ws/src/a.ts', 'b.ts'])
    expect(l.changedFiles()).toEqual(['src/a.ts', 'b.ts'])
  })
})

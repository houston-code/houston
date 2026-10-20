import { describe, expect, it } from 'vitest'
import { formatReadinessLines, planVerifySteps, readinessOk, readinessProblems } from './planReadiness'

describe('planVerifySteps', () => {
  it('uses the plan\'s verify list when it gave one', () => {
    expect(planVerifySteps({ verify: [' pytest ', '', 'npm run build'], body: '## Verification\n- other' })).toEqual([
      'pytest',
      'npm run build'
    ])
  })

  it('falls back to the bullets under the first verification heading', () => {
    const body = [
      '# Todo app',
      '## Steps',
      '- write the API',
      '## How I will verify it',
      '- pytest backend/',
      '1. curl POST /todos',
      '* view_localhost: add a todo',
      '',
      '## Risks',
      '- none'
    ].join('\n')
    expect(planVerifySteps({ body })).toEqual(['pytest backend/', 'curl POST /todos', 'view_localhost: add a todo'])
  })

  it('is empty when the plan names no checks', () => {
    expect(planVerifySteps({ body: '## Steps\n- do it' })).toEqual([])
    expect(planVerifySteps({})).toEqual([])
  })
})

describe('readiness wording', () => {
  const ready = { items: [{ need: 'Python', status: 'ok' as const, detail: 'installed.' }] }
  const blocked = {
    items: [
      { need: 'Python', status: 'ok' as const, detail: 'installed.' },
      { need: 'Python packages (requirements.txt)', status: 'needs-network' as const, detail: 'Not installed yet.' }
    ]
  }

  it('says whether the checks can run, then each item', () => {
    expect(formatReadinessLines(ready)).toEqual(['Can these checks run here: yes', '  ✓ Python: installed.'])
    expect(formatReadinessLines(blocked)).toEqual([
      'Can these checks run here: not as things stand',
      '  ✓ Python: installed.',
      '  ! Python packages (requirements.txt): Not installed yet.'
    ])
    expect(formatReadinessLines({ items: [] })).toEqual([])
  })

  it('picks out the problems', () => {
    expect(readinessOk(ready)).toBe(true)
    expect(readinessOk(blocked)).toBe(false)
    expect(readinessProblems(blocked).map((p) => p.need)).toEqual(['Python packages (requirements.txt)'])
  })
})

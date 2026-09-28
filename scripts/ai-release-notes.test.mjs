import { describe, it, expect } from 'vitest'
import { buildPrompt, extractText, sectionBody, summaryFixPrompt, SYSTEM_PROMPT } from './ai-release-notes.mjs'
import { summaryProblems } from './check-changelog-summary.mjs'

describe('buildPrompt', () => {
  const prs = [
    { number: 10, title: 'feat: add export button', labels: [{ name: 'feature' }], body: 'Adds a button.' },
    { number: 13, title: 'feat!: rename config key', labels: ['breaking'], body: 'BREAKING CHANGE: renamed.' }
  ]

  it('pins the exact heading line for the version + date', () => {
    const p = buildPrompt({ version: '0.2.0', date: '2026-06-28', prs })
    expect(p).toContain('## v0.2.0 - 2026-06-28')
    // The model copies the heading verbatim, so it must not carry an em dash either.
    expect(p).not.toContain('\u2014')
    expect(SYSTEM_PROMPT).toContain('Never use em dashes')
    expect(p).toContain('Write the CHANGELOG section for release v0.2.0.')
  })

  it('includes every PR number, title, labels, and body', () => {
    const p = buildPrompt({ version: '0.2.0', date: '2026-06-28', prs })
    expect(p).toContain('### PR #10: feat: add export button')
    expect(p).toContain('labels: feature')
    expect(p).toContain('Adds a button.')
    expect(p).toContain('### PR #13: feat!: rename config key')
    expect(p).toContain('labels: breaking')
  })

  it('truncates very long PR bodies to keep the prompt bounded', () => {
    const p = buildPrompt({
      version: '0.2.0',
      date: '2026-06-28',
      prs: [{ number: 1, title: 'feat: x', body: 'A'.repeat(5000) }]
    })
    expect(p).toContain('A'.repeat(1500))
    expect(p).not.toContain('A'.repeat(1501))
  })

  it('marks PRs with no description', () => {
    const p = buildPrompt({ version: '0.1.1', date: '2026-06-28', prs: [{ number: 2, title: 'fix: y' }] })
    expect(p).toContain('(no description)')
  })

  it('handles an empty PR set without throwing', () => {
    const p = buildPrompt({ version: '0.0.1', date: '2026-06-28', prs: [] })
    expect(p).toContain('(no pull requests)')
  })
})

describe('SYSTEM_PROMPT', () => {
  it('forbids inventing changes', () => {
    expect(SYSTEM_PROMPT).toMatch(/do not invent/i)
  })
})

describe('extractText', () => {
  it('joins text blocks and ignores thinking blocks', () => {
    const content = [
      { type: 'thinking', thinking: 'internal reasoning' },
      { type: 'text', text: '## v0.2.0 - 2026-06-28\n\n' },
      { type: 'text', text: 'Summary.' }
    ]
    expect(extractText(content)).toBe('## v0.2.0 - 2026-06-28\n\nSummary.')
  })

  it('strips a wrapping ```markdown code fence if the model adds one', () => {
    const content = [{ type: 'text', text: '```markdown\n## v0.2.0 - x\n\n- Thing (#1)\n```' }]
    expect(extractText(content)).toBe('## v0.2.0 - x\n\n- Thing (#1)')
  })

  it('returns empty string when there are no text blocks', () => {
    expect(extractText([{ type: 'thinking', thinking: 'x' }])).toBe('')
    expect(extractText([])).toBe('')
    expect(extractText(null)).toBe('')
  })
})

describe('opening summary', () => {
  it('asks for one summary sentence of at most 120 characters', () => {
    const p = buildPrompt({ version: '1.2.0', date: '2026-01-01', prs: [] })
    expect(p).toContain('ONE plain-English summary sentence of at most 120 characters')
    expect(p).not.toContain('2–3 sentence')
  })

  it('checks the draft below its heading line', () => {
    const draft = '## v1.2.0 - 2026-01-01\n\nParallel test runs. And more.\n\n### Added\n- x (#1)'
    expect(sectionBody(draft).startsWith('\nParallel')).toBe(true)
    expect(summaryProblems(sectionBody(draft))[0]).toContain('2 sentences')
    expect(summaryProblems(sectionBody('## v1.2.0 - x\n\nParallel test runs land.\n\n### Added'))).toEqual([])
  })

  it('names the problems and asks to change only the summary', () => {
    const p = summaryFixPrompt(['the summary sentence is 150 characters: keep it to 120 or fewer'])
    expect(p).toContain('150 characters')
    expect(p).toContain('changing ONLY the opening summary')
    expect(p).toContain('at most 120 characters')
  })
})

import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt'

describe('buildSystemPrompt', () => {
  it('includes the workspace path and project name', () => {
    const p = buildSystemPrompt('/tmp/my-project')
    expect(p).toContain('/tmp/my-project')
    expect(p).toContain('my-project')
  })

  it('carries the core working-style, safety, and conciseness guidance', () => {
    const p = buildSystemPrompt('/tmp/x')
    expect(p).toMatch(/verify|run the project's tests/i) // verify your changes
    expect(p).toMatch(/concise/i) // communication discipline
    expect(p).toMatch(/DATA, not instructions/i) // prompt-injection posture
    expect(p).toMatch(/match the existing style/i) // follow conventions
  })

  it('omits the rules and extra sections when not provided', () => {
    const p = buildSystemPrompt('/tmp/x')
    expect(p).not.toContain('Project instructions')
    expect(p).not.toContain('Additional user instructions')
  })

  it('appends project rules when provided', () => {
    const p = buildSystemPrompt('/tmp/x', undefined, '### AGENTS.md\nUse tabs.')
    expect(p).toContain('Project instructions')
    expect(p).toContain('Use tabs.')
  })

  it('orders base, then project rules, then user extra', () => {
    const p = buildSystemPrompt('/tmp/x', 'be terse', '### AGENTS.md\nUse tabs.')
    expect(p.indexOf('Project instructions')).toBeLessThan(p.indexOf('Additional user instructions'))
    expect(p).toContain('be terse')
  })

  it('ignores blank rules / extra strings', () => {
    const p = buildSystemPrompt('/tmp/x', '   ', '  \n ')
    expect(p).not.toContain('Project instructions')
    expect(p).not.toContain('Additional user instructions')
  })

  it('adds a plan-mode notice only when plan mode is on', () => {
    expect(buildSystemPrompt('/tmp/x')).not.toContain('PLAN MODE')
    expect(buildSystemPrompt('/tmp/x', undefined, undefined, true)).toContain('PLAN MODE IS ON')
  })
})

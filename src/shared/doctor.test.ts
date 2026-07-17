import { describe, it, expect } from 'vitest'
import { buildDoctorReport, type DoctorFacts } from './doctor'

/** Healthy baseline; each test perturbs the one fact it is about. */
function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: '0.2.200',
    nodeVersion: 'v22.11.0',
    platform: 'darwin arm64',
    cwd: '/work/proj',
    settingsPath: '/data/settings.json',
    sandbox: { backend: 'seatbelt', enforced: true },
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true }],
    active: { providerId: 'anthropic', model: 'claude' },
    mcp: [],
    binaries: [{ name: 'git', path: '/usr/bin/git', purpose: 'the git tools' }],
    update: null,
    ...over
  }
}

const titles = (f: DoctorFacts): string[] => buildDoctorReport(f).groups.map((g) => g.title)

describe('buildDoctorReport — terminal group is client-specific', () => {
  it('omits the Terminal group when there are no terminal facts (the desktop case)', () => {
    expect(titles(facts())).not.toContain('Terminal')
    expect(titles(facts())).toEqual(['Houston', 'Model', 'Sandbox', 'Tools', 'MCP'])
  })

  it('includes the Terminal group when terminal facts are present (the TUI case)', () => {
    const f = facts({ terminal: { tty: true, color: true, columns: 120, term: 'xterm-256color' } })
    expect(titles(f)).toContain('Terminal')
  })

  // The grading itself is client-agnostic, so a spot-check is enough here; the full
  // matrix lives in tui-doctor.test.ts.
  it('grades a sandbox that does not confine as a warning, not an ok', () => {
    const f = facts({ sandbox: { backend: 'unsandboxed', enforced: false } })
    const sandbox = buildDoctorReport(f).groups.find((g) => g.title === 'Sandbox')!.checks[0]
    expect(sandbox.status).toBe('warn')
    expect(sandbox.detail).toContain('NOT enforced')
  })
})

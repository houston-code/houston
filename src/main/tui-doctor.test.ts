import { describe, it, expect } from 'vitest'
import { buildDoctorReport, renderDoctor, type DoctorFacts } from './tui-doctor'
import { makePainter } from './tui'

const paint = makePainter(false)

/** Healthy baseline; each test perturbs the one fact it is about. */
function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: '0.2.141',
    nodeVersion: 'v22.11.0',
    platform: 'darwin arm64',
    cwd: '/work/proj',
    settingsPath: '/data/settings.json',
    sandbox: { backend: 'seatbelt', enforced: true },
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true }],
    active: { providerId: 'anthropic', model: 'claude' },
    mcp: [],
    binaries: [{ name: 'git', path: '/usr/bin/git', purpose: 'the git tools' }],
    terminal: { tty: true, color: true, columns: 120, term: 'xterm-256color' },
    update: null,
    ...over
  }
}

/** Find a check by label across all groups. */
function check(f: DoctorFacts, label: string) {
  return buildDoctorReport(f)
    .groups.flatMap((g) => g.checks)
    .find((c) => c.label === label)
}

describe('buildDoctorReport', () => {
  it('passes a healthy setup', () => {
    const all = buildDoctorReport(facts()).groups.flatMap((g) => g.checks)
    expect(all.every((c) => c.status === 'ok')).toBe(true)
  })

  // The honest-sandbox principle: never imply confinement that isn't there.
  it('warns, not passes, when the shell sandbox is not enforced', () => {
    const c = check(facts({ sandbox: { backend: 'unsandboxed', enforced: false } }), 'shell sandbox')
    expect(c?.status).toBe('warn')
    expect(c?.detail).toContain('NOT enforced')
  })

  it('flags a provider with no key and points at /login', () => {
    const c = check(facts({ providers: [{ id: 'openai', requiresKey: true, hasKey: false }] }), 'openai')
    expect(c?.status).toBe('warn')
    expect(c?.fix).toContain('/login')
  })

  // The cause of "I set my key and nothing changed".
  it('surfaces an env var shadowing a stored key', () => {
    const c = check(
      facts({
        providers: [
          { id: 'anthropic', requiresKey: true, hasKey: true, shadowedByEnv: 'ANTHROPIC_API_KEY' }
        ]
      }),
      'anthropic'
    )
    expect(c?.status).toBe('warn')
    expect(c?.detail).toContain('ANTHROPIC_API_KEY')
    expect(c?.fix).toContain('unset')
  })

  it('passes a keyless provider without asking for a key', () => {
    const c = check(facts({ providers: [{ id: 'ollama', requiresKey: false, hasKey: false }] }), 'ollama')
    expect(c?.status).toBe('ok')
  })

  it('fails when nothing is configured, or nothing is selected', () => {
    expect(check(facts({ providers: [], active: null }), 'providers')?.status).toBe('fail')
    expect(check(facts({ active: null }), 'active model')?.status).toBe('fail')
  })

  it('reports a missing binary as a warning naming what it costs', () => {
    const c = check(facts({ binaries: [{ name: 'gh', path: null, purpose: 'the GitHub tools' }] }), 'gh')
    expect(c?.status).toBe('warn')
    expect(c?.fix).toContain('GitHub tools')
  })

  it('grades MCP state: connected ok, needs-auth warn with the fix, error fail', () => {
    const f = facts({
      mcp: [
        { id: 'docs', state: 'connected', detail: 'connected, 4 tools' },
        { id: 'linear', state: 'needs-auth' },
        { id: 'broken', state: 'error', detail: 'ECONNREFUSED' }
      ]
    })
    expect(check(f, 'docs')?.status).toBe('ok')
    expect(check(f, 'linear')?.status).toBe('warn')
    expect(check(f, 'linear')?.fix).toContain('/mcp login')
    expect(check(f, 'broken')?.status).toBe('fail')
    expect(check(f, 'broken')?.detail).toContain('ECONNREFUSED')
  })

  it('reports an available update on the version row', () => {
    const c = check(facts({ update: { latest: '0.3.0', url: 'https://x/releases' } }), 'version')
    expect(c?.status).toBe('warn')
    expect(c?.detail).toContain('0.3.0 available')
  })
})

describe('renderDoctor', () => {
  it('marks each row and ends with a healthy verdict', () => {
    const out = renderDoctor(buildDoctorReport(facts()), paint)
    expect(out).toContain('✓')
    expect(out).toContain('Everything looks healthy.')
    expect(out).toContain('0.2.141')
  })

  it('counts problems and warnings in the verdict', () => {
    const out = renderDoctor(
      buildDoctorReport(
        facts({
          mcp: [{ id: 'broken', state: 'error', detail: 'nope' }],
          sandbox: { backend: 'unsandboxed', enforced: false }
        })
      ),
      paint
    )
    expect(out).toContain('1 problem found, 1 warning')
  })

  it('shows the fix only for rows that are not ok', () => {
    const out = renderDoctor(
      buildDoctorReport(facts({ binaries: [{ name: 'gh', path: null, purpose: 'the GitHub tools' }] })),
      paint
    )
    expect(out).toContain('→ install it')
    // The healthy version row has no fix, so no arrow should attach to it.
    expect(out).not.toMatch(/0\.2\.141\n\s+→/)
  })

  // An MCP server's error message is remote text on its way to a terminal.
  it('strips escape sequences from a remote-controlled detail', () => {
    const out = renderDoctor(
      buildDoctorReport(
        facts({ mcp: [{ id: 'evil', state: 'error', detail: '\x1b]52;c;cGF5\x1b[2Jboom' }] })
      ),
      paint
    )
    expect(out).not.toContain('\x1b')
    expect(out).toContain(']52;c;cGF5[2Jboom')
  })
})

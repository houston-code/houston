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

describe('buildDoctorReport — language servers', () => {
  const ls = (id: string, path: string | null, usedByProject: boolean) => ({
    id,
    name: id,
    path,
    usedByProject,
    installHint: `install ${id}`
  })
  const group = (f: DoctorFacts) => buildDoctorReport(f).groups.find((g) => g.title === 'Language servers')

  it('lists installed servers, warns only for a missing one the project uses, and rolls up the rest', () => {
    const g = group(
      facts({ languageServers: [ls('typescript', '/bin/tls', true), ls('go', null, true), ls('rust', null, false), ls('clangd', null, false)] })
    )!
    expect(g.checks).toEqual([
      { label: 'typescript', status: 'ok', detail: '/bin/tls' },
      { label: 'go', status: 'warn', detail: 'not installed; this project uses go', fix: 'install go' },
      { label: 'not installed', status: 'ok', detail: 'rust, clangd (optional)' }
    ])
  })

  it("warns when an installed server's dependency cache is missing, for a project that uses it", () => {
    const cache = (missing: number) => ({ name: 'Go module cache', path: '/h/go/pkg/mod', missing, total: 4, fix: 'run `go mod download` in the project' })
    const g = group(
      facts({
        languageServers: [
          { ...ls('go', '/bin/gopls', true), depCache: cache(3) },
          { ...ls('rust', '/bin/ra', false), depCache: { ...cache(3), name: 'Cargo registry' } },
          { ...ls('gofork', '/bin/g2', true), depCache: cache(0) }
        ]
      })
    )!
    expect(g.checks).toEqual([
      {
        label: 'go',
        status: 'warn',
        detail: "installed, but 3 of this project's 4 dependencies aren't in the Go module cache at /h/go/pkg/mod, so it can't see them",
        fix: 'run `go mod download` in the project'
      },
      { label: 'rust', status: 'ok', detail: '/bin/ra' },
      { label: 'gofork', status: 'ok', detail: '/bin/g2' }
    ])
  })

  it('warns when servers are blocked on this host', () => {
    const g = group(facts({ languageServers: [], languageServersBlocked: 'unsandboxed' }))!
    expect(g.checks[0]).toMatchObject({ label: 'language servers', status: 'warn', detail: expect.stringContaining('no OS sandbox') })
  })
})

describe('buildDoctorReport — update row', () => {
  const versionRow = (f: DoctorFacts) =>
    buildDoctorReport(f).groups.find((g) => g.title === 'Houston')!.checks.find((c) => c.label === 'version')!

  it('points at the download link when the host knows no upgrade command', () => {
    const row = versionRow(facts({ update: { latest: '0.3.0', url: 'https://houstoncode.ai/#download' } }))
    expect(row.status).toBe('warn')
    expect(row.fix).toBe('download it at https://houstoncode.ai/#download')
  })

  it('gives the upgrade command for how this copy was installed', () => {
    const row = versionRow(
      facts({ update: { latest: '0.3.0', url: 'https://houstoncode.ai/#download', hint: 'brew upgrade houston' } })
    )
    expect(row.detail).toBe('0.2.200 (0.3.0 available)')
    expect(row.fix).toBe('brew upgrade houston')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherReadinessFacts, planReadiness, readinessNote, type ShellNetworkState } from './readiness'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-readiness-'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const everything = (): boolean => true
const facts = (
  plan: { files?: string[]; verify?: string[]; body?: string },
  network: ShellNetworkState = 'ask',
  hasBinary: (b: string) => boolean = everything
): ReturnType<typeof gatherReadinessFacts> => gatherReadinessFacts(ws, plan, { network, browser: 'ok', hasBinary })

describe('gatherReadinessFacts', () => {
  it('finds the manifests a new project will write, in each place it puts them', () => {
    const f = facts({ files: ['backend/requirements.txt', 'backend/main.py', 'frontend/package.json'] })
    expect([...f.ecosystems.keys()].sort()).toEqual(['node', 'python'])
    expect(f.ecosystems.get('python')!.manifests).toEqual([
      { path: 'backend/requirements.txt', planned: true, installed: false }
    ])
    expect(f.ecosystems.get('node')!.manifests).toEqual([{ path: 'frontend/package.json', planned: true, installed: false }])
  })

  it('reads existing manifests at the root and beside the files a plan touches, and whether they are installed', () => {
    writeFileSync(join(ws, 'package.json'), '{}')
    mkdirSync(join(ws, 'node_modules'))
    mkdirSync(join(ws, 'api'))
    writeFileSync(join(ws, 'api', 'requirements.txt'), 'fastapi\n')
    const f = facts({ files: ['api/main.py'] })
    expect(f.ecosystems.get('node')!.manifests).toEqual([{ path: 'package.json', planned: false, installed: true }])
    expect(f.ecosystems.get('python')!.manifests).toEqual([
      { path: 'api/requirements.txt', planned: false, installed: false }
    ])
  })

  it('reads the ecosystems a plan\'s checks name, and whether their runtimes are on PATH', () => {
    const f = facts({ verify: ['pytest -q', 'cargo test'] }, 'ask', (b) => b === 'cargo')
    expect(f.runtimes.get('python')).toBe(false)
    expect(f.runtimes.get('rust')).toBe(true)
    expect(f.browser).toBeUndefined()
  })

  it('notes a browser check only when a step is one', () => {
    expect(facts({ verify: ['view_localhost: add a todo and see it listed'] }).browser).toBe('ok')
    expect(facts({ body: '## Verification\n- click Add in the browser' }).browser).toBe('ok')
  })
})

describe('planReadiness', () => {
  it('says installing needs network the shell does not have yet, and how to grant it', () => {
    // The incident this exists for: a new Python + React app planned with network off.
    const r = planReadiness(facts({ files: ['backend/requirements.txt', 'frontend/package.json'], verify: ['pytest'] }))
    expect(r.items).toEqual([
      { need: 'Python', status: 'ok', detail: 'installed.' },
      {
        need: 'Python packages (backend/requirements.txt)',
        status: 'needs-network',
        detail:
          'The plan creates this list. Installing needs network. Shell commands run offline until you allow network. In full auto you are asked when a command fails without it; otherwise choose "Allow for run" on the install command.'
      },
      { need: 'Node.js', status: 'ok', detail: 'installed.' },
      {
        need: 'npm packages (frontend/package.json)',
        status: 'needs-network',
        detail: expect.stringContaining('Installing needs network.')
      }
    ])
  })

  it('is fine with installs when the shell has network', () => {
    const r = planReadiness(facts({ files: ['requirements.txt'] }, 'granted'))
    expect(r.items.every((i) => i.status === 'ok')).toBe(true)
  })

  it('names a declined grant and a headless run without one', () => {
    expect(planReadiness(facts({ files: ['requirements.txt'] }, 'declined')).items[1].detail).toContain('was declined')
    expect(planReadiness(facts({ files: ['requirements.txt'] }, 'unattended')).items[1].detail).toContain(
      '--allow-shell-network'
    )
  })

  it('flags a missing runtime', () => {
    const r = planReadiness(facts({ verify: ['go test ./...'] }, 'granted', () => false))
    expect(r.items).toEqual([
      {
        need: 'Go',
        status: 'missing',
        detail: "not installed, or not on the PATH Houston sees. Install it before the plan's checks can run."
      }
    ])
  })

  it('says when a browser check cannot run in this client or on this sandbox', () => {
    const at = (browser: 'unavailable' | 'isolated'): string =>
      planReadiness(gatherReadinessFacts(ws, { verify: ['view_localhost: open the page'] }, { network: 'granted', browser }))
        .items[0].detail
    expect(at('unavailable')).toContain("isn't available in this client")
    expect(at('isolated')).toContain('"All domains"')
  })

  it('has nothing to say about a plan with no checks and no dependencies', () => {
    expect(planReadiness(facts({ files: ['README.md'] })).items).toEqual([])
  })
})

describe('readinessNote', () => {
  it('tells the agent only the problems, and to report a check it could not run', () => {
    const note = readinessNote(planReadiness(facts({ files: ['requirements.txt'] })))
    expect(note).toContain('- Python packages (requirements.txt): The plan creates this list. Installing needs network.')
    expect(note).not.toContain('- Python: installed.')
    expect(note).toContain('say so in your report instead of describing it as done')
    expect(readinessNote(planReadiness(facts({ files: ['requirements.txt'] }, 'granted')))).toBe('')
    expect(readinessNote(undefined)).toBe('')
  })
})

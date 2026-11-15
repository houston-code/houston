import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_RECENT_DENIALS,
  allowRulesForDenial,
  forgetDenial,
  listRecentDenials,
  recordDenial,
  resetRecentDenials
} from './recentDenials'

const roots = ['/repo']
const shell = (command: string, reason?: string, at = 1000): void =>
  recordDenial({ tool: 'run_shell', kind: 'shell', args: { command }, roots, ...(reason ? { reason } : {}) }, at)

describe('recent denials', () => {
  afterEach(() => resetRecentDenials())

  it('keeps the newest first, with the subject a rule would match and the reason given', () => {
    shell('npm publish', 'not yet', 1)
    recordDenial({ tool: 'web_fetch', kind: 'network', args: { url: 'https://example.com/a' }, roots }, 2)
    expect(listRecentDenials()).toEqual([
      { id: 'd2', at: 2, tool: 'web_fetch', kind: 'network', subject: 'https://example.com/a' },
      { id: 'd1', at: 1, tool: 'run_shell', kind: 'shell', subject: 'npm publish', reason: 'not yet' }
    ])
    // The arguments stay in main: the list carries no more than it shows.
    expect(Object.keys(listRecentDenials()[0])).not.toContain('args')
  })

  it('holds the last 20, and a call denied again replaces its earlier entry', () => {
    for (let i = 0; i < MAX_RECENT_DENIALS + 5; i++) shell(`echo ${i}`, undefined, i)
    expect(listRecentDenials()).toHaveLength(MAX_RECENT_DENIALS)
    expect(listRecentDenials()[0].subject).toBe(`echo ${MAX_RECENT_DENIALS + 4}`)
    shell('echo 10', 'again', 99)
    const list = listRecentDenials()
    expect(list.filter((d) => d.subject === 'echo 10')).toHaveLength(1)
    expect(list[0]).toEqual(expect.objectContaining({ subject: 'echo 10', reason: 'again' }))
  })

  it('trims and caps a reason, and drops an empty one', () => {
    shell('a', '   ')
    shell('b', `  ${'x'.repeat(5000)}  `)
    const [b, a] = listRecentDenials()
    expect(a.reason).toBeUndefined()
    expect(b.reason).toHaveLength(2000)
  })

  it('builds the rules "Always allow" would save, skipping ones already allowed', () => {
    shell('npm run build && npm test')
    const id = listRecentDenials()[0].id
    const built = allowRulesForDenial(id, [])
    expect(built?.deniedByRule).toBe(false)
    expect(built?.rules.map((r) => r.match)).toEqual(['npm run', 'npm test'])
    // Shell commands are saved as their prefixes; an existing allow covering one leaves the other.
    const left = allowRulesForDenial(id, [{ action: 'allow', tool: 'run_shell', match: 'npm test' }])
    expect(left?.rules.map((r) => r.match)).toEqual(['npm run'])
  })

  it('keeps a work-discarding command exact, and names a deny rule that still wins', () => {
    shell('git push --force origin main')
    const id = listRecentDenials()[0].id
    const built = allowRulesForDenial(id, [{ action: 'deny', tool: 'run_shell', match: 'git push --force*' }])
    expect(built).toEqual({
      rules: [{ action: 'allow', tool: 'run_shell', match: 'git push --force origin main', exact: true }],
      deniedByRule: true
    })
  })

  it('saves a file as an exact path rule', () => {
    recordDenial({ tool: 'write_file', kind: 'write', args: { path: 'src/a*.ts', content: '' }, roots })
    const built = allowRulesForDenial(listRecentDenials()[0].id, [])
    expect(built?.rules).toEqual([{ action: 'allow', tool: 'write_file', match: 'src/a*.ts', exact: true }])
  })

  it('forgets an entry, and knows nothing of an id no longer listed', () => {
    shell('ls')
    const id = listRecentDenials()[0].id
    forgetDenial(id)
    expect(listRecentDenials()).toEqual([])
    expect(allowRulesForDenial(id, [])).toBeNull()
  })
})

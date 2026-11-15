import { describe, expect, it } from 'vitest'
import { GRANT_TTL_MS, RETRY_GRANT_TTL_MS, putCommandGrant, rememberTurnGrant, retryTurnGrant, takeCommandGrant } from './commandGrants'

describe('command grants', () => {
  const grant = { workspace: '/ws', effort: 'low' as const, turnAllowRules: [{ action: 'allow' as const, tool: 'glob', match: '*' }] }

  it('hands the options back once, for the workspace they were made for', () => {
    const token = putCommandGrant(grant)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(takeCommandGrant(token, '/ws')).toEqual(grant)
    expect(takeCommandGrant(token, '/ws')).toBeNull()
  })

  it('gives nothing for another workspace, and the token is spent', () => {
    const token = putCommandGrant(grant)
    expect(takeCommandGrant(token, '/elsewhere')).toBeNull()
    expect(takeCommandGrant(token, '/ws')).toBeNull()
  })

  it('expires', () => {
    const token = putCommandGrant(grant, 1000)
    expect(takeCommandGrant(token, '/ws', 1000 + GRANT_TTL_MS)).toBeNull()
  })

  it("carries an MCP prompt's taint source to the send, once", () => {
    const token = putCommandGrant({ workspace: '/ws', taintSource: 'mcp__docs__summarize' })
    expect(takeCommandGrant(token, '/ws')).toEqual({ workspace: '/ws', taintSource: 'mcp__docs__summarize' })
    expect(takeCommandGrant(token, '/ws')).toBeNull()
  })

  it('ignores a token that is not one', () => {
    expect(takeCommandGrant(undefined, '/ws')).toBeNull()
    expect(takeCommandGrant('', '/ws')).toBeNull()
    expect(takeCommandGrant({ workspace: '/ws' }, '/ws')).toBeNull()
  })
})

describe('command grants for a worktree chat and for Retry', () => {
  const grant = { workspace: '/repo', effort: 'low' as const }

  it('accepts any of the folders a chat may have been prepared for', () => {
    const token = putCommandGrant(grant)
    expect(takeCommandGrant(token, ['/repo/.wt/b', '/repo'])).toEqual(grant)
    const other = putCommandGrant(grant)
    expect(takeCommandGrant(other, ['/repo/.wt/b'])).toBeNull()
  })

  it('hands the options back for a retry of the same turn only, until they expire', () => {
    rememberTurnGrant('c1', 't1', grant, 1000)
    expect(retryTurnGrant('c1', 't1', 1000)).toEqual({ kind: 'grant', grant })
    expect(retryTurnGrant('c1', 't2', 1000)).toEqual({ kind: 'none' })
    expect(retryTurnGrant('c2', 't1', 1000)).toEqual({ kind: 'none' })
    expect(retryTurnGrant('c1', 't1', 1000 + RETRY_GRANT_TTL_MS)).toEqual({ kind: 'expired' })
    rememberTurnGrant('c1', 't3', null)
    expect(retryTurnGrant('c1', 't1', 1000)).toEqual({ kind: 'none' })
  })
})

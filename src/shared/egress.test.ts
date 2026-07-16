import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EGRESS_ALLOWLIST,
  evaluateEgress,
  hostMatchesAny,
  hostMatchesEntry,
  normalizeEgressHost,
  parseEgressEntry,
  resolveEgressMode
} from './egress'

describe('normalizeEgressHost', () => {
  it('lowercases and strips decoration', () => {
    expect(normalizeEgressHost('GitHub.COM')).toBe('github.com')
    expect(normalizeEgressHost('example.com.')).toBe('example.com') // trailing-dot FQDN
    expect(normalizeEgressHost('[::1]')).toBe('::1')
    expect(normalizeEgressHost('  npmjs.org ')).toBe('npmjs.org')
  })
})

describe('parseEgressEntry', () => {
  it('accepts the forms people paste', () => {
    expect(parseEgressEntry('example.com')).toBe('example.com')
    expect(parseEgressEntry('*.example.com')).toBe('example.com')
    expect(parseEgressEntry('https://example.com/path?q=1')).toBe('example.com')
    expect(parseEgressEntry('example.com:8443')).toBe('example.com')
    expect(parseEgressEntry('EXAMPLE.com.')).toBe('example.com')
    expect(parseEgressEntry('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(parseEgressEntry('::1')).toBe('::1') // bare IPv6 keeps its colons
  })

  it('rejects empty/decoration-only entries', () => {
    expect(parseEgressEntry('')).toBeNull()
    expect(parseEgressEntry('   ')).toBeNull()
    expect(parseEgressEntry('https://')).toBeNull()
  })

  it('keeps a lone * (match-everything) entry', () => {
    expect(parseEgressEntry('*')).toBe('*')
  })
})

describe('hostMatchesEntry', () => {
  it('matches the apex and subdomains on label boundaries only', () => {
    expect(hostMatchesEntry('example.com', 'example.com')).toBe(true)
    expect(hostMatchesEntry('api.example.com', 'example.com')).toBe(true)
    expect(hostMatchesEntry('a.b.example.com', 'example.com')).toBe(true)
    // NOT a suffix trick: evil-example.com must not match example.com.
    expect(hostMatchesEntry('evil-example.com', 'example.com')).toBe(false)
    expect(hostMatchesEntry('example.com.evil.net', 'example.com')).toBe(false)
  })

  it('* matches everything', () => {
    expect(hostMatchesEntry('anything.net', '*')).toBe(true)
  })
})

describe('evaluateEgress', () => {
  it('allows the built-in dev-infrastructure hosts by default', () => {
    for (const host of [
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
      'static.crates.io',
      'proxy.golang.org',
      'repo1.maven.org',
      'github.com',
      'codeload.github.com',
      'raw.githubusercontent.com',
      'gitlab.com'
    ]) {
      expect(evaluateEgress(host, undefined)).toEqual({
        allowed: true,
        rule: 'default-allowlist'
      })
    }
  })

  it('denies unlisted hosts by default — the exfiltration case', () => {
    expect(evaluateEgress('attacker.example', undefined)).toEqual({
      allowed: false,
      rule: 'not-listed'
    })
    expect(evaluateEgress('pastebin.com', {})).toEqual({ allowed: false, rule: 'not-listed' })
  })

  it('deny entries win over every allow source, including the defaults', () => {
    const s = { allow: ['corp.example'], deny: ['github.com', 'corp.example'] }
    expect(evaluateEgress('github.com', s)).toEqual({ allowed: false, rule: 'deny-entry' })
    expect(evaluateEgress('api.github.com', s)).toEqual({ allowed: false, rule: 'deny-entry' })
    expect(evaluateEgress('corp.example', s)).toEqual({ allowed: false, rule: 'deny-entry' })
  })

  it('user allow entries extend the defaults (and cover subdomains)', () => {
    const s = { allow: ['artifactory.corp.example'] }
    expect(evaluateEgress('artifactory.corp.example', s)).toEqual({
      allowed: true,
      rule: 'allow-entry'
    })
    expect(evaluateEgress('cdn.artifactory.corp.example', s)).toEqual({
      allowed: true,
      rule: 'allow-entry'
    })
    // Defaults still apply alongside user entries.
    expect(evaluateEgress('registry.npmjs.org', s).allowed).toBe(true)
  })

  it("mode 'all' is the explicit unrestricted escape hatch", () => {
    expect(evaluateEgress('attacker.example', { mode: 'all' })).toEqual({
      allowed: true,
      rule: 'mode-all'
    })
    // Deny entries are an allowlist-mode concept; 'all' means all.
    expect(evaluateEgress('github.com', { mode: 'all', deny: ['github.com'] }).allowed).toBe(true)
  })

  it('never allows an empty/garbage host', () => {
    expect(evaluateEgress('', undefined).allowed).toBe(false)
    expect(evaluateEgress('   ', { allow: ['*'] }).allowed).toBe(false)
  })

  it('matching is case-insensitive and tolerant of entry decoration', () => {
    const s = { allow: ['https://Corp.Example:8443/registry'] }
    expect(evaluateEgress('CORP.example', s).allowed).toBe(true)
    expect(hostMatchesAny('corp.example', ['*.corp.example'])).toBe(true)
  })
})

describe('resolveEgressMode', () => {
  it('defaults to allowlist — unset settings must be the secure mode', () => {
    expect(resolveEgressMode(undefined)).toBe('allowlist')
    expect(resolveEgressMode({})).toBe('allowlist')
    expect(resolveEgressMode({ mode: 'all' })).toBe('all')
  })
})

describe('DEFAULT_EGRESS_ALLOWLIST hygiene', () => {
  it('contains only bare, lowercase, deduped apex entries', () => {
    const seen = new Set<string>()
    for (const entry of DEFAULT_EGRESS_ALLOWLIST) {
      expect(entry).toBe(entry.toLowerCase())
      expect(entry).not.toMatch(/[/:*\s]/)
      expect(parseEgressEntry(entry)).toBe(entry)
      expect(seen.has(entry)).toBe(false)
      seen.add(entry)
    }
  })

  it('does not include broad cloud-storage or paste hosts (arbitrary-write exfil channels)', () => {
    for (const banned of ['storage.googleapis.com', 's3.amazonaws.com', 'pastebin.com']) {
      expect(hostMatchesAny(banned, DEFAULT_EGRESS_ALLOWLIST)).toBe(false)
    }
  })
})

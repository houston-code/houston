import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForUpdate, updateCheckEnabled, CHECK_INTERVAL_MS, RELEASES_URL } from './update-check'

const CURRENT = '0.2.141'

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), 'houston-update-')), 'update-check.json')
}

/** A fetch stub returning one GitHub release payload. */
function feed(body: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof globalThis.fetch
}

describe('updateCheckEnabled', () => {
  it('is on for a real version with no opt-out', () => {
    expect(updateCheckEnabled(CURRENT, {})).toBe(true)
  })

  it('honors the opt-outs', () => {
    expect(updateCheckEnabled(CURRENT, { HOUSTON_DISABLE_UPDATER: '1' })).toBe(false)
    expect(updateCheckEnabled(CURRENT, { HOUSTON_NO_UPDATE_CHECK: '1' })).toBe(false)
    expect(updateCheckEnabled(CURRENT, { NO_UPDATE_NOTIFIER: '1' })).toBe(false)
  })

  it('stays off for a dev build (its version cannot be compared anyway)', () => {
    expect(updateCheckEnabled('dev', {})).toBe(false)
    expect(updateCheckEnabled('0.0.0', {})).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('reports a newer release with its headline', async () => {
    const got = await checkForUpdate(CURRENT, {
      fetch: feed({ tag_name: 'v0.3.0', body: 'Faster startup\nand more' }),
      path: tmpCache(),
      env: {}
    })
    expect(got).toMatchObject({ latest: '0.3.0', headline: 'Faster startup' })
    expect(got?.url).toContain('releases')
  })

  it('says nothing when the published release is not newer', async () => {
    const same = await checkForUpdate(CURRENT, { fetch: feed({ tag_name: `v${CURRENT}` }), path: tmpCache(), env: {} })
    expect(same).toBeNull()
    const older = await checkForUpdate(CURRENT, { fetch: feed({ tag_name: 'v0.2.9' }), path: tmpCache(), env: {} })
    expect(older).toBeNull()
  })

  it('is silent when the check is disabled, without calling the network', async () => {
    const f = feed({ tag_name: 'v9.9.9' })
    expect(await checkForUpdate(CURRENT, { fetch: f, path: tmpCache(), env: { HOUSTON_NO_UPDATE_CHECK: '1' } })).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  // A failed check must be a non-event: no throw, no output, no retry storm.
  it('swallows a network failure and still records the attempt', async () => {
    const path = tmpCache()
    const boom = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof globalThis.fetch
    await expect(checkForUpdate(CURRENT, { fetch: boom, path, env: {} })).resolves.toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8')).checkedAt).toBeTypeOf('number')
  })

  it('swallows a non-ok response and an unparseable body', async () => {
    expect(await checkForUpdate(CURRENT, { fetch: feed({}, false), path: tmpCache(), env: {} })).toBeNull()
    expect(await checkForUpdate(CURRENT, { fetch: feed({ nope: 1 }), path: tmpCache(), env: {} })).toBeNull()
  })

  it('reuses the cached answer inside the interval instead of asking again', async () => {
    const path = tmpCache()
    writeFileSync(path, JSON.stringify({ checkedAt: 1000, latest: '0.3.0', url: 'https://x/releases' }))
    const f = feed({ tag_name: 'v9.9.9' })
    const got = await checkForUpdate(CURRENT, { fetch: f, path, env: {}, now: () => 1000 + CHECK_INTERVAL_MS - 1 })
    expect(got).toMatchObject({ latest: '0.3.0' })
    expect(f).not.toHaveBeenCalled() // the whole point: one check a day, not one a launch
  })

  it('asks again once the interval has passed', async () => {
    const path = tmpCache()
    writeFileSync(path, JSON.stringify({ checkedAt: 1000, latest: '0.2.141' }))
    const f = feed({ tag_name: 'v0.4.0' })
    const got = await checkForUpdate(CURRENT, { fetch: f, path, env: {}, now: () => 1000 + CHECK_INTERVAL_MS + 1 })
    expect(got).toMatchObject({ latest: '0.4.0' })
    expect(f).toHaveBeenCalledOnce()
  })

  it('tolerates a corrupt cache file rather than failing the check', async () => {
    const path = tmpCache()
    writeFileSync(path, 'not json{')
    const got = await checkForUpdate(CURRENT, { fetch: feed({ tag_name: 'v0.3.0' }), path, env: {} })
    expect(got).toMatchObject({ latest: '0.3.0' })
  })
})

/**
 * Release notes are remote text, printed to a terminal with no user action and
 * cached for a day. Whoever can publish a release note must not thereby be able
 * to write the reader's clipboard (OSC 52) or repaint their scrollback.
 */
describe('checkForUpdate — hostile feed', () => {
  it('strips escape sequences from the headline', async () => {
    const got = await checkForUpdate(CURRENT, {
      fetch: feed({
        tag_name: 'v0.3.0',
        body: '\x1b]52;c;cGF5bG9hZA==\x07\x1b[2J\x1b[HFake release\nrest'
      }),
      path: tmpCache(),
      env: {}
    })
    expect(got?.headline).toBe(']52;c;cGF5bG9hZA==[2J[HFake release')
    expect(got?.headline).not.toContain('\x1b')
    expect(got?.headline).not.toContain('\x07')
  })

  it('strips 8-bit C1 introducers too, not just ESC', async () => {
    const got = await checkForUpdate(CURRENT, {
      fetch: feed({ tag_name: 'v0.3.0', body: 'a\u009b31mb\u009d0;pwn' }),
      path: tmpCache(),
      env: {}
    })
    expect(got?.headline).toBe('a31mb0;pwn')
  })

  it('never takes the download link from the feed', async () => {
    const got = await checkForUpdate(CURRENT, {
      fetch: feed({ tag_name: 'v0.3.0', html_url: 'https://evil.example/pwn' }),
      path: tmpCache(),
      env: {}
    })
    expect(got?.url).toBe(RELEASES_URL)
  })

  it('ignores a version the feed cannot justify', async () => {
    // A tag that is not a version is never shown, so it cannot carry a payload.
    const got = await checkForUpdate(CURRENT, {
      fetch: feed({ tag_name: '\x1b[2Jnightly' }),
      path: tmpCache(),
      env: {}
    })
    expect(got).toBeNull()
  })

  it('sanitizes a tampered cache rather than trusting the disk', async () => {
    const path = tmpCache()
    writeFileSync(
      path,
      JSON.stringify({
        checkedAt: 1000,
        latest: '0.3.0',
        headline: 'x\x1b]52;c;evil\x07',
        url: 'https://evil.example'
      })
    )
    const got = await checkForUpdate(CURRENT, { fetch: feed({}), path, env: {}, now: () => 1000 })
    expect(got?.headline).not.toContain('\x1b')
    expect(got?.url).toBe(RELEASES_URL) // the link is a constant, never from disk
  })

  it('ignores non-string cache fields', async () => {
    const path = tmpCache()
    writeFileSync(path, JSON.stringify({ checkedAt: 1000, latest: { evil: true }, headline: 42 }))
    await expect(
      checkForUpdate(CURRENT, { fetch: feed({}), path, env: {}, now: () => 1000 })
    ).resolves.toBeNull()
  })
})

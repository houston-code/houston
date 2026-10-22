import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { install, pinnedRelease } from './install.mjs'
import { SIGNING_FINGERPRINT } from './verify.mjs'

const CLI_BODY = '#!/usr/bin/env node\nconsole.log("0.8.0")\n'
const sha = (s) => createHash('sha256').update(s).digest('hex')
const GOOD = `[GNUPG:] GOODSIG X Houston\n[GNUPG:] VALIDSIG ${'E'.repeat(40)} 2026-10-21 1 0 4 0 1 10 00 ${SIGNING_FINGERPRINT}\n`

/** A fake release server; `files` overrides any asset's body (null for a 404). */
function server(files = {}) {
  const assets = {
    'houston-cli.cjs': CLI_BODY,
    SHA256SUMS: `${sha(CLI_BODY)}  houston-cli.cjs\n`,
    'SHA256SUMS.asc': '-----BEGIN PGP SIGNATURE-----\n',
    'SHA256SUMS.cosign.bundle': '{}',
    ...files
  }
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    const body = assets[url.split('/').pop()]
    if (body === null || body === undefined) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer }
  }
  return { fetchImpl, urls }
}

function execWith({ version = '0.8.0', gpgv = { code: 0, stdout: GOOD, stderr: '' } } = {}) {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'gpg') return { code: 0, stdout: '', stderr: '' }
    if (cmd === 'gpgv') return gpgv
    if (cmd === 'cosign') return { code: 127, stdout: '', stderr: 'not found' }
    if (cmd === 'node') return { code: 0, stdout: `${version}\n`, stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const envFor = (o = {}) => {
  const temp = mkdtempSync(join(tmpdir(), 'h-install-'))
  return { RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'out'), HOUSTON_NODE: 'node', ...o }
}

describe('install', () => {
  it('downloads the requested release, verifies it, and only then runs it', async () => {
    const env = envFor({ HOUSTON_INPUT_CLI_VERSION: 'v0.8.0' })
    const { fetchImpl, urls } = server()
    const { exec, calls } = execWith()
    const r = await install({ env, exec, fetchImpl, log: () => {}, platform: 'linux' })
    expect(urls).toEqual([
      'https://github.com/houston-code/houston/releases/download/v0.8.0/houston-cli.cjs',
      'https://github.com/houston-code/houston/releases/download/v0.8.0/SHA256SUMS',
      'https://github.com/houston-code/houston/releases/download/v0.8.0/SHA256SUMS.asc',
      'https://github.com/houston-code/houston/releases/download/v0.8.0/SHA256SUMS.cosign.bundle'
    ])
    expect(calls.map((c) => c[0])).toEqual(['cosign', 'gpg', 'gpgv', 'node'])
    expect(r).toMatchObject({ version: '0.8.0', checked: ['gpg', 'sha256'] })
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`cli-path=${r.cli}\ncli-version=0.8.0\n`)
  })

  it('defaults to the pinned release', async () => {
    const { fetchImpl, urls } = server({ 'houston-cli.cjs': 'x', SHA256SUMS: `${sha('x')}  houston-cli.cjs\n` })
    // The fake CLI is not the pinned one, so the pinned-hash check is what stops it.
    await expect(install({ env: envFor(), exec: execWith().exec, fetchImpl, log: () => {}, platform: 'linux' })).rejects.toThrow(/hash this action pins/)
    expect(urls[0]).toContain(`/v${pinnedRelease().version}/`)
  })

  it('never runs a CLI that fails verification', async () => {
    const { fetchImpl } = server({ 'houston-cli.cjs': `${CLI_BODY}// tampered\n` })
    const { exec, calls } = execWith()
    await expect(install({ env: envFor({ HOUSTON_INPUT_CLI_VERSION: '0.8.0' }), exec, fetchImpl, log: () => {}, platform: 'linux' })).rejects.toThrow(
      /does not match SHA256SUMS/
    )
    expect(calls.some((c) => c[0] === 'node')).toBe(false)
  })

  it('never runs a CLI whose checksums are not signed by the release key', async () => {
    const { exec, calls } = execWith({ gpgv: { code: 1, stdout: '[GNUPG:] NO_PUBKEY X\n', stderr: '' } })
    await expect(
      install({ env: envFor({ HOUSTON_INPUT_CLI_VERSION: '0.8.0' }), exec, fetchImpl: server().fetchImpl, log: () => {}, platform: 'linux' })
    ).rejects.toThrow(/GPG signature check/)
    expect(calls.some((c) => c[0] === 'node')).toBe(false)
  })

  it('fails on a missing asset or a version that does not match', async () => {
    const env = envFor({ HOUSTON_INPUT_CLI_VERSION: '0.8.0' })
    await expect(install({ env, exec: execWith().exec, fetchImpl: server({ 'SHA256SUMS.asc': null }).fetchImpl, log: () => {}, platform: 'linux' })).rejects.toThrow(
      /HTTP 404/
    )
    await expect(
      install({ env, exec: execWith({ version: '0.7.0' }).exec, fetchImpl: server().fetchImpl, log: () => {}, platform: 'linux' })
    ).rejects.toThrow(/reports version "0.7.0"/)
  })

  it('refuses a Windows runner before downloading', async () => {
    const { fetchImpl, urls } = server()
    await expect(
      install({ env: envFor(), exec: execWith().exec, fetchImpl, log: () => {}, platform: 'win32' })
    ).rejects.toThrow(/Windows runners are not supported/)
    expect(urls).toEqual([])
  })

  it('refuses a version that is not X.Y.Z before downloading', async () => {
    const { fetchImpl, urls } = server()
    await expect(
      install({ env: envFor({ HOUSTON_INPUT_CLI_VERSION: '../../evil' }), exec: execWith().exec, fetchImpl, log: () => {}, platform: 'linux' })
    ).rejects.toThrow(/release version/)
    expect(urls).toEqual([])
  })
})

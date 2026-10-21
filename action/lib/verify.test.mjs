import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  CLI_ASSET,
  SIGNING_FINGERPRINT,
  assetUrl,
  checkGpgStatus,
  parseSha256Sums,
  parseVersion,
  sha256File,
  verifyRelease
} from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const KEY = resolve(here, '../../houston-signing-key.asc')
const PINNED = JSON.parse(readFileSync(resolve(here, '../cli-release.json'), 'utf8'))
// The pinned release's own SHA256SUMS and signature: bumping cli-release.json means adding them.
const FIXTURE = resolve(here, `../test/fixtures/v${PINNED.version}`)
const SIGNING_SUBKEY = 'E71CDECC3E1263AE1CA669E93CE7C2C34DB8E5D2'

const good = (primary = SIGNING_FINGERPRINT) =>
  [
    '[GNUPG:] NEWSIG',
    '[GNUPG:] GOODSIG 3CE7C2C34DB8E5D2 Houston Release Signing <dev@houstoncode.ai>',
    `[GNUPG:] VALIDSIG ${SIGNING_SUBKEY} 2026-10-21 1792549785 0 4 0 1 10 00 ${primary}`
  ].join('\n')

describe('parseVersion', () => {
  it('takes X.Y.Z with or without a v', () => {
    expect(parseVersion('0.9.0')).toBe('0.9.0')
    expect(parseVersion(' v1.2.3 ')).toBe('1.2.3')
  })

  it.each(['', 'latest', '0.9', '1.0.0-rc.1', '../0.9.0', '01.0.0'])('refuses %j', (v) => {
    expect(() => parseVersion(v)).toThrow(/release version/)
  })

  it('builds the release download URL', () => {
    expect(assetUrl('0.9.0', CLI_ASSET)).toBe('https://github.com/houston-code/houston/releases/download/v0.9.0/houston-cli.cjs')
  })
})

describe('parseSha256Sums', () => {
  it('reads text and binary mode lines and skips junk', () => {
    const sums = parseSha256Sums(`${'A'.repeat(64)}  a.txt\n${'b'.repeat(64)} *b.bin\nnot a line\n${'c'.repeat(63)}  short\n`)
    expect([...sums]).toEqual([
      ['a.txt', 'a'.repeat(64)],
      ['b.bin', 'b'.repeat(64)]
    ])
  })

  it('keeps the first line for a repeated name', () => {
    expect(parseSha256Sums(`${'1'.repeat(64)}  x\n${'2'.repeat(64)}  x\n`).get('x')).toBe('1'.repeat(64))
  })
})

describe('checkGpgStatus', () => {
  it('accepts a good signature by a subkey of the pinned key', () => {
    expect(checkGpgStatus(good())).toEqual({ ok: true })
  })

  it('refuses a good signature by any other key', () => {
    expect(checkGpgStatus(good('F'.repeat(40))).ok).toBe(false)
  })

  it.each(['BADSIG', 'ERRSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY'])('refuses a status with %s', (word) => {
    expect(checkGpgStatus(`${good()}\n[GNUPG:] ${word} 3CE7C2C34DB8E5D2`).ok).toBe(false)
  })

  it('refuses output with no GOODSIG', () => {
    expect(checkGpgStatus(good().split('\n').filter((l) => !l.includes('GOODSIG')).join('\n')).ok).toBe(false)
    expect(checkGpgStatus('').ok).toBe(false)
  })
})

const hasGpgv = spawnSync('gpgv', ['--version']).status === 0 && spawnSync('gpg', ['--version']).status === 0

describe.runIf(hasGpgv)('the pinned release signature', () => {
  function gpgv(sums) {
    const home = mkdtempSync(join(tmpdir(), 'h-gpg-'))
    chmodSync(home, 0o700)
    const ring = join(home, 'k.gpg')
    expect(spawnSync('gpg', ['--batch', '--homedir', home, '--dearmor', '--output', ring, KEY]).status).toBe(0)
    const r = spawnSync('gpgv', ['--status-fd', '1', '--keyring', ring, join(FIXTURE, 'SHA256SUMS.asc'), sums], {
      encoding: 'utf8'
    })
    return { code: r.status, status: r.stdout }
  }

  it('verifies with the committed key', () => {
    const r = gpgv(join(FIXTURE, 'SHA256SUMS'))
    expect(r.code).toBe(0)
    expect(checkGpgStatus(r.status)).toEqual({ ok: true })
  })

  it('fails once SHA256SUMS is altered by one byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-sums-'))
    const original = readFileSync(join(FIXTURE, 'SHA256SUMS'), 'utf8')
    const altered = original.replace(/^(.)/, (c) => (c === '0' ? '1' : '0'))
    writeFileSync(join(dir, 'SHA256SUMS'), altered)
    const r = gpgv(join(dir, 'SHA256SUMS'))
    expect(r.code).not.toBe(0)
    expect(checkGpgStatus(r.status).ok).toBe(false)
  })
})

describe('verifyRelease', () => {
  /** A release directory holding a CLI and a SHA256SUMS that lists `listed` for it. */
  function release({ cli = 'console.log(1)\n', listed } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'h-rel-'))
    writeFileSync(join(dir, CLI_ASSET), cli)
    const sha = listed ?? sha256File(join(dir, CLI_ASSET))
    writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  other.zip\n${sha}  ${CLI_ASSET}\n`)
    copyFileSync(join(FIXTURE, 'SHA256SUMS.asc'), join(dir, 'SHA256SUMS.asc'))
    return { dir, sha }
  }

  /** A fake `run`: gpg and gpgv succeed (or as told), cosign as told; records every call. */
  function runner({ gpgv = { code: 0, stdout: good(), stderr: '' }, cosign = { code: 0, stdout: '', stderr: '' } } = {}) {
    const calls = []
    const run = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'gpg') return { code: 0, stdout: '', stderr: '' }
      if (cmd === 'gpgv') return gpgv
      if (cmd === 'cosign') return cosign
      return { code: 127, stdout: '', stderr: 'unexpected' }
    }
    return { run, calls }
  }

  const opts = (dir, run, extra = {}) => ({
    dir,
    version: '0.9.0',
    pinned: null,
    keyPath: KEY,
    gnupgHome: dir,
    run,
    hasCosign: false,
    ...extra
  })

  it('checks the signature with only the committed key, then the hash', async () => {
    const { dir, sha } = release()
    const { run, calls } = runner()
    await expect(verifyRelease(opts(dir, run))).resolves.toEqual({ sha256: sha, checked: ['gpg', 'sha256'] })
    expect(calls[0]).toEqual(['gpg', '--batch', '--homedir', dir, '--dearmor', '--output', `${dir}/houston-release.gpg`, KEY])
    expect(calls[1].slice(0, 5)).toEqual(['gpgv', '--status-fd', '1', '--keyring', `${dir}/houston-release.gpg`])
  })

  it('refuses a CLI that does not match SHA256SUMS', async () => {
    const { dir } = release({ listed: 'f'.repeat(64) })
    await expect(verifyRelease(opts(dir, runner().run))).rejects.toThrow(/does not match SHA256SUMS/)
  })

  it('refuses a SHA256SUMS with no CLI line', async () => {
    const { dir } = release()
    writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  other.zip\n`)
    await expect(verifyRelease(opts(dir, runner().run))).rejects.toThrow(/no houston-cli.cjs line/)
  })

  it('refuses a bad or foreign signature before reading any hash', async () => {
    const { dir } = release()
    const bad = runner({ gpgv: { code: 1, stdout: '[GNUPG:] BADSIG x', stderr: 'BAD signature' } })
    await expect(verifyRelease(opts(dir, bad.run))).rejects.toThrow(/GPG signature check: gpg reported BADSIG/)
    const foreign = runner({ gpgv: { code: 0, stdout: good('E'.repeat(40)), stderr: '' } })
    await expect(verifyRelease(opts(dir, foreign.run))).rejects.toThrow(/not by the Houston release key/)
  })

  it('also checks cosign when it is installed, and fails on its failure', async () => {
    const { dir } = release()
    const ok = runner()
    await expect(verifyRelease(opts(dir, ok.run, { hasCosign: true }))).resolves.toMatchObject({
      checked: ['gpg', 'cosign', 'sha256']
    })
    expect(ok.calls.find((c) => c[0] === 'cosign')).toEqual(
      expect.arrayContaining([
        '--certificate-identity',
        'https://github.com/houston-code/houston/.github/workflows/release-publish.yml@refs/heads/main'
      ])
    )
    const bad = runner({ cosign: { code: 1, stdout: '', stderr: 'no matching signatures' } })
    await expect(verifyRelease(opts(dir, bad.run, { hasCosign: true }))).rejects.toThrow(/cosign signature check/)
  })

  it('holds the pinned release to the hash recorded in cli-release.json', async () => {
    const { dir, sha } = release()
    const pinned = { version: '0.9.0', sha256: sha.toUpperCase() }
    await expect(verifyRelease(opts(dir, runner().run, { pinned }))).resolves.toMatchObject({
      checked: ['gpg', 'sha256', 'pinned']
    })
    const wrong = { version: '0.9.0', sha256: '1'.repeat(64) }
    await expect(verifyRelease(opts(dir, runner().run, { pinned: wrong }))).rejects.toThrow(/hash this action pins/)
    // Another version is checked by its signature alone.
    await expect(verifyRelease(opts(dir, runner().run, { pinned: { ...wrong, version: '0.8.0' } }))).resolves.toBeTruthy()
  })
})

describe('cli-release.json', () => {
  it('pins the CLI hash listed in that release\'s signed SHA256SUMS', () => {
    expect(parseVersion(PINNED.version)).toBe(PINNED.version)
    const sums = parseSha256Sums(readFileSync(join(FIXTURE, 'SHA256SUMS'), 'utf8'))
    expect(sums.get(CLI_ASSET)).toBe(PINNED.sha256)
  })
})

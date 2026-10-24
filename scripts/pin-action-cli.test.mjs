import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pinActionCli } from './pin-action-cli.mjs'
import { SIGNING_FINGERPRINT, sha256File } from '../action/lib/verify.mjs'

const KEY = resolve(__dirname, '../houston-signing-key.asc')
const PINNED = { version: '0.10.0', sha256: 'a'.repeat(64) }

/** A repo root with the action's pin and the signing key, plus a release's assets in `dir`. */
function world({ pinned = PINNED, listed } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pin-root-'))
  mkdirSync(join(root, 'action'), { recursive: true })
  writeFileSync(join(root, 'action/cli-release.json'), `${JSON.stringify(pinned, null, 2)}\n`)
  copyFileSync(KEY, join(root, 'houston-signing-key.asc'))
  const dir = mkdtempSync(join(tmpdir(), 'pin-assets-'))
  writeFileSync(join(dir, 'houston-cli.cjs'), '#!/usr/bin/env node\nconsole.log("0.11.0")\n')
  const sha = sha256File(join(dir, 'houston-cli.cjs'))
  writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  other.zip\n${listed ?? sha}  houston-cli.cjs\n`)
  writeFileSync(join(dir, 'SHA256SUMS.asc'), '-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n')
  return { root, dir, sha, pin: () => JSON.parse(readFileSync(join(root, 'action/cli-release.json'), 'utf8')) }
}

/** A fake `run`: gpg succeeds, gpgv reports `status`; records every call. */
function runner(status = `[GNUPG:] GOODSIG 3CE7C2C34DB8E5D2 Houston\n[GNUPG:] VALIDSIG X 2026-10-21 1 0 4 0 1 10 00 ${SIGNING_FINGERPRINT}`) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'gpg') return { code: 0, stdout: '', stderr: '' }
    if (cmd === 'gpgv') return { code: 0, stdout: status, stderr: '' }
    return { code: 127, stdout: '', stderr: 'unexpected' }
  }
  return { run, calls }
}

describe('pinActionCli', () => {
  it('pins a newer release and adds its signed SHA256SUMS as the test fixture', async () => {
    const w = world()
    const { run, calls } = runner()
    await expect(pinActionCli({ root: w.root, version: 'v0.11.0', dir: w.dir, run })).resolves.toEqual({
      changed: true,
      sha256: w.sha
    })
    expect(w.pin()).toEqual({ version: '0.11.0', sha256: w.sha })
    expect(readFileSync(join(w.root, 'action/cli-release.json'), 'utf8')).toMatch(/\n}\n$/)
    for (const name of ['SHA256SUMS', 'SHA256SUMS.asc']) {
      expect(readFileSync(join(w.root, 'action/test/fixtures/v0.11.0', name), 'utf8')).toBe(readFileSync(join(w.dir, name), 'utf8'))
    }
    // Only the key committed in the repository vouches for the release.
    expect(calls[0].at(-1)).toBe(join(w.root, 'houston-signing-key.asc'))
    expect(calls[1][0]).toBe('gpgv')
  })

  it.each(['0.10.0', '0.9.3'])('leaves the pin alone for %s, at or behind it, without checking anything', async (version) => {
    const w = world()
    const { run, calls } = runner()
    await expect(pinActionCli({ root: w.root, version, dir: w.dir, run })).resolves.toEqual({ changed: false, pinned: '0.10.0' })
    expect(w.pin()).toEqual(PINNED)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(w.root, 'action/test/fixtures'))).toBe(false)
  })

  it('writes nothing when the signature is not by the release key', async () => {
    const w = world()
    const { run } = runner(`[GNUPG:] GOODSIG X\n[GNUPG:] VALIDSIG X 2026-10-21 1 0 4 0 1 10 00 ${'E'.repeat(40)}`)
    await expect(pinActionCli({ root: w.root, version: '0.11.0', dir: w.dir, run })).rejects.toThrow(/not by the Houston release key/)
    expect(w.pin()).toEqual(PINNED)
    expect(existsSync(join(w.root, 'action/test/fixtures'))).toBe(false)
  })

  it('writes nothing when the CLI does not match its SHA256SUMS line', async () => {
    const w = world({ listed: 'f'.repeat(64) })
    await expect(pinActionCli({ root: w.root, version: '0.11.0', dir: w.dir, run: runner().run })).rejects.toThrow(
      /does not match SHA256SUMS/
    )
    expect(w.pin()).toEqual(PINNED)
  })

  it.each(['latest', '0.11', '0.11.0-rc.1'])('refuses %j as a version', async (version) => {
    const w = world()
    await expect(pinActionCli({ root: w.root, version, dir: w.dir, run: runner().run })).rejects.toThrow(/release version/)
  })
})

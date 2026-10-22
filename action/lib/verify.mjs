// Downloading the standalone CLI from a Houston release and proving it is the file the
// release workflow published, before anything runs it. The steps are the README's
// "Verifying downloads": a GPG signature over SHA256SUMS made with the project key (the
// copy committed next to this action, not one fetched from the release being checked),
// then the CLI's hash against its SHA256SUMS line. When `cosign` is on PATH, the keyless
// signature is checked as well. For the release this action version pins, the hash must
// also equal the one recorded in cli-release.json.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The project signing key's primary fingerprint, as published in the README. */
export const SIGNING_FINGERPRINT = 'A11DD2824C1EF838D441452F5DD4F6079F8BA5DB'

/** The workflow identity in the release's cosign certificates. */
export const COSIGN_IDENTITY =
  'https://github.com/houston-code/houston/.github/workflows/release-publish.yml@refs/heads/main'
export const COSIGN_ISSUER = 'https://token.actions.githubusercontent.com'

export const CLI_ASSET = 'houston-cli.cjs'
export const SIGNED_ASSETS = [CLI_ASSET, 'SHA256SUMS', 'SHA256SUMS.asc', 'SHA256SUMS.cosign.bundle']

/** A release version as the release workflows write it: X.Y.Z, no prefix. */
export function parseVersion(input) {
  const v = (input ?? '').trim().replace(/^v/, '')
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(v)) {
    throw new Error(`cli-version must be a release version like 0.9.0 (got ${JSON.stringify(input)})`)
  }
  return v
}

/** Where a release asset downloads from. Releases live on github.com, also for GHES users. */
export function assetUrl(version, name) {
  return `https://github.com/houston-code/houston/releases/download/v${version}/${name}`
}

/** Parse `sha256sum` output into name → lowercase hex. Malformed lines are skipped. */
export function parseSha256Sums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim())
    if (m && !sums.has(m[2])) sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Whether gpg's machine-readable status output (`--status-fd`) shows a good signature by
 * the pinned key. Needs both GOODSIG and a VALIDSIG whose primary-key fingerprint is the
 * pinned one: a good signature by any other key in the keyring does not count, and any
 * BADSIG, ERRSIG, EXPKEYSIG, or REVKEYSIG fails it.
 */
export function checkGpgStatus(status, fingerprint = SIGNING_FINGERPRINT) {
  const lines = status.split(/\r?\n/).filter((l) => l.startsWith('[GNUPG:] '))
  const words = lines.map((l) => l.slice('[GNUPG:] '.length).trim().split(/\s+/))
  const bad = words.find((w) => ['BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY'].includes(w[0]))
  if (bad) return { ok: false, reason: `gpg reported ${bad[0]}` }
  if (!words.some((w) => w[0] === 'GOODSIG')) return { ok: false, reason: 'gpg reported no good signature' }
  const want = fingerprint.toUpperCase()
  const valid = words.find((w) => {
    if (w[0] !== 'VALIDSIG') return false
    // VALIDSIG <signing-key fpr> ... [<primary-key fpr>]: the primary is the last field when present.
    const primary = (w.length >= 11 ? w[10] : w[1]).toUpperCase()
    return primary === want
  })
  if (!valid) return { ok: false, reason: `the signature is not by the Houston release key ${fingerprint}` }
  return { ok: true }
}

/**
 * Check a downloaded release in `dir`. `run(cmd, args)` resolves to `{ code, stdout,
 * stderr }` and is injected so the whole flow is testable; `gnupgHome` is a fresh private
 * directory for the keyring. Throws with the reason on any failure; returns what was checked.
 */
export async function verifyRelease({ dir, version, pinned, keyPath, gnupgHome, run, hasCosign }) {
  const at = (name) => `${dir}/${name}`
  const checked = []

  // gpgv against a keyring holding only the pinned key: no agent, no trust database, and no
  // other key on the runner can vouch for the file.
  const keyring = `${gnupgHome}/houston-release.gpg`
  const dearmored = await run('gpg', ['--batch', '--homedir', gnupgHome, '--dearmor', '--output', keyring, keyPath])
  if (dearmored.code !== 0) throw new Error(`could not read the Houston signing key: ${dearmored.stderr.trim()}`)
  const verified = await run('gpgv', ['--status-fd', '1', '--keyring', keyring, at('SHA256SUMS.asc'), at('SHA256SUMS')])
  const gpg = checkGpgStatus(verified.stdout)
  if (verified.code !== 0 || !gpg.ok) {
    throw new Error(`SHA256SUMS failed its GPG signature check: ${gpg.reason ?? verified.stderr.trim()}`)
  }
  checked.push('gpg')

  if (hasCosign) {
    const c = await run('cosign', [
      'verify-blob',
      at('SHA256SUMS'),
      '--bundle',
      at('SHA256SUMS.cosign.bundle'),
      '--certificate-identity',
      COSIGN_IDENTITY,
      '--certificate-oidc-issuer',
      COSIGN_ISSUER
    ])
    if (c.code !== 0) throw new Error(`SHA256SUMS failed its cosign signature check: ${c.stderr.trim()}`)
    checked.push('cosign')
  }

  const expected = parseSha256Sums(readFileSync(at('SHA256SUMS'), 'utf8')).get(CLI_ASSET)
  if (!expected) throw new Error(`SHA256SUMS for v${version} has no ${CLI_ASSET} line`)
  const actual = sha256File(at(CLI_ASSET))
  if (actual !== expected) throw new Error(`${CLI_ASSET} does not match SHA256SUMS (got ${actual}, expected ${expected})`)
  checked.push('sha256')

  if (pinned && pinned.version === version) {
    if (actual !== pinned.sha256.toLowerCase()) {
      throw new Error(`${CLI_ASSET} v${version} does not match the hash this action pins (${pinned.sha256})`)
    }
    checked.push('pinned')
  }
  return { sha256: actual, checked }
}

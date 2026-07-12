import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the Linux GPG-signing invariants in the release-publish workflow, not application
 * code — but it lives in the node test project so it runs in the same `npm test` that gates
 * every PR. release-publish.yml is workflow_dispatch-only, so its GPG step never executes on a
 * normal PR; these assertions are the only automated check that the signing contract stays
 * intact (correct gating, non-interactive signing, and that a missing key degrades safely
 * instead of stranding a release).
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-publish.yml'), 'utf8')

// The single GPG step's body: from its `- name:` marker to the start of the next step.
const gpgStep = (() => {
  const start = workflow.indexOf('- name: GPG-sign Linux artifacts')
  const rest = workflow.slice(start + 1)
  const next = rest.indexOf('\n      - ') // next step at the same indent
  return next === -1 ? rest : rest.slice(0, next)
})()

describe('release-publish GPG signing', () => {
  it('defines a GPG signing step', () => {
    expect(workflow).toContain('- name: GPG-sign Linux artifacts + whole-release checksums')
  })

  it('runs only on the Linux leg and never on a dry run', () => {
    // The manifest covers assets present on the Linux leg (which is last in the serialized
    // matrix); dry_run publishes nothing, so there is nothing to sign or attach.
    expect(gpgStep).toContain("matrix.os == 'ubuntu-22.04'")
    expect(gpgStep).toContain('!inputs.dry_run')
  })

  it('soft-skips when the signing key is absent, so a missing secret never fails a release', () => {
    // GPG is additive: without GPG_PRIVATE_KEY the release still publishes (unsigned), matching
    // how the macOS signing gate degrades without certs. A hard failure here would strand the
    // draft (finalize needs: build), so the empty-key path must early-exit 0, not error.
    expect(gpgStep).toMatch(/if \[ -z "\$GPG_PRIVATE_KEY" \]/)
    expect(gpgStep).toContain('exit 0')
  })

  it('imports into an ephemeral keyring and signs non-interactively (no TTY on CI)', () => {
    // Throwaway GNUPGHOME so the imported private key never persists on the runner, and
    // loopback pinentry so the passphrase is supplied without an interactive prompt.
    expect(gpgStep).toMatch(/GNUPGHOME="\$\(mktemp -d\)"/)
    expect(gpgStep).toContain('allow-loopback-pinentry')
    expect(gpgStep).toContain('--pinentry-mode loopback')
    // The passphrase comes from the secret env, never hardcoded.
    expect(gpgStep).toContain('--passphrase "$GPG_PASSPHRASE"')
    expect(workflow).toContain('GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}')
    expect(workflow).toContain('GPG_PRIVATE_KEY: ${{ secrets.GPG_PRIVATE_KEY }}')
  })

  it('emits a detached signature beside each Linux artifact', () => {
    expect(gpgStep).toMatch(/for f in release\/\*\.AppImage release\/\*\.deb/)
    expect(gpgStep).toContain('--detach-sign')
    expect(gpgStep).toMatch(/gh release upload "\$tag" "\$f\.asc"/)
  })

  it('produces one signed SHA256SUMS manifest covering the release assets', () => {
    // A single signed manifest (SHA256SUMS + SHA256SUMS.asc) replaces the lone per-CLI .sha256,
    // so one verify covers the whole set. Manifest is built from bare filenames so the listed
    // names match what a user downloads.
    expect(gpgStep).toContain('sha256sum')
    expect(gpgStep).toMatch(/> SHA256SUMS/)
    expect(gpgStep).toContain('sign SHA256SUMS')
    expect(gpgStep).toMatch(/gh release upload "\$tag" SHA256SUMS SHA256SUMS\.asc houston-signing-key\.asc/)
  })

  it('publishes the public key so a downloader needs no keyserver', () => {
    expect(gpgStep).toContain('houston-signing-key.asc')
  })
})

describe('committed signing public key', () => {
  const key = readFileSync(resolve(repoRoot, 'houston-signing-key.asc'), 'utf8')

  it('is an ASCII-armored PUBLIC key block (never the private key)', () => {
    expect(key).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    expect(key).toContain('-----END PGP PUBLIC KEY BLOCK-----')
    // A leaked private key would carry this header — assert it is absent.
    expect(key).not.toContain('PRIVATE KEY BLOCK')
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the Linux GPG-signing and source-commit invariants in the release-publish workflow, not application
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

// The `checksums` job: from its key to the next top-level job.
const checksumsJob = (() => {
  const start = workflow.indexOf('\n  checksums:\n')
  return workflow.slice(start, workflow.indexOf('\n  finalize:\n', start))
})()

describe('release-publish GPG signing', () => {
  it('defines a GPG signing step', () => {
    expect(workflow).toContain('- name: GPG-sign Linux artifacts')
  })

  it('runs only on the Linux leg and never on a dry run', () => {
    // The AppImage and deb exist only on the Linux leg; dry_run publishes nothing, so there
    // is nothing to sign or attach.
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

  it('publishes the public key so a downloader needs no keyserver', () => {
    expect(gpgStep).toMatch(/gh release upload "\$tag" houston-signing-key\.asc/)
  })

  it('leaves the whole-release manifest to the checksums job', () => {
    // Built on the Linux leg it could only hash that runner's files, so it missed every mac
    // and Windows download.
    expect(gpgStep).not.toContain('SHA256SUMS')
  })
})

describe('release-publish SHA256SUMS manifest', () => {
  it('runs after every build leg and before finalize publishes', () => {
    expect(checksumsJob).toContain('needs: build')
    expect(workflow).toContain('\n  finalize:\n    needs: [build, checksums]\n')
  })

  it('never runs on a dry run', () => {
    expect(checksumsJob).toContain('if: ${{ !inputs.dry_run }}')
  })

  it('hashes the assets as downloaded from the draft, with bare filenames', () => {
    expect(checksumsJob).toContain('node scripts/release-checksums.mjs houston-code/houston "$tag" > checksummed.txt')
    expect(checksumsJob).toContain('gh release download "$tag" -R houston-code/houston -p "$name" -D assets')
    expect(checksumsJob).toContain('( cd assets && sha256sum -- "${names[@]}" ) > SHA256SUMS')
  })

  it('signs the manifest with cosign always and GPG when the key is set', () => {
    expect(checksumsJob).toContain('cosign sign-blob --yes SHA256SUMS --bundle SHA256SUMS.cosign.bundle')
    expect(checksumsJob).toMatch(/if \[ -z "\$GPG_PRIVATE_KEY" \]/)
    expect(checksumsJob).toMatch(/GNUPGHOME="\$\(mktemp -d\)"/)
    expect(checksumsJob).toContain('--pinentry-mode loopback --passphrase "$GPG_PASSPHRASE"')
    expect(checksumsJob).toContain('--detach-sign --output SHA256SUMS.asc SHA256SUMS')
    expect(checksumsJob).toContain('gh release upload "$tag" "${files[@]}" -R houston-code/houston --clobber')
  })

  it('reads the signing secrets from the release environment', () => {
    expect(checksumsJob).toContain('environment: release')
    expect(checksumsJob).toContain('id-token: write')
  })
})

describe('release-publish source commit', () => {
  // Every job that checks out code must build, attest, and tag the commit the run was
  // dispatched on. A fresh `main` drifts across the serialized legs, and the SLSA provenance
  // (scripts/slsa-provenance.mjs) records GITHUB_SHA regardless of what was checked out.
  it('never checks out a moving branch ref', () => {
    expect(workflow).not.toMatch(/^\s*ref:\s*main\s*$/m)
  })

  it('pins the build, checksums and finalize checkouts to github.sha', () => {
    const pinned = workflow.match(/^\s*ref: \$\{\{ github\.sha \}\}\s*$/gm) ?? []
    expect(pinned).toHaveLength(3)
  })

  it('refuses to publish under a version tag that names a different commit', () => {
    const start = workflow.indexOf('- name: Tag source repo at released commit')
    const step = workflow.slice(start, workflow.indexOf('\n      - ', start + 1))
    expect(step).toContain('git rev-parse "$tag^{commit}"')
    expect(step).toContain('"$GITHUB_SHA"')
    expect(step).toContain('exit 1')
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

describe('release-publish Download table', () => {
  const finalize = workflow.slice(workflow.indexOf('\n  finalize:\n'))

  it('builds the table from the draft before the tag is pushed', () => {
    const table = finalize.indexOf('node scripts/release-downloads.mjs houston-code/houston "$tag"')
    expect(table).toBeGreaterThan(-1)
    expect(table).toBeLessThan(finalize.indexOf('- name: Tag source repo at released commit'))
  })

  it('publishes the table followed by the changelog notes', () => {
    expect(finalize).toContain('cat release-notes.md')
    expect(finalize).toContain('--notes-file release-body.md')
    expect(finalize).not.toContain('--notes-file release-notes.md')
  })
})

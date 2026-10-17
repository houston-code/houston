import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the signing, build-order and source-commit invariants in the release workflows
 * (release-publish.yml and the release-build.yml legs it calls), not application code — but it
 * lives in the node test project so it runs in the same `npm test` that gates every PR. Both
 * are workflow_dispatch-only, so their signing steps never execute on a normal PR; these
 * assertions are the only automated check that the signing contract stays intact (correct
 * gating, non-interactive signing, a missing key degrading safely instead of stranding a
 * release, and signing kept out of the jobs that run dependency code).
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-publish.yml'), 'utf8')
const leg = readFileSync(resolve(repoRoot, '.github/workflows/release-build.yml'), 'utf8')

/** A top-level job's block in release-publish.yml, from its key to the next job key. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

// The single GPG step's body: from its `- name:` marker to the start of the next step.
const gpgStep = (() => {
  const start = workflow.indexOf('- name: GPG-sign the Linux artifacts and SHA256SUMS')
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
  it('defines one GPG signing step, in the checksums job', () => {
    expect(workflow.match(/gpg --batch --import/g)).toHaveLength(1)
    expect(job('checksums')).toContain('- name: GPG-sign the Linux artifacts and SHA256SUMS')
  })

  it('never runs on a dry run', () => {
    // dry_run publishes nothing, so there is nothing to sign or attach.
    expect(job('checksums')).toContain('if: ${{ !inputs.dry_run }}')
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

  it('signs each Linux artifact, as downloaded from the draft, and the manifest', () => {
    expect(gpgStep).toContain('for f in assets/*.AppImage assets/*.deb SHA256SUMS; do')
    expect(gpgStep).toContain('--detach-sign --output "$f.asc" "$f"')
    expect(gpgStep).toContain('gh release upload "$tag" "${sigs[@]}" houston-signing-key.asc')
  })

  it('publishes the public key so a downloader needs no keyserver', () => {
    expect(gpgStep).toContain('houston-signing-key.asc -R houston-code/houston --clobber')
  })
})

describe('release signing is kept away from dependency code', () => {
  it('never signs in a build leg, which runs npm ci and the build', () => {
    // A dependency's install script or build-time code runs in the leg; it must not be able to
    // mint the signing identity (OIDC) or read the GPG key. Comments may still explain why.
    const code = leg
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('id-token')
    expect(code).not.toContain('cosign')
    expect(code).not.toContain('GPG_PRIVATE_KEY')
    expect(code).not.toContain('GPG_PASSPHRASE')
  })

  it('signs only in the checksums job, which installs no dependencies', () => {
    const checksums = job('checksums')
    expect(checksums).toContain('id-token: write')
    expect(checksums).not.toMatch(/npm (ci|install)/)
    expect(checksums).not.toMatch(/install: (full|no-scripts|production)/)
    for (const name of ['draft', 'build-mac', 'build-other', 'finalize']) {
      expect(job(name)).not.toContain('id-token')
    }
  })

  it('cosign-signs every checksummed asset and the manifest', () => {
    const checksums = job('checksums')
    expect(checksums).toContain('cosign sign-blob --yes "assets/$name" --bundle "assets/$name.cosign.bundle"')
    expect(checksums).toContain('done < checksummed.txt')
    expect(checksums).toContain('cosign sign-blob --yes SHA256SUMS --bundle SHA256SUMS.cosign.bundle')
  })
})

describe('release build order', () => {
  it('creates the draft once, before any leg', () => {
    expect(job('draft')).toContain('node scripts/release-draft.mjs ensure houston-code/houston "$tag" "$GITHUB_SHA"')
    for (const name of ['build-mac', 'build-other']) {
      expect(job(name)).toContain('needs: [native-scan, sbom-conformance, approve, draft]')
      // A dry run skips `draft`; the legs must still run.
      expect(job(name)).toContain('if: ${{ !failure() && !cancelled() }}')
      expect(job(name)).toContain('uses: ./.github/workflows/release-build.yml')
    }
  })

  it('runs the macOS legs one at a time, arm64 first, so the Intel leg can merge its feed', () => {
    const mac = job('build-mac')
    expect(mac).toContain('max-parallel: 1')
    expect(mac.indexOf('os: macos-14')).toBeGreaterThan(-1)
    expect(mac.indexOf('os: macos-14')).toBeLessThan(mac.indexOf('os: macos-15-intel'))
    expect(mac).toMatch(/os: macos-15-intel\n(.*\n){3} {12}mac_x64_manual: true/)
  })

  it('builds Windows and Linux in parallel, outside the macOS ordering', () => {
    const other = job('build-other')
    expect(other).not.toContain('max-parallel')
    expect(other).toContain('os: windows-2025')
    expect(other).toContain('os: ubuntu-22.04')
  })

  it('never interpolates inputs straight into a leg script', () => {
    // Inputs reach run scripts through env, so an input can never become shell syntax.
    const runs = leg.split('\n').filter((l) => !l.trim().startsWith('#'))
    const script = runs.join('\n').match(/run: \|\n([\s\S]*?)(?=\n {6}- |\n {0,4}\S|$)/g) ?? []
    for (const block of script) expect(block).not.toContain('${{ inputs.')
  })
})

describe('release-publish SHA256SUMS manifest', () => {
  it('runs after every build leg and before finalize publishes', () => {
    expect(checksumsJob).toContain('needs: [build-mac, build-other]')
    expect(workflow).toContain('\n  finalize:\n    needs: [build-mac, build-other, checksums]\n')
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
    expect(checksumsJob).toContain('gh release upload "$tag" SHA256SUMS SHA256SUMS.cosign.bundle "${bundles[@]}"')
    expect(checksumsJob).toMatch(/if \[ -z "\$GPG_PRIVATE_KEY" \]/)
    expect(checksumsJob).toMatch(/GNUPGHOME="\$\(mktemp -d\)"/)
    expect(checksumsJob).toContain('--pinentry-mode loopback --passphrase "$GPG_PASSPHRASE"')
    expect(checksumsJob).toContain('for f in assets/*.AppImage assets/*.deb SHA256SUMS; do')
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

  it('pins the draft, checksums and finalize checkouts, and the build leg, to github.sha', () => {
    const pinned = workflow.match(/^\s*ref: \$\{\{ github\.sha \}\}\s*$/gm) ?? []
    expect(pinned).toHaveLength(3)
    expect(leg.match(/^\s*ref: \$\{\{ github\.sha \}\}\s*$/gm) ?? []).toHaveLength(1)
    expect(leg).not.toMatch(/^\s*ref:\s*main\s*$/m)
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

describe('release-publish SLSA provenance', () => {
  const checksumsJob = (() => {
    const start = workflow.indexOf('\n  checksums:\n')
    return workflow.slice(start, workflow.indexOf('\n  finalize:\n', start))
  })()
  // The build leg's commands only: comments may still describe provenance.
  const buildJob = leg
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

  it('attests the whole release once, from SHA256SUMS', () => {
    expect(checksumsJob).toContain('node scripts/slsa-provenance.mjs --subjects SHA256SUMS > provenance-statement.json')
    expect(checksumsJob).toContain('cosign attest-blob --yes --statement provenance-statement.json --bundle provenance.slsa.bundle')
    expect(checksumsJob).toContain('gh release upload "$tag" provenance.slsa.bundle')
  })

  it('verifies the bundle against a real download before uploading it', () => {
    const verify = checksumsJob.indexOf('cosign verify-blob-attestation "assets/$first" --bundle provenance.slsa.bundle')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(checksumsJob.indexOf('gh release upload "$tag" provenance.slsa.bundle'))
  })

  it('no longer writes a .slsa.bundle per file in the build legs', () => {
    expect(buildJob).not.toContain('cosign attest-blob')
    expect(buildJob).not.toContain('.slsa.bundle')
  })
})

describe('release legs verify before they upload', () => {
  /** Index of a step by its `- name:` (or, for unnamed steps, its run line) in the leg. */
  const at = (marker: string) => {
    const i = leg.indexOf(marker)
    expect(i, marker).toBeGreaterThan(-1)
    return i
  }

  it('never lets electron-builder publish', () => {
    // Its publisher uploads as it builds, before any check below has run.
    expect(leg).not.toContain('--publish always')
    expect(leg).toContain('run: npm run "$DIST" -- --publish never')
  })

  it('uploads installers only after the signature, e2e and binary vulnerability checks', () => {
    const upload = at("- name: Upload this leg's installers to the draft")
    for (const check of [
      '- name: Verify code signature + notarization',
      'run: npm run test:e2e',
      '- name: Generate deep binary SBOM (native/runtime layer)',
      '- name: Scan binary SBOM + apply native-layer policy'
    ]) {
      expect(at(check)).toBeLessThan(upload)
    }
    // And the single-draft check runs on what was just uploaded.
    expect(upload).toBeLessThan(at('- name: Check the release is still a single draft'))
  })

  it('uploads exactly one update feed per leg, last, merging the Intel feed into arm64', () => {
    const start = at("- name: Upload this leg's installers to the draft")
    const step = leg.slice(start, leg.indexOf('\n      - ', start + 1))
    expect(step).toContain('if: ${{ !inputs.dry_run }}')
    expect(step).toContain('node scripts/merge-mac-update-yml.mjs arm64-feed/latest-mac.yml release/latest-mac.yml')
    expect(step).toContain('feeds=(release/latest*.yml)')
    expect(step).toContain('if [ "${#feeds[@]}" -ne 1 ]; then')
    expect(step.indexOf('gh release upload "$tag" "${files[@]}"')).toBeLessThan(
      step.indexOf('gh release upload "$tag" "${feeds[@]}"')
    )
  })
})

describe('release legs receive the macOS signing secrets', () => {
  const MAC_SECRETS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

  it('declares each one on the reusable leg, which reads only declared secrets', () => {
    // Without the declarations the leg's `secrets` context was empty and the v0.8.0
    // arm64 leg failed on an empty CSC_LINK ("not a file").
    const declared = leg.slice(leg.indexOf('    secrets:\n'), leg.indexOf('\npermissions:'))
    for (const name of MAC_SECRETS) expect(declared).toMatch(new RegExp(`\\n {6}${name}:\\n {8}required: false`))
  })

  it('passes each one from the macOS caller by name, never `secrets: inherit`', () => {
    const mac = job('build-mac')
    for (const name of MAC_SECRETS) expect(mac).toContain(`${name}: \${{ secrets.${name} }}`)
    const code = workflow
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('secrets: inherit')
  })

  it('keeps the Apple credentials away from the Windows and Linux legs', () => {
    expect(job('build-other')).not.toMatch(/CSC_LINK|APPLE_ID/)
  })

  it('still reads them in the leg only on macOS', () => {
    expect(leg).toContain("CSC_LINK: ${{ startsWith(inputs.os, 'macos') && secrets.CSC_LINK || '' }}")
  })
})

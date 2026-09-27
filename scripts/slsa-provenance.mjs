#!/usr/bin/env node
// Emit SLSA v1.0 build provenance (https://slsa.dev/provenance/v1) describing HOW a release
// was built, from the GitHub Actions environment: the builder is this workflow, plus the
// source repo + commit it was built from. It complements the cosign signatures (integrity +
// signer identity) with structured build metadata.
//
// One statement covers the whole release: its subjects are every file in SHA256SUMS, so a
// release carries a single provenance.slsa.bundle instead of one .slsa.bundle per file.
// `cosign attest-blob --statement` signs it keyless via Fulcio + Rekor, and
// `cosign verify-blob-attestation` accepts any file whose SHA-256 is one of the subjects.
//
// Usage in CI:
//   node scripts/slsa-provenance.mjs --subjects SHA256SUMS > provenance-statement.json
//   node scripts/slsa-provenance.mjs                       > slsa-predicate.json   (predicate only)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Build the SLSA v1.0 provenance predicate from the GitHub Actions environment. */
export function buildPredicate(env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const repo = env.GITHUB_REPOSITORY || ''
  const ref = env.GITHUB_REF || ''
  const sha = env.GITHUB_SHA || ''
  const repoUrl = `${server}/${repo}`
  const workflowPath = '.github/workflows/release-publish.yml'
  return {
    buildDefinition: {
      buildType: `${repoUrl}/release-publish`,
      externalParameters: {
        workflow: { ref, repository: repoUrl, path: workflowPath }
      },
      internalParameters: {
        github: {
          event_name: env.GITHUB_EVENT_NAME || '',
          runner_environment: 'github-hosted'
        }
      },
      resolvedDependencies: [{ uri: `git+${repoUrl}@${ref}`, digest: { gitCommit: sha } }]
    },
    runDetails: {
      builder: { id: `${repoUrl}/${workflowPath}@${ref}` },
      metadata: {
        invocationId: `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID || ''}/attempts/${env.GITHUB_RUN_ATTEMPT || '1'}`
      }
    }
  }
}

/**
 * Parse `sha256sum` output ("<hex>  <name>", or " *<name>" in binary mode) into in-toto
 * subjects. Throws on a malformed line or a duplicate name, so a damaged manifest can't
 * yield provenance that silently covers the wrong set.
 */
export function subjectsFromSums(text) {
  const subjects = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (!m) throw new Error(`not a sha256sum line: ${JSON.stringify(line)}`)
    const [, sha256, name] = m
    if (seen.has(name)) throw new Error(`duplicate entry for ${name}`)
    seen.add(name)
    subjects.push({ name, digest: { sha256 } })
  }
  if (subjects.length === 0) throw new Error('no entries: provenance would cover nothing')
  return subjects
}

/** An in-toto v1 statement binding `subjects` to the SLSA provenance `predicate`. */
export function buildStatement(subjects, predicate) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: subjects,
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate,
  }
}

function main(argv) {
  const at = argv.indexOf('--subjects')
  const out =
    at === -1
      ? buildPredicate()
      : buildStatement(subjectsFromSums(readFileSync(argv[at + 1], 'utf8')), buildPredicate())
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

// Run only when invoked directly, so the test can import the helper cleanly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
}
